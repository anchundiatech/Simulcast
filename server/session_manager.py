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
    WorkerState,
)

logger = logging.getLogger(__name__)


def _slugify(name: str) -> str:
    out = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.lower())
    return out.strip("-")[:64] or "session"


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._workers: dict[str, list[GeminiWorker]] = {}
        self._ingest_clients: dict[str, set[Any]] = {}
        self._lock = asyncio.Lock()
        self._auto_start_workers = True

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

        async def _emit(event: CaptionEvent) -> None:
            history.add(event)
            state.last_caption_at = event.t
            # Pipeline lag: caption timestamp vs latest ingest audio chunk.
            latency_ms: float | None = None
            if state.ingest.last_chunk_at:
                lag = (event.t - state.ingest.last_chunk_at) * 1000.0
                # Ignore nonsensical negative clocks; clamp to a sane display range.
                if 0 <= lag <= 30_000:
                    latency_ms = lag
            metrics.note_caption(session_id, final=event.final, t=event.t, latency_ms=latency_ms)
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

            if any_connected:
                state.status = SessionStatus.live
            elif any_error:
                state.status = SessionStatus.degraded
            elif state.status not in (SessionStatus.stopped, SessionStatus.idle):
                state.status = SessionStatus.starting
            self._refresh_metrics(state)
            self._publish_state(state)
            await asyncio.sleep(2.0)

    async def stop_workers(self, session_id: str) -> None:
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
            state.ingest.last_chunk_at = time.time()
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
        if active and self._auto_start_workers and not self._workers.get(session_id):
            asyncio.create_task(self.ensure_workers(session_id))
        if not active:
            asyncio.create_task(self._maybe_stop_idle(session_id))
        self._publish_state(state)

    async def _maybe_stop_idle(self, session_id: str, idle_seconds: float = 60.0) -> None:
        """Stop workers when an RTMP source has been gone for a while."""
        await asyncio.sleep(idle_seconds)
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
        state.metrics.uptime_s = round(now - state.started_at, 1) if state.started_at else None

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
