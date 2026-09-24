"""In-process metrics for the production monitoring panel."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ErrorEntry:
    t: float
    session: str
    source: str  # worker | ingest | system
    message: str


@dataclass
class SessionMetrics:
    caption_times: deque[float] = field(default_factory=lambda: deque(maxlen=2000))
    final_times: deque[float] = field(default_factory=lambda: deque(maxlen=2000))
    captions_total: int = 0
    finals_total: int = 0
    errors_total: int = 0
    # EMA of caption→publish path (ms); updated on each caption.
    latency_ema_ms: float | None = None
    last_latency_ms: float | None = None
    # Rolling rate window (seconds)
    rate_window_s: float = 60.0

    def note_caption(
        self, *, final: bool, t: float | None = None, latency_ms: float | None = None
    ) -> None:
        now = t if t is not None else time.time()
        self.caption_times.append(now)
        self.captions_total += 1
        if final:
            self.final_times.append(now)
            self.finals_total += 1
        if latency_ms is not None and latency_ms >= 0:
            self.last_latency_ms = latency_ms
            if self.latency_ema_ms is None:
                self.latency_ema_ms = latency_ms
            else:
                self.latency_ema_ms = 0.3 * latency_ms + 0.7 * self.latency_ema_ms

    def rate(self, window_s: float | None = None) -> float:
        w = window_s or self.rate_window_s
        cutoff = time.time() - w
        n = sum(1 for t in self.caption_times if t >= cutoff)
        return round(n / w * 60.0, 2)  # events per minute

    def final_rate(self, window_s: float | None = None) -> float:
        w = window_s or self.rate_window_s
        cutoff = time.time() - w
        n = sum(1 for t in self.final_times if t >= cutoff)
        return round(n / w * 60.0, 2)

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        last = self.caption_times[-1] if self.caption_times else None
        return {
            "captions_total": self.captions_total,
            "finals_total": self.finals_total,
            "captions_per_min": self.rate(),
            "finals_per_min": self.final_rate(),
            "last_caption_age_s": round(now - last, 3) if last else None,
            "latency_ms": round(self.latency_ema_ms, 1)
            if self.latency_ema_ms is not None
            else None,
            "last_latency_ms": round(self.last_latency_ms, 1)
            if self.last_latency_ms is not None
            else None,
            "errors_total": self.errors_total,
        }


class MetricsRegistry:
    def __init__(self, max_errors: int = 200) -> None:
        self._sessions: dict[str, SessionMetrics] = defaultdict(SessionMetrics)
        self._errors: deque[ErrorEntry] = deque(maxlen=max_errors)
        self.started_at = time.time()

    def for_session(self, session_id: str) -> SessionMetrics:
        return self._sessions[session_id]

    def note_caption(
        self,
        session_id: str,
        *,
        final: bool,
        t: float | None = None,
        latency_ms: float | None = None,
    ) -> None:
        self.for_session(session_id).note_caption(final=final, t=t, latency_ms=latency_ms)

    def note_error(self, session_id: str, source: str, message: str) -> None:
        m = self.for_session(session_id)
        m.errors_total += 1
        self._errors.append(
            ErrorEntry(t=time.time(), session=session_id, source=source, message=message)
        )

    def recent_errors(self, limit: int = 50) -> list[dict[str, Any]]:
        items = list(self._errors)[-limit:]
        items.reverse()
        return [
            {"t": e.t, "session": e.session, "source": e.source, "message": e.message}
            for e in items
        ]

    def global_snapshot(self, sessions: list[Any]) -> dict[str, Any]:
        now = time.time()
        live = sum(1 for s in sessions if getattr(s, "status", None) and s.status.value == "live")
        degraded = sum(
            1
            for s in sessions
            if getattr(s, "status", None) and s.status.value in ("degraded", "error")
        )
        total_captions = sum(m.captions_total for m in self._sessions.values())
        total_errors = sum(m.errors_total for m in self._sessions.values())
        rates = [m.rate() for m in self._sessions.values()]
        return {
            "uptime_s": round(now - self.started_at, 1),
            "sessions_total": len(sessions),
            "sessions_live": live,
            "sessions_degraded": degraded,
            "captions_total": total_captions,
            "errors_total": total_errors,
            "captions_per_min": round(sum(rates), 2),
            "recent_errors": self.recent_errors(30),
        }


metrics = MetricsRegistry()
