"""Simulcast FastAPI application entrypoint."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import router as api_router
from .broadcast import broadcaster
from .config import settings
from .ingest.rtmp_ingest import rtmp_ingest
from .ingest.websocket_ingest import handle_ingest_ws
from .session_manager import manager

logger = logging.getLogger("simulcast")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=settings.simulcast_log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    manager.load_from_file()
    # Start RTMP watcher and bind ffmpeg pipelines for configured sessions.
    await rtmp_ingest.start()
    eager = os.environ.get("SIMULCAST_EAGER_WORKERS", "0") == "1"
    for state in manager.list():
        rtmp_ingest.ensure(state.config.id)
        # Workers start lazily on first audio by default (saves Gemini quota
        # when a stage is configured but not on air). Set SIMULCAST_EAGER_WORKERS=1
        # to pre-connect for minimum time-to-first-caption.
        if eager and settings.gemini_api_key:
            await manager.ensure_workers(state.config.id)
    logger.info(
        "simulcast ready — sessions=%d gemini=%s",
        len(manager.list()),
        "configured" if settings.gemini_api_key else "MISSING",
    )
    yield
    await manager.shutdown()
    await rtmp_ingest.stop()


app = FastAPI(
    title="Simulcast",
    description="Open source simultaneous live captions for conferences.",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(api_router)


@app.websocket("/ws/captions/{session_id}")
async def ws_captions(websocket: WebSocket, session_id: str, lang: str = "all") -> None:
    """Live captions for the audience UI.

    Query params:
      lang: "original" | "es" | "en" | ... | "all"
      replay: "1" to send buffered final lines first (default 1)
    """
    state = manager.get(session_id)
    if state is None:
        await websocket.close(code=4404, reason="unknown session")
        return

    await websocket.accept()
    manager.note_viewer(session_id, +1)
    queue = await broadcaster.subscribe(session_id, lang)
    await websocket.send_json(
        {
            "type": "hello",
            "session": session_id,
            "lang": lang,
            "state": manager.snapshot(session_id),
        }
    )

    async def pump() -> None:
        while True:
            event = await queue.get()
            await websocket.send_json({"type": "caption", **event.model_dump()})

    pump_task = asyncio.create_task(pump())
    state_task = asyncio.create_task(_pump_state(websocket, session_id))
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            # Audience clients only need keepalives; ignore text payloads.
    except WebSocketDisconnect:
        pass
    finally:
        pump_task.cancel()
        state_task.cancel()
        await broadcaster.unsubscribe(session_id, lang, queue)
        manager.note_viewer(session_id, -1)


async def _pump_state(websocket: WebSocket, session_id: str) -> None:
    q = await broadcaster.subscribe_state(session_id)
    try:
        while True:
            payload = await q.get()
            await websocket.send_json(payload)
    except Exception:  # noqa: BLE001
        pass
    finally:
        await broadcaster.unsubscribe_state(session_id, q)


@app.websocket("/ws/ingest/{session_id}")
async def ws_ingest(websocket: WebSocket, session_id: str) -> None:
    await handle_ingest_ws(websocket, session_id)


@app.websocket("/ws/monitor")
async def ws_monitor(websocket: WebSocket) -> None:
    """Push session state changes + periodic monitor snapshots to the dashboard."""
    await websocket.accept()
    await websocket.send_json({"type": "snapshot", **manager.monitor_payload()})

    # Fan-in: one state queue per session + a heartbeat timer.
    queues = []
    for sid in [s.config.id for s in manager.list()]:
        try:
            q = await broadcaster.subscribe_state(sid)
            queues.append((sid, q))
        except Exception:  # noqa: BLE001
            pass

    async def pump_states() -> None:
        while True:
            for sid, q in list(queues):
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=0.05)
                    await websocket.send_json(payload)
                except TimeoutError:
                    continue
                except Exception:  # noqa: BLE001
                    queues.remove((sid, q))
                    try:
                        await broadcaster.unsubscribe_state(sid, q)
                    except Exception:  # noqa: BLE001
                        pass

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(3.0)
            await websocket.send_json({"type": "snapshot", **manager.monitor_payload()})

    pump = asyncio.create_task(pump_states())
    beat = asyncio.create_task(heartbeat())
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        beat.cancel()
        for sid, q in queues:
            try:
                await broadcaster.unsubscribe_state(sid, q)
            except Exception:  # noqa: BLE001
                pass


@app.get("/")
async def home() -> FileResponse:
    """Landing page: qué es Simulcast, cómo usarlo y referencia de la API."""
    return FileResponse(WEB_DIR / "home.html")


@app.get("/program")
async def program() -> FileResponse:
    """Public program grid + captions player (audiencia)."""
    return FileResponse(WEB_DIR / "program.html")


@app.get("/operator")
async def operator() -> FileResponse:
    return FileResponse(WEB_DIR / "operator.html")


@app.get("/monitor")
async def monitor_page() -> FileResponse:
    """Production monitoring dashboard (status, latency, errors, rates)."""
    return FileResponse(WEB_DIR / "monitor.html")


@app.get("/overlay")
async def overlay() -> FileResponse:
    """Transparent page for OBS/vMix Browser Source (burned-in captions).

    Configure via query string — see the comment block in ``web/overlay.html``
    for all supported parameters (session, lang/langs, pos, size, hold, ...).
    """
    return FileResponse(WEB_DIR / "overlay.html")


@app.get("/overlay/{session_id}")
async def overlay_session(session_id: str) -> FileResponse:
    """Same overlay, with the session id in the path (e.g. /overlay/main).

    The page reads the session from the path first and falls back to the
    ``?session=`` query param. Query params are identical to ``/overlay``.
    """
    return FileResponse(WEB_DIR / "overlay.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "server.main:app",
        host=settings.simulcast_host,
        port=settings.simulcast_port,
        log_level=settings.simulcast_log_level,
    )


if __name__ == "__main__":
    main()
