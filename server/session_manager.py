"""Session lifecycle: configs, audio fan-out, workers, health."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

import yaml

from .broadcast import broadcaster, history
from .config import settings
from .gemini_worker import GeminiWorker
from .metrics import metrics
from .models import (
    CaptionEvent,
    IngestState,
    SessionConfig,
    SessionCreateRequest,
    SessionState,
    SessionStatus,
    TrackMetricsModel,
    WorkerState,
)

logger = logging.getLogger(__name__)

# Status thresholds (seconds).
#   audio starved while a source is reported active   → degraded
#   audio starved while the source is reported gone   → reconnecting
#   captions stale (only counted if we ever had one)  → degraded
_INGEST_SILENT_DEGRADED_S = 10.0
_CAPTION_SILENT_DEGRADED_S = 60.0
# An audio gap longer than this re-arms the first-caption latency probe.
_LATENCY_GAP_RESET_S = 2.0
# Idle RTMP source before workers are stopped.
_RTMP_IDLE_STOP_S = 60.0


def _slugify(name: str) -> str:
    out = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.lower())
    return out.strip("-")[:64] or "session"


def _derive_status(
    state: SessionState, *, any_connected: bool, any_error: bool, now: float
) -> SessionStatus:
    """Map worker/audio/caption signals to a session status.

    Spec (LIVE / DEGRADED / RECONNECTING / OFFLINE):
      live         — connected, audio flowing, captions fresh
      degraded     — connected but audio or captions starved while the
                     source claims to be there
      reconnecting — Gemini in backoff, or the audio source is gone and
                     we are waiting for it to come back
      starting     — workers up but no audio received yet
    """
    audio_age = now - state.ingest.last_chunk_at if state.ingest.last_chunk_at else None
    caption_age = now - state.last_caption_at if state.last_caption_at else None
    captions_stale = caption_age is not None and caption_age > _CAPTION_SILENT_DEGRADED_S

    if any_connected:
        if audio_age is None:
            return SessionStatus.starting
        if audio_age > _INGEST_SILENT_DEGRADED_S:
            # Audio starved: distinguish "source gone, waiting" (reconnecting)
            # from "source claims to be there but silent" (degraded).
            return (
                SessionStatus.reconnecting
                if not state.ingest.active
                else SessionStatus.degraded
            )
        if captions_stale:
            return SessionStatus.degraded
        return SessionStatus.live
    if any_error or state.status in (
        SessionStatus.live,
        SessionStatus.degraded,
        SessionStatus.reconnecting,
    ):
        # Lost the connection (or dropped from live): we are trying to come
        # back, not offline — keep OFFLINE for genuinely finished sessions.
        return SessionStatus.reconnecting
    if state.status not in (SessionStatus.stopped, SessionStatus.idle):
        return SessionStatus.starting
    return state.status


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._workers: dict[str, list[GeminiWorker]] = {}
        self._ingest_clients: dict[str, set[Any]] = {}
        self._lock = asyncio.Lock()
        self._auto_start_workers = True
        # One cancellable idle-stop timer per session (RTMP gone → stop).
        self._idle_timers: dict[str, asyncio.Task[None]] = {}

    # ------------------------------------------------------------------ config

    def load_from_file(self, path: Path | None = None) -> None:
        path = path or settings.sessions_path
        if not path.exists():
            logger.info("no sessions file at %s (starting empty)", path)
            return
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for raw in data.get("sessions") or []:
            cfg = SessionConfig.model_validate(raw)
            self._sessions[cfg.id] = SessionState(config=cfg)
        logger.info("loaded %d sessions from %s", len(self._sessions), path)

    def list(self) -> list[SessionState]:
        return list(self._sessions.values())

    def get(self, session_id: str) -> SessionState | None:
        return self._sessions.get(session_id)

    # ------------------------------------------------------------------ CRUD

    async def create(self, req: SessionCreateRequest) -> SessionState:
        async with self._lock:
            sid = req.id or _slugify(req.name)
            if sid in self._sessions:
                # Update in place.
                cfg = self._sessions[sid].config.model_copy(
                    update={
                        "name": req.name,
                        "source_language": req.source_language,
                        "output_languages": req.output_languages,
                    }
                )
                self._sessions[sid].config = cfg
            else:
                if len(self._sessions) >= settings.simulcast_max_sessions:
                    raise RuntimeError(f"max sessions reached ({settings.simulcast_max_sessions})")
                cfg = SessionConfig(
                    id=sid,
                    name=req.name,
                    source_language=req.source_language,
                    output_languages=req.output_languages,
                )
                self._sessions[sid] = SessionState(config=cfg)
            state = self._sessions[sid]
        self._publish_state(state)
        # Bind RTMP path if the ingest module is loaded (runtime-created sessions).
        try:
            from .ingest.rtmp_ingest import rtmp_ingest

            rtmp_ingest.ensure(sid)
        except Exception:  # noqa: BLE001
            pass
        # Workers start on first audio (lazy) unless eager mode is enabled.
        if (
            self._auto_start_workers
            and settings.gemini_api_key
            and (os.environ.get("SIMULCAST_EAGER_WORKERS", "0") == "1")
        ):
            await self.ensure_workers(sid)
        return state

    async def upsert_config(self, cfg: SessionConfig) -> SessionState:
        async with self._lock:
            self._sessions[cfg.id] = SessionState(
                config=cfg,
                status=SessionStatus.idle,
            )
        state = self._sessions[cfg.id]
        self._publish_state(state)
        return state

    async def update(self, session_id: str, req: SessionCreateRequest) -> SessionState:
        cfg = SessionConfig(
            id=session_id,
            name=req.name,
            source_language=req.source_language,
            output_languages=req.output_languages,
        )
        await self.stop_workers(session_id)
        state = await self.upsert_config(cfg)
        # Restart workers only if audio is already flowing (or eager mode).
        if self.ingest_active(session_id) or (
            os.environ.get("SIMULCAST_EAGER_WORKERS", "0") == "1"
        ):
            await self.ensure_workers(session_id)
        return state

    async def remove(self, session_id: str) -> bool:
        await self.stop_session(session_id)
        async with self._lock:
            existed = self._sessions.pop(session_id, None) is not None
        history.clear(session_id)
        return existed

    # ------------------------------------------------------------------ workers

    def _tracks_for(self, cfg: SessionConfig) -> list[tuple[str, str, str]]:
        """Return list of (mode, target_lang, track_label)."""
        translations = [lang for lang in cfg.output_languages if lang != "original"]
        if not translations:
            return [("transcribe", cfg.source_language, "original")]
        # One connection: translate to the first requested language.
        # input → original, output → translations[0]
        return [("translate", translations[0], translations[0])]

    async def ensure_workers(self, session_id: str) -> None:
        state = self._sessions.get(session_id)
        if not state:
            return
        if settings.gemini_model_translate and not settings.gemini_api_key:
            logger.error("GEMINI_API_KEY not configured; workers will not start")
            state.status = SessionStatus.error
            self._publish_state(state)
            return

        existing = self._workers.get(session_id) or []
        if existing:
            return

        workers: list[GeminiWorker] = []

        # Arm the end-to-end latency probe: first caption emitted by this
        # worker generation minus the first audio available to it. The
        # probe re-arms whenever audio resumes after a gap (see on_audio).
        metrics.reset_first_caption_latency(session_id)
        audio_start_t = state.ingest.last_chunk_at or time.time()

        async def _emit(event: CaptionEvent) -> None:
            history.add(event)
            state.last_caption_at = event.t
            metrics.note_first_caption_latency(session_id, event.t - audio_start_t)
            # Honest latency proxy: audio seconds queued across workers at
            # caption time (send-side lag; per-track freshness covers the
            # Gemini-side signal in metrics.tracks).
            latency_ms = sum(w.backlog_s for w in workers) * 1000.0
            metrics.note_caption(
                session_id,
                final=event.final,
                t=event.t,
                latency_ms=latency_ms,
                lang=event.lang,
            )
            if event.final:
                self._refresh_metrics(state)
                self._publish_state(state)
            broadcaster.publish(event)

        for mode, target, track in self._tracks_for(state.config):
            w = GeminiWorker(
                session_id=session_id,
                mode=mode,
                target_lang=target if mode == "translate" else "none",
                source_language=state.config.source_language,
                emit=_emit,
            )
            workers.append(w)
            # Translate connections also produce the "original" track.
            tracks = [track] if mode == "transcribe" else ["original", track]
            for t in dict.fromkeys(tracks):
                state.workers[t] = WorkerState(track=t, mode=mode, connected=False)

        self._workers[session_id] = workers
        for w in workers:
            w.start()
        state.status = SessionStatus.starting
        state.started_at = time.time()
        self._publish_state(state)
        logger.info("started %d worker(s) for session %s", len(workers), session_id)

        # Reflect connection status shortly after start.
        asyncio.create_task(self._watch_workers(session_id))

    async def _watch_workers(self, session_id: str) -> None:
        state = self._sessions.get(session_id)
        if not state:
            return
        tick = 0
        while True:
            workers = self._workers.get(session_id) or []
            if not workers:
                break
            any_connected = False
            any_error = False
            for w in workers:
                logical_tracks = (
                    ["original"] if w.mode == "transcribe" else ["original", w.target_lang]
                )
                for t in dict.fromkeys(logical_tracks):
                    ws = state.workers.get(t)
                    if not ws:
                        continue
                    prev_err = ws.last_error
                    ws.connected = w.connected
                    ws.reconnects = w.reconnects
                    ws.last_error = w.last_error
                    ws.last_event_at = w.last_event_at
                    ws.latency_ms = w.latency_ms
                    ws.audio_queue = w.audio_q.qsize()
                    ws.backlog_s = round(w.backlog_s, 3)
                    if w.connected and not ws.connected_at:
                        ws.connected_at = time.time()
                    elif not w.connected:
                        ws.connected_at = None
                    if w.last_error and w.last_error != prev_err:
                        metrics.note_error(session_id, "worker", w.last_error)
                if w.connected:
                    any_connected = True
                if w.last_error and not w.connected:
                    any_error = True

            # Status rules — see _derive_status (pure, unit-tested).
            state.status = _derive_status(
                state, any_connected=any_connected, any_error=any_error, now=time.time()
            )
            self._refresh_metrics(state)
            self._publish_state(state)

            # Baseline probe: one line every ~14s while workers run, so we can
            # measure real pipeline latency before choosing reset thresholds.
            tick += 1
            if tick % 7 == 0:
                self._log_baseline(session_id, state, workers)
            await asyncio.sleep(2.0)

    def _log_baseline(
        self, session_id: str, state: SessionState, workers: list[GeminiWorker]
    ) -> None:
        now = time.time()
        audio_age = (
            round(now - state.ingest.last_chunk_at, 2)
            if state.ingest.last_chunk_at
            else None
        )
        caption_ages = {
            lang: round(now - seen, 2)
            for lang, seen in metrics.for_session(session_id).last_caption_by_lang.items()
        }
        for w in workers:
            logger.info(
                "baseline session=%s track=%s mode=%s connected=%s reconnects=%d "
                "backlog_s=%.2f audio_age_s=%s caption_age_s=%s",
                session_id,
                w.target_lang,
                w.mode,
                w.connected,
                w.reconnects,
                w.backlog_s,
                audio_age,
                caption_ages,
            )

    async def stop_workers(self, session_id: str) -> None:
        self._cancel_idle_stop(session_id)
        workers = self._workers.pop(session_id, [])
        for w in workers:
            await w.stop()
        state = self._sessions.get(session_id)
        if state:
            for _track, ws in state.workers.items():
                ws.connected = False
            if state.status != SessionStatus.stopped:
                state.status = SessionStatus.stopped
            self._publish_state(state)

    async def stop_session(self, session_id: str) -> None:
        await self.stop_workers(session_id)

    # ------------------------------------------------------------------ audio

    def attach_ingest(self, session_id: str, client: Any) -> None:
        self._ingest_clients.setdefault(session_id, set()).add(client)
        state = self._sessions.get(session_id)
        if state:
            state.ingest = IngestState(
                kind="websocket",
                active=True,
                last_chunk_at=time.time(),
                clients=len(self._ingest_clients.get(session_id, ())),
            )
            self._publish_state(state)

    def detach_ingest(self, session_id: str, client: Any) -> None:
        clients = self._ingest_clients.get(session_id)
        if clients:
            clients.discard(client)
        state = self._sessions.get(session_id)
        if state:
            state.ingest.clients = len(self._ingest_clients.get(session_id, ()))
            if state.ingest.clients == 0 and state.ingest.kind == "websocket":
                state.ingest.active = False
            self._publish_state(state)

    def ingest_active(self, session_id: str) -> bool:
        state = self._sessions.get(session_id)
        if not state:
            return False
        if state.ingest.kind == "rtmp":
            return state.ingest.active
        return bool(self._ingest_clients.get(session_id))

    def on_audio(self, session_id: str, chunk: bytes) -> None:
        state = self._sessions.get(session_id)
        if state:
            now = time.time()
            prev = state.ingest.last_chunk_at
            if (
                prev is not None
                and now - prev > _LATENCY_GAP_RESET_S
                and self._workers.get(session_id)
            ):
                # Audio resumed after a gap → re-arm the latency probe so
                # first_caption_latency_s stays current, not start-of-show.
                metrics.reset_first_caption_latency(session_id)
            state.ingest.last_chunk_at = now
            if state.ingest.kind != "rtmp":
                state.ingest.active = True
                state.ingest.kind = "websocket"
                state.ingest.clients = len(self._ingest_clients.get(session_id, ()))
            # Auto-start workers on first audio if configured.
            if self._auto_start_workers and not self._workers.get(session_id):
                asyncio.create_task(self.ensure_workers(session_id))
        for w in self._workers.get(session_id) or []:
            w.feed(chunk)

    def set_rtmp_ingest(self, session_id: str, active: bool) -> None:
        state = self._sessions.get(session_id)
        if not state:
            return
        state.ingest = IngestState(
            kind="rtmp",
            active=active,
            last_chunk_at=time.time() if active else state.ingest.last_chunk_at,
            clients=state.ingest.clients,
        )
        if active:
            self._cancel_idle_stop(session_id)
            if self._auto_start_workers and not self._workers.get(session_id):
                asyncio.create_task(self.ensure_workers(session_id))
        else:
            self._arm_idle_stop(session_id)
        self._publish_state(state)

    # ------------------------------------------------------------------ idle stop

    def _arm_idle_stop(self, session_id: str, idle_seconds: float = _RTMP_IDLE_STOP_S) -> None:
        """Stop workers when the RTMP source has been gone for a while.

        A single cancellable timer per session: a source that comes back
        cancels it, and a new outage re-arms it from the latest disconnect
        (a stale fire-and-forget sleep could otherwise stop workers seconds
        into a fresh cycle).
        """
        self._cancel_idle_stop(session_id)
        self._idle_timers[session_id] = asyncio.create_task(
            self._maybe_stop_idle(session_id, idle_seconds),
            name=f"idle-stop-{session_id}",
        )

    def _cancel_idle_stop(self, session_id: str) -> None:
        task = self._idle_timers.pop(session_id, None)
        if task and not task.done():
            task.cancel()

    async def _maybe_stop_idle(self, session_id: str, idle_seconds: float = 60.0) -> None:
        """Stop workers when an RTMP source has been gone for a while."""
        try:
            await asyncio.sleep(idle_seconds)
        except asyncio.CancelledError:
            return
        finally:
            # Whether it fired or was cancelled, this handle is spent.
            if self._idle_timers.get(session_id) is asyncio.current_task():
                self._idle_timers.pop(session_id, None)
        state = self._sessions.get(session_id)
        if not state or state.ingest.active:
            return
        if state.ingest.kind == "rtmp" and not state.ingest.active:
            await self.stop_workers(session_id)
            logger.info("stopped idle workers for %s", session_id)

    def note_viewer(self, session_id: str, delta: int) -> None:
        state = self._sessions.get(session_id)
        if not state:
            return
        state.viewers = max(0, state.viewers + delta)
        state.captions_buffer_size = broadcaster.subscriber_count(session_id)
        self._publish_state(state)

    def _refresh_metrics(self, state: SessionState) -> None:
        """Copy rolling metrics onto SessionState for API/WS consumers."""
        m = metrics.for_session(state.config.id)
        snap = m.snapshot()
        now = time.time()
        audio_age = (
            round(now - state.ingest.last_chunk_at, 3) if state.ingest.last_chunk_at else None
        )
        state.metrics.captions_total = snap["captions_total"]
        state.metrics.finals_total = snap["finals_total"]
        state.metrics.captions_per_min = snap["captions_per_min"]
        state.metrics.finals_per_min = snap["finals_per_min"]
        state.metrics.last_caption_age_s = snap["last_caption_age_s"]
        state.metrics.latency_ms = snap["latency_ms"]
        state.metrics.last_latency_ms = snap["last_latency_ms"]
        state.metrics.errors_total = snap["errors_total"]
        state.metrics.audio_age_s = audio_age
        state.metrics.first_caption_latency_s = snap.get("first_caption_latency_s")
        state.metrics.uptime_s = round(now - state.started_at, 1) if state.started_at else None
        # Send-side backlog: seconds of audio queued across live workers.
        backlog = sum(w.backlog_s for w in self._workers.get(state.config.id) or [])
        state.metrics.backlog_s = round(backlog, 3)
        state.metrics.tracks = {
            lang: TrackMetricsModel(**track) for lang, track in snap.get("tracks", {}).items()
        }

    def _publish_state(self, state: SessionState) -> None:
        self._refresh_metrics(state)
        broadcaster.publish_state(
            state.config.id,
            {"type": "state", "session": state.config.id, "state": state.model_dump()},
        )

    # ------------------------------------------------------------------ snapshots

    def snapshot(self, session_id: str) -> dict[str, Any] | None:
        state = self._sessions.get(session_id)
        if not state:
            return None
        state.captions_buffer_size = broadcaster.subscriber_count(session_id)
        self._refresh_metrics(state)
        return state.model_dump()

    def snapshots(self) -> list[dict[str, Any]]:
        out = []
        for sid in self._sessions:
            snap = self.snapshot(sid)
            if snap:
                out.append(snap)
        return out

    def monitor_payload(self) -> dict[str, Any]:
        """Full snapshot for the production monitoring panel."""
        sessions = self.list()
        for s in sessions:
            self._refresh_metrics(s)
        return {
            **metrics.global_snapshot(sessions),
            "gemini_configured": bool(settings.gemini_api_key),
            "max_sessions": settings.simulcast_max_sessions,
            "translate_model": settings.gemini_model_translate,
            "transcribe_model": settings.gemini_model_transcribe,
            "sessions": [s.model_dump() for s in sessions],
        }

    async def shutdown(self) -> None:
        for sid in list(self._workers.keys()):
            await self.stop_workers(sid)


manager = SessionManager()
