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
        # RTMP base for the OBS "Server" field (operator copy button).
        assert body["rtmp_base"].startswith("rtmp://")

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
        metrics_body = r.json()["metrics"]
        assert "backlog_s" in metrics_body
        assert "tracks" in metrics_body

        r = client.get("/api/sessions/test-stage/captions?lang=es")
        assert r.status_code == 200
        assert r.json() == {"captions": []}

        r = client.delete("/api/sessions/test-stage")
        assert r.status_code == 204

        r = client.get("/api/sessions/test-stage")
        assert r.status_code == 404


def test_landing_and_program_pages() -> None:
    with TestClient(app) as client:
        r = client.get("/")
        assert r.status_code == 200
        # Marketing landing: hero + product story.
        assert "Tu transmisión" in r.text
        assert "En todos los idiomas" in r.text
        assert "Iniciar transmisión" in r.text
        assert "Abrir Simulcast" in r.text
        assert 'href="/program"' in r.text
        # Required sections from the landing spec.
        for anchor in (
            'id="producto"',
            'id="como-funciona"',
            'id="caracteristicas"',
            'id="integraciones"',
            'id="open-source"',
            'id="empezar"',
        ):
            assert anchor in r.text, anchor
        assert "Una transmisión no debería tener un solo idioma" in r.text
        assert "Del audio a los subtítulos en tiempo real" in r.text
        assert "Un evento. Diez escenarios" in r.text
        assert "La audiencia solo tiene que elegir su idioma" in r.text
        assert "Controla todo desde un solo lugar" in r.text
        assert "Empieza en minutos" in r.text
        # Secondary technical section: API reference + auth roadmap note.
        assert 'id="api"' in r.text
        assert "Referencia de la API" in r.text
        assert "/api/sessions" in r.text
        assert "/ws/captions" in r.text
        assert "auth por sesión" in r.text
        assert "Apache-2.0" in r.text
        # Public picker/player lives at /program now.
        r = client.get("/program")
        assert r.status_code == 200
        assert "sessionGrid" in r.text
        assert "viewPicker" in r.text
        assert "viewPlayer" in r.text
        assert "Programa en vivo" in r.text
        assert "sessionSelect" in r.text
        # Bilingual captions UI: shared LiveCaption + session status.
        assert "statusIndicator" in r.text
        assert "currentCaption" in r.text
        assert "live-caption.js" in r.text
        r = client.get("/operator")
        assert r.status_code == 200
        assert "Compartir audio" in r.text
        # Multi-session share UI.
        assert "ingestSessions" in r.text
        assert "marcá varias" in r.text
        # OBS connection card: copy server URL + stream key.
        assert "rtmpServer" in r.text
        assert "streamKey" in r.text
        assert "copyRtmp" in r.text
        assert "copyKey" in r.text
        assert "clipboard.js" in r.text


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
    import time as _time

    from server.metrics import MetricsRegistry

    now = _time.time()
    reg = MetricsRegistry()
    reg.note_caption("s1", final=False, t=now - 2.0, latency_ms=120, lang="original")
    reg.note_caption("s1", final=True, t=now - 1.0, latency_ms=80, lang="es")
    snap = reg.for_session("s1").snapshot()
    assert snap["captions_total"] == 2
    assert snap["finals_total"] == 1
    assert snap["latency_ms"] is not None

    # Per-track freshness: distinguishes "translation behind" from "all stale".
    assert snap["tracks"]["original"]["captions_total"] == 1
    assert snap["tracks"]["es"]["finals_total"] == 1
    assert snap["tracks"]["es"]["last_caption_age_s"] == pytest.approx(1.0, abs=0.2)
    assert snap["tracks"]["original"]["last_caption_age_s"] == pytest.approx(2.0, abs=0.2)

    reg.note_error("s1", "worker", "boom")
    errs = reg.recent_errors(10)
    assert errs and errs[0]["message"] == "boom"
    assert errs[0]["session"] == "s1"


def test_worker_backlog_s() -> None:
    from server.gemini_worker import GeminiWorker

    w = GeminiWorker(
        session_id="s",
        mode="transcribe",
        target_lang="none",
        emit=lambda e: None,
    )
    assert w.backlog_s == 0.0
    # 100ms frame → backlog grows by 0.1s per queued chunk.
    for _ in range(3):
        w.feed(b"x" * settings.audio_chunk_bytes)
    assert w.backlog_s == pytest.approx(0.3)
    # latency_ms is the honest send-side proxy: backlog in ms.
    assert w.latency_ms is None  # only set when a caption is emitted


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
        # Path form: /overlay/<session-id> serves the same page.
        r = client.get("/overlay/stage-1")
        assert r.status_code == 200
        assert "overlayCaption" in r.text
        assert "Simulcast Overlay" in r.text
        # Shared caption logic is served as static assets.
        for asset in ("captions.js", "live-caption.js", "overlay.js"):
            r = client.get(f"/static/{asset}")
            assert r.status_code == 200, asset


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
