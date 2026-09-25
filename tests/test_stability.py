"""P0 stability tests: status derivation, idle-stop timers, latency probe,
audio-queue bounds and worker teardown (no Gemini network calls).
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from server import gemini_worker as gw
from server import session_manager as sm
from server.ingest.rtmp_ingest import rtmp_ingest
from server.main import app
from server.metrics import metrics
from server.models import (
    SessionConfig,
    SessionCreateRequest,
    SessionState,
    SessionStatus,
)
from server.session_manager import SessionManager, _derive_status

# Prevent spawning real ffmpeg RTMP processes during unit tests
rtmp_ingest.ensure = lambda session_id: None  # type: ignore[assignment]

# ----------------------------------------------------------- status derivation


def test_status_derivation_connected_states() -> None:
    now = 1000.0
    st = SessionState(config=SessionConfig(id="s1", name="S1"))

    # Connected, no audio ever received → starting
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.starting

    # Connected + fresh audio → live
    st.ingest.last_chunk_at = now - 1.0
    st.ingest.active = True
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.live

    # Connected + audio starved >10s + source active → degraded
    st.ingest.last_chunk_at = now - 15.0
    st.ingest.active = True
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.degraded

    # Connected + audio starved >10s + source inactive → reconnecting
    st.ingest.active = False
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.reconnecting

    # Connected + fresh audio + captions stale >60s → degraded
    st.ingest.last_chunk_at = now - 1.0
    st.ingest.active = True
    st.last_caption_at = now - 70.0
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.degraded

    # Captions fresh (20s) → live
    st.last_caption_at = now - 20.0
    assert _derive_status(st, any_connected=True, any_error=False, now=now) == SessionStatus.live


def test_status_derivation_disconnected_states() -> None:
    now = 1000.0
    st = SessionState(config=SessionConfig(id="s2", name="S2"))

    # Error present → reconnecting
    assert _derive_status(st, any_connected=False, any_error=True, now=now) == SessionStatus.reconnecting

    # Was live, now disconnected → reconnecting (not offline)
    st.status = SessionStatus.live
    assert _derive_status(st, any_connected=False, any_error=False, now=now) == SessionStatus.reconnecting

    # Stopped session remains stopped when disconnected
    st.status = SessionStatus.stopped
    assert _derive_status(st, any_connected=False, any_error=False, now=now) == SessionStatus.stopped

    # Idle session remains idle
    st.status = SessionStatus.idle
    assert _derive_status(st, any_connected=False, any_error=False, now=now) == SessionStatus.idle


# ------------------------------------------------------------ latency registry


def test_first_caption_latency_first_wins_and_negative_rejected() -> None:
    sid = "t-lat-probe-1"
    metrics.reset_first_caption_latency(sid)
    m = metrics.for_session(sid)
    assert m.first_caption_latency_s is None

    # First valid measurement recorded
    metrics.note_first_caption_latency(sid, 1.345)
    assert m.first_caption_latency_s == 1.345

    # Subsequent captions do not overwrite the first
    metrics.note_first_caption_latency(sid, 8.9)
    assert m.first_caption_latency_s == 1.345

    # Negative numbers rejected
    metrics.reset_first_caption_latency("t-lat-probe-2")
    metrics.note_first_caption_latency("t-lat-probe-2", -0.5)
    assert metrics.for_session("t-lat-probe-2").first_caption_latency_s is None


@pytest.mark.asyncio
async def test_on_audio_gap_rearms_latency_probe() -> None:
    m = SessionManager()
    state = await m.create(SessionCreateRequest(name="Gap Test"))
    sid = state.config.id

    class DummyWorker:
        def feed(self, chunk: bytes) -> None:
            pass

    m._workers[sid] = [DummyWorker()]  # type: ignore[list-item]

    # Pre-populate a measurement
    metrics.note_first_caption_latency(sid, 2.1)
    assert metrics.for_session(sid).first_caption_latency_s == 2.1

    # Audio gap > 2s → probe re-armed (reset to None)
    state.ingest.last_chunk_at = time.time() - 5.0
    m.on_audio(sid, b"pcm-chunk")
    assert metrics.for_session(sid).first_caption_latency_s is None

    # Small gap (0.5s) → probe NOT reset
    metrics.note_first_caption_latency(sid, 1.1)
    state.ingest.last_chunk_at = time.time() - 0.5
    m.on_audio(sid, b"pcm-chunk")
    assert metrics.for_session(sid).first_caption_latency_s == 1.1

    # Teardown
    m._workers.pop(sid, None)
    await m.remove(sid)


# ------------------------------------------------------------ idle RTMP timer


@pytest.mark.asyncio
async def test_idle_timer_arm_cancel_and_fire() -> None:
    m = SessionManager()
    state = await m.create(SessionCreateRequest(name="Idle Timer"))
    sid = state.config.id

    class SpyWorker:
        def __init__(self) -> None:
            self.stopped = False
            self.backlog_s = 0.0

        async def stop(self) -> None:
            self.stopped = True

    spy = SpyWorker()
    m._workers[sid] = [spy]  # type: ignore[list-item]

    # RTMP source disconnects → idle timer armed
    m.set_rtmp_ingest(sid, False)
    assert sid in m._idle_timers

    # RTMP source returns before timer fires → cancelled, workers kept
    m.set_rtmp_ingest(sid, True)
    assert sid not in m._idle_timers
    await asyncio.sleep(0.05)
    assert spy.stopped is False

    # Timer actually fires when idle_seconds passes
    m.set_rtmp_ingest(sid, False)
    m._arm_idle_stop(sid, idle_seconds=0.02)
    await asyncio.sleep(0.08)
    assert spy.stopped is True
    assert sid not in m._idle_timers

    await m.remove(sid)


# ------------------------------------------------------------- feed queue caps


def test_feed_bounds_connected_and_disconnected() -> None:
    w = gw.GeminiWorker(
        session_id="q-bounds",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    # Disconnected: caps at _KEEP_WHILE_DISCONNECTED (20)
    for i in range(40):
        w.feed(bytes([i % 256]) * 3200)
    assert w.audio_q.qsize() == gw._KEEP_WHILE_DISCONNECTED

    # Connected: caps at _AUDIO_Q_MAX (50) and drops oldest
    w2 = gw.GeminiWorker(
        session_id="q-bounds-2",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    w2.connected = True
    chunks = [bytes([i % 256]) * 3200 for i in range(80)]
    for chunk in chunks:
        w2.feed(chunk)
    assert w2.audio_q.qsize() == gw._AUDIO_Q_MAX
    # First chunk remaining is chunk #30 (0-indexed) after 80 feeds into cap 50
    first_remaining = w2.audio_q.get_nowait()
    assert first_remaining == chunks[30]

    # Stop set → feed ignored
    w2._stop.set()
    w2.feed(b"ignore-me")
    assert w2.audio_q.qsize() == gw._AUDIO_Q_MAX - 1


# --------------------------------------------- worker lifecycle & no task leak


class _FakeSession:
    def __init__(self, *, fail_after: float | None = None) -> None:
        self.fail_after = fail_after

    async def send_realtime_input(self, *, audio: Any) -> None:
        pass

    def receive(self) -> Any:
        async def gen() -> Any:
            sleep_s = self.fail_after if self.fail_after is not None else 3600.0
            await asyncio.sleep(sleep_s)
            raise RuntimeError("simulated live connection drop")
            yield None  # type: ignore[unreachable]

        return gen()


class _FakeCM:
    def __init__(self, session: _FakeSession) -> None:
        self._s = session

    async def __aenter__(self) -> _FakeSession:
        return self._s

    async def __aexit__(self, *args: Any) -> bool:
        return False


class _FakeClient:
    def __init__(self, *, fail_after: float | None = None, api_key: str = "") -> None:
        self.api_key = api_key
        self.fail_after = fail_after
        self.attempts: list[float] = []
        self.aio = SimpleNamespace(live=SimpleNamespace(connect=self._connect))

    def _connect(self, *, model: str, config: Any) -> _FakeCM:
        self.attempts.append(time.monotonic())
        return _FakeCM(_FakeSession(fail_after=self.fail_after))


@pytest.mark.asyncio
async def test_worker_stop_leaves_no_child_tasks(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeClient()
    monkeypatch.setattr(gw.genai, "Client", lambda api_key="": fake)

    w = gw.GeminiWorker(
        session_id="leak-test",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    baseline = {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}
    w.start()
    await asyncio.sleep(0.05)
    assert w.connected is True

    await w.stop()
    await asyncio.sleep(0)

    leftover = [
        t
        for t in asyncio.all_tasks()
        if t is not asyncio.current_task() and t not in baseline and not t.done()
    ]
    assert leftover == []
    assert w._task is None
    assert w.connected is False


@pytest.mark.asyncio
async def test_flapping_connection_backs_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gw, "_BASE_DELAY", 0.1)
    monkeypatch.setattr(gw, "_MAX_DELAY", 0.4)
    monkeypatch.setattr(gw, "_HEALTHY_SESSION_S", 10.0)

    fake = _FakeClient(fail_after=0.0)
    monkeypatch.setattr(gw.genai, "Client", lambda api_key="": fake)

    w = gw.GeminiWorker(
        session_id="backoff-test",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    w.start()
    await asyncio.sleep(0.85)
    await w.stop()

    assert len(fake.attempts) >= 3
    gaps = [b - a for a, b in zip(fake.attempts, fake.attempts[1:], strict=False)]
    # Gaps double: 0.1s, then 0.2s...
    assert gaps[1] > gaps[0] * 1.4


@pytest.mark.asyncio
async def test_healthy_session_resets_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gw, "_BASE_DELAY", 0.01)
    monkeypatch.setattr(gw, "_MAX_DELAY", 0.5)
    monkeypatch.setattr(gw, "_HEALTHY_SESSION_S", 0.05)

    fake = _FakeClient(fail_after=0.1)
    monkeypatch.setattr(gw.genai, "Client", lambda api_key="": fake)

    w = gw.GeminiWorker(
        session_id="healthy-test",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    w.start()
    await asyncio.sleep(1.3)
    await w.stop()

    assert len(fake.attempts) >= 5
    gaps = [b - a for a, b in zip(fake.attempts, fake.attempts[1:], strict=False)]
    # Healthy sessions reset delay to _BASE_DELAY → gaps stay small (~0.11s)
    assert max(gaps) < 0.35


# ------------------------------------------------ global metrics & API health


def test_global_snapshot_counts_reconnecting_as_degraded() -> None:
    sessions = [
        SimpleNamespace(status=SessionStatus.reconnecting),
        SimpleNamespace(status=SessionStatus.live),
        SimpleNamespace(status=SessionStatus.degraded),
        SimpleNamespace(status=SessionStatus.stopped),
    ]
    snap = metrics.global_snapshot(sessions)  # type: ignore[arg-type]
    assert snap["sessions_live"] == 1
    assert snap["sessions_degraded"] == 2  # reconnecting + degraded


def test_api_health_and_monitor_reconnecting_status() -> None:
    sid = "recon-api-test"
    with TestClient(app) as client:
        r = client.post("/api/sessions", json={"id": sid, "name": "Recon Test"})
        assert r.status_code == 201

        st = sm.manager.get(sid)
        assert st is not None
        st.status = SessionStatus.reconnecting

        health = client.get("/api/health").json()
        assert health["degraded_sessions"] >= 1

        mon = client.get("/api/monitor").json()
        me = next(s for s in mon["sessions"] if s["config"]["id"] == sid)
        assert me["status"] == "reconnecting"

        client.delete(f"/api/sessions/{sid}")
