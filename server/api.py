"""REST API routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from .broadcast import history
from .config import settings
from .metrics import metrics
from .models import HealthResponse, SessionCreateRequest
from .session_manager import manager

router = APIRouter(prefix="/api")


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    sessions = manager.list()
    live = sum(1 for s in sessions if s.status.value == "live")
    degraded = sum(1 for s in sessions if s.status.value in ("degraded", "error"))
    g = metrics.global_snapshot(sessions)
    return HealthResponse(
        status="ok",
        sessions=len(sessions),
        live_sessions=live,
        degraded_sessions=degraded,
        max_sessions=settings.simulcast_max_sessions,
        gemini_configured=bool(settings.gemini_api_key),
        uptime_s=g["uptime_s"],
        captions_per_min=g["captions_per_min"],
        captions_total=g["captions_total"],
        errors_total=g["errors_total"],
        details={
            "translate_model": settings.gemini_model_translate,
            "transcribe_model": settings.gemini_model_transcribe,
        },
    )


@router.get("/monitor")
async def monitor() -> dict:
    """Production monitoring snapshot: sessions, metrics, recent errors."""
    return manager.monitor_payload()


@router.get("/monitor/errors")
async def monitor_errors(limit: int = 50) -> dict:
    return {"errors": metrics.recent_errors(max(1, min(limit, 200)))}


@router.get("/sessions")
async def list_sessions() -> dict:
    return {"sessions": [s.model_dump() for s in manager.list()]}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    snap = manager.snapshot(session_id)
    if snap is None:
        raise HTTPException(404, "session not found")
    return snap


@router.post("/sessions", status_code=201)
async def create_session(req: SessionCreateRequest) -> dict:
    try:
        state = await manager.create(req)
    except RuntimeError as exc:
        raise HTTPException(429, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, str(exc)) from exc
    return state.model_dump()


@router.put("/sessions/{session_id}")
async def update_session(session_id: str, req: SessionCreateRequest) -> dict:
    try:
        state = await manager.update(session_id, req)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, str(exc)) from exc
    return state.model_dump()


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> None:
    ok = await manager.remove(session_id)
    if not ok:
        raise HTTPException(404, "session not found")


@router.get("/sessions/{session_id}/captions")
async def get_captions(session_id: str, lang: str = "all", since: int = 0) -> dict:
    if manager.get(session_id) is None:
        raise HTTPException(404, "session not found")
    langs = [lang] if lang != "all" else None
    lines = []
    if langs:
        for lang_name in langs:
            lines.extend(history.get(session_id, lang_name, since))
    else:
        # All languages, keep insertion order roughly by time.
        for key_lang in ("original", "es", "en", "pt"):
            lines.extend(history.get(session_id, key_lang, 0))
        lines.sort(key=lambda e: e.t)
    return {"captions": [e.model_dump() for e in lines]}


@router.get("/sessions/{session_id}/export.{fmt}")
async def export(session_id: str, fmt: str, lang: str = "original") -> PlainTextResponse:
    if fmt not in ("srt", "vtt", "txt"):
        raise HTTPException(400, "fmt must be srt, vtt or txt")
    if manager.get(session_id) is None:
        raise HTTPException(404, "session not found")
    lines = [e for e in history.get(session_id, lang) if e.final]
    if not lines:
        body = "WEBVTT\n\n" if fmt == "vtt" else ""
        return PlainTextResponse(body, media_type=f"{_media_type(fmt)}; charset=utf-8")
    t0 = lines[0].t
    if fmt == "txt":
        body = "\n".join(e.text for e in lines) + "\n"
        return PlainTextResponse(body, media_type="text/plain; charset=utf-8")
    if fmt == "vtt":
        parts = ["WEBVTT", ""]
        for i, e in enumerate(lines):
            start = e.t - t0
            end = (lines[i + 1].t - t0) if i + 1 < len(lines) else start + 3.0
            parts.append(f"{_srt_time(start)} --> {_srt_time(end)}")
            parts.append(e.text)
            parts.append("")
        return PlainTextResponse("\n".join(parts), media_type="text/vtt; charset=utf-8")
    parts = []
    for i, e in enumerate(lines):
        start = e.t - t0
        end = (lines[i + 1].t - t0) if i + 1 < len(lines) else start + 3.0
        parts.append(str(i + 1))
        parts.append(f"{_srt_time(start)} --> {_srt_time(end)}")
        parts.append(e.text)
        parts.append("")
    return PlainTextResponse("\n".join(parts), media_type="application/x-subrip; charset=utf-8")


def _media_type(fmt: str) -> str:
    if fmt == "vtt":
        return "text/vtt"
    if fmt == "srt":
        return "application/x-subrip"
    return "text/plain"


def _srt_time(t: float) -> str:
    ms = int(round((t % 1) * 1000))
    s = int(t) % 60
    m = (int(t) // 60) % 60
    h = int(t) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _vtt_time(t: float) -> str:
    return _srt_time(t).replace(",", ".")
