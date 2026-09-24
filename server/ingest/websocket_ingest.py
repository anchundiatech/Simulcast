"""Browser audio ingest over WebSocket (binary PCM 16-bit mono 16 kHz)."""

from __future__ import annotations

import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

from ..session_manager import manager

logger = logging.getLogger(__name__)


async def handle_ingest_ws(websocket: WebSocket, session_id: str) -> None:
    """Accept raw PCM frames from the operator page.

    Protocol:
      - client sends binary frames (PCM s16le mono 16kHz)
      - client may send text JSON {"type":"ping"} (ignored except pong reply)
      - server sends {"type":"ready"} on accept and {"type":"pong"} on ping
    """
    state = manager.get(session_id)
    if state is None:
        await websocket.close(code=4404, reason="unknown session")
        return

    await websocket.accept()
    manager.attach_ingest(session_id, websocket)
    await websocket.send_json({"type": "ready", "session": session_id})
    logger.info("ingest ws open session=%s", session_id)

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                manager.on_audio(session_id, data)
                continue
            text = message.get("text")
            if text:
                # Lightweight keepalive; ignore payload content.
                await websocket.send_json({"type": "pong", "t": time.time()})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("ingest ws error session=%s: %s", session_id, exc)
    finally:
        manager.detach_ingest(session_id, websocket)
        logger.info("ingest ws closed session=%s", session_id)
