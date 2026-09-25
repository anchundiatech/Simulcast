"""Pydantic models shared across the app."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class SessionStatus(StrEnum):
    idle = "idle"
    starting = "starting"
    live = "live"
    degraded = "degraded"
    # Workers lost the connection (Gemini backoff) or the audio source is
    # gone and we are waiting for it to come back.
    reconnecting = "reconnecting"
    error = "error"
    stopped = "stopped"


class SessionConfig(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    name: str
    source_language: str = "auto"
    output_languages: list[str] = Field(default_factory=lambda: ["original", "es"])

    @field_validator("output_languages")
    @classmethod
    def _non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("output_languages must not be empty")
        if "original" not in v:
            v = ["original", *v]
        return v


class CaptionEvent(BaseModel):
    """A single caption line broadcast to the audience."""

    session: str
    lang: str  # "original" or BCP-47-ish code such as "es", "en"
    text: str
    final: bool = False
    t: float  # server time (unix seconds, float)
    id: str = ""  # stable id for the UI to de-dupe/replace


class IngestState(BaseModel):
    """Health of the audio source feeding a session."""

    kind: str = "none"  # none | websocket | rtmp
    active: bool = False
    last_chunk_at: float | None = None
    clients: int = 0


class WorkerState(BaseModel):
    track: str  # e.g. "original", "es"
    mode: str  # transcribe | translate
    connected: bool = False
    reconnects: int = 0
    last_error: str | None = None
    last_event_at: float | None = None
    latency_ms: float | None = None
    connected_at: float | None = None
    audio_queue: int = 0
    backlog_s: float | None = None


class TrackMetricsModel(BaseModel):
    """Per-track (lang) caption freshness for the monitor."""

    last_caption_age_s: float | None = None
    captions_total: int = 0
    finals_total: int = 0


class SessionMetricsModel(BaseModel):
    captions_total: int = 0
    finals_total: int = 0
    captions_per_min: float = 0.0
    finals_per_min: float = 0.0
    last_caption_age_s: float | None = None
    latency_ms: float | None = None
    last_latency_ms: float | None = None
    errors_total: int = 0
    audio_age_s: float | None = None
    uptime_s: float | None = None
    # Seconds of received audio queued across workers but not yet sent.
    backlog_s: float | None = None
    # Measured time from the first audio received after (re)start until
    # the first caption was emitted. True end-to-end pipeline latency —
    # re-measured whenever audio resumes after a gap.
    first_caption_latency_s: float | None = None
    # Caption freshness per track: {"original": {...}, "es": {...}}.
    tracks: dict[str, TrackMetricsModel] = Field(default_factory=dict)


class SessionState(BaseModel):
    config: SessionConfig
    status: SessionStatus = SessionStatus.idle
    ingest: IngestState = Field(default_factory=IngestState)
    workers: dict[str, WorkerState] = Field(default_factory=dict)
    viewers: int = 0
    captions_buffer_size: int = 0
    started_at: float | None = None
    last_caption_at: float | None = None
    metrics: SessionMetricsModel = Field(default_factory=SessionMetricsModel)


class SessionCreateRequest(BaseModel):
    id: str | None = None
    name: str
    source_language: str = "auto"
    output_languages: list[str] = Field(default_factory=lambda: ["original", "es"])


class HealthResponse(BaseModel):
    status: str
    sessions: int
    live_sessions: int
    degraded_sessions: int
    max_sessions: int
    gemini_configured: bool
    version: str = "0.1.0"
    uptime_s: float = 0.0
    captions_per_min: float = 0.0
    captions_total: int = 0
    errors_total: int = 0
    details: dict[str, Any] = Field(default_factory=dict)
