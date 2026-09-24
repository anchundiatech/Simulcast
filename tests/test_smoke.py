"""Smoke tests for Simulcast core (no Gemini network calls)."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from server.api import _srt_time
from server.broadcast import CaptionHistory, broadcaster
from server.config import settings
from server.main import app
from server.models import CaptionEvent, SessionConfig, SessionCreateRequest
from server.session_manager import SessionManager, _slugify


def test_session_config_requires_original() -> None:
    cfg = SessionConfig(id="stage-1", name="Main", output_languages=["es"])
    assert cfg.output_languages[0] == "original"
    assert "es" in cfg.output_languages


def test_slugify() -> None:
    assert _slugify("Main Stage!") == "main-stage"
    assert _slugify("  ") == "session"


def test_history_replace_interim_with_final() -> None:
    h = CaptionHistory()
    e1 = CaptionEvent(session="s", lang="es", text="hola", final=False, t=1.0, id="x")
    e2 = CaptionEvent(session="s", lang="es", text="hola mundo", final=True, t=2.0, id="x")
    h.add(e1)
    h.add(e2)
    lines = h.get("s", "es")
    assert len(lines) == 1
    assert lines[0].final is True
    assert lines[0].text == "hola mundo"


def test_time_formats() -> None:
    assert _srt_time(3661.5) == "01:01:01,500"
    assert _srt_time(0.0) == "00:00:00,000"
    assert _srt_time(59.999) == "00:00:59,999"


def test_tracks_for_translate_and_transcribe() -> None:
    m = SessionManager()
    cfg_t = SessionConfig(
        id="a", name="A", source_language="en", output_languages=["original", "es"]
    )
    assert m._tracks_for(cfg_t) == [("translate", "es", "es")]

    cfg_o = SessionConfig(id="b", name="B", source_language="auto", output_languages=["original"])
    assert m._tracks_for(cfg_o) == [("transcribe", "auto", "original")]


def test_health_and_sessions_api() -> None:
    with TestClient(app) as client:
        r = client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["gemini_configured"] in (True, False)

        r = client.post(
            "/api/sessions",
            json={
                "id": "test-stage",
                "name": "Test Stage",
                "source_language": "en",
                "output_languages": ["original", "es"],
            },
        )
        # 201 on create; workers may fail later if no API key — that's fine.
        assert r.status_code == 201, r.text
        assert r.json()["config"]["id"] == "test-stage"

        r = client.get("/api/sessions")
        assert r.status_code == 200
        ids = [s["config"]["id"] for s in r.json()["sessions"]]
        assert "test-stage" in ids

        r = client.get("/api/sessions/test-stage")
        assert r.status_code == 200

        r = client.get("/api/sessions/test-stage/captions?lang=es")
        assert r.status_code == 200
        assert r.json() == {"captions": []}

        r = client.delete("/api/sessions/test-stage")
        assert r.status_code == 204

        r = client.get("/api/sessions/test-stage")
        assert r.status_code == 404


def test_index_and_operator_pages() -> None:
    with TestClient(app) as client:
        r = client.get("/")
        assert r.status_code == 200
        assert "Simulcast" in r.text
        # Public picker: session/cast grid + player views.
        assert "sessionGrid" in r.text
        assert "viewPicker" in r.text
        assert "viewPlayer" in r.text
        assert "Programa en vivo" in r.text
        assert "sessionSelect" in r.text
        r = client.get("/operator")
        assert r.status_code == 200
        assert "Compartir audio" in r.text
        # Multi-session share UI.
        assert "ingestSessions" in r.text
        assert "marcá varias" in r.text


def test_monitor_page_and_api() -> None:
    with TestClient(app) as client:
        r = client.get("/monitor")
        assert r.status_code == 200
        assert "Monitoreo" in r.text or "monitoreo" in r.text

        r = client.get("/api/monitor")
        assert r.status_code == 200
        body = r.json()
        assert "sessions" in body
        assert "recent_errors" in body
        assert "uptime_s" in body
        assert "captions_per_min" in body
        assert isinstance(body["sessions"], list)

        r = client.get("/api/monitor/errors")
        assert r.status_code == 200
        assert "errors" in r.json()

        r = client.get("/api/health")
        assert r.status_code == 200
        h = r.json()
        assert "degraded_sessions" in h
        assert "uptime_s" in h
        assert "captions_per_min" in h


def test_metrics_rate_and_errors() -> None:
    from server.metrics import MetricsRegistry

    reg = MetricsRegistry()
    reg.note_caption("s1", final=False, t=1.0, latency_ms=120)
    reg.note_caption("s1", final=True, t=1.1, latency_ms=80)
    snap = reg.for_session("s1").snapshot()
    assert snap["captions_total"] == 2
    assert snap["finals_total"] == 1
    assert snap["latency_ms"] is not None

    reg.note_error("s1", "worker", "boom")
    errs = reg.recent_errors(10)
    assert errs and errs[0]["message"] == "boom"
    assert errs[0]["session"] == "s1"


def test_overlay_page() -> None:
    with TestClient(app) as client:
        r = client.get("/overlay")
        assert r.status_code == 200
        assert "Simulcast Overlay" in r.text
        assert "transparent" in r.text
        assert "WebSocket" in r.text
        # Query params are client-side; page still serves for any query.
        r = client.get("/overlay?session=stage-1&langs=original,es&pos=top&size=48")
        assert r.status_code == 200
        assert "langs" in r.text


def test_export_endpoints_empty() -> None:
    with TestClient(app) as client:
        client.post(
            "/api/sessions",
            json={"id": "exp", "name": "Exp", "output_languages": ["original", "es"]},
        )
        for fmt in ("srt", "vtt", "txt"):
            r = client.get(f"/api/sessions/exp/export.{fmt}?lang=original")
            assert r.status_code == 200, fmt
        client.delete("/api/sessions/exp")


@pytest.mark.asyncio
async def test_broadcaster_pub_sub() -> None:
    q = await broadcaster.subscribe("s1", "es")
    ev = CaptionEvent(session="s1", lang="es", text="hi", final=True, t=1.0, id="1")
    broadcaster.publish(ev)
    got = await asyncio.wait_for(q.get(), timeout=1)
    assert got.text == "hi"
    await broadcaster.unsubscribe("s1", "es", q)

    q_all = await broadcaster.subscribe("s1", "all")
    broadcaster.publish(ev)
    got2 = await asyncio.wait_for(q_all.get(), timeout=1)
    assert got2.session == "s1"
    await broadcaster.unsubscribe("s1", "all", q_all)


def test_settings_chunk_size() -> None:
    # 100ms @ 16kHz s16le mono = 3200 bytes
    assert settings.audio_chunk_bytes == 3200


def test_session_create_request_defaults() -> None:
    req = SessionCreateRequest(name="Foo Bar")
    assert req.output_languages == ["original", "es"]
