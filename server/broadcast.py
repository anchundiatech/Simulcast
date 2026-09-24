"""In-memory pub/sub for caption events and session state changes."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Any

from .models import CaptionEvent

logger = logging.getLogger(__name__)


class CaptionBroadcaster:
    """Fan-out of CaptionEvents to websocket subscribers.

    Subscribers are keyed by (session_id, lang). lang "all" receives every
    language for that session.
    """

    def __init__(self) -> None:
        self._subs: dict[tuple[str, str], set[asyncio.Queue[CaptionEvent]]] = defaultdict(set)
        self._state_subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, session_id: str, lang: str) -> asyncio.Queue[CaptionEvent]:
        q: asyncio.Queue[CaptionEvent] = asyncio.Queue(maxsize=512)
        async with self._lock:
            self._subs[(session_id, lang)].add(q)
        return q

    async def unsubscribe(self, session_id: str, lang: str, q: asyncio.Queue[CaptionEvent]) -> None:
        async with self._lock:
            self._subs[(session_id, lang)].discard(q)
            if not self._subs[(session_id, lang)]:
                self._subs.pop((session_id, lang), None)

    async def subscribe_state(self, session_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        async with self._lock:
            self._state_subs[session_id].add(q)
        return q

    async def unsubscribe_state(self, session_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._state_subs[session_id].discard(q)
            if not self._state_subs[session_id]:
                self._state_subs.pop(session_id, None)

    def publish(self, event: CaptionEvent) -> None:
        targets: set[asyncio.Queue[CaptionEvent]] = set()
        targets |= self._subs.get((event.session, event.lang), set())
        targets |= self._subs.get((event.session, "all"), set())
        for q in targets:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop oldest to keep latency low for live viewers.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass

    def publish_state(self, session_id: str, payload: dict[str, Any]) -> None:
        for q in self._state_subs.get(session_id, set()):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass
        # Also a global channel via session_id="*"
        for q in self._state_subs.get("*", set()):
            try:
                q.put_nowait({**payload, "session": session_id})
            except asyncio.QueueFull:
                pass

    def subscriber_count(self, session_id: str) -> int:
        total = 0
        for (sid, _lang), qs in self._subs.items():
            if sid == session_id:
                total += len(qs)
        return total


class CaptionHistory:
    """Rolling buffer of final captions per session+lang (for export/debug)."""

    def __init__(self, max_lines: int = 5000) -> None:
        self.max_lines = max_lines
        self._lines: dict[tuple[str, str], list[CaptionEvent]] = defaultdict(list)
        self._ids: dict[str, CaptionEvent] = {}

    def add(self, event: CaptionEvent) -> None:
        key = (event.session, event.lang)
        bucket = self._lines[key]
        # Replace interim lines with the same id until finalized.
        if event.id and event.id in self._ids:
            old = self._ids[event.id]
            try:
                bucket.remove(old)
            except ValueError:
                pass
        bucket.append(event)
        if event.id:
            self._ids[event.id] = event
        if len(bucket) > self.max_lines:
            removed = bucket.pop(0)
            if removed.id:
                self._ids.pop(removed.id, None)

    def get(self, session_id: str, lang: str, since: int = 0) -> list[CaptionEvent]:
        lines = self._lines.get((session_id, lang), [])
        if not since:
            return list(lines)
        return [e for i, e in enumerate(lines) if i >= since]

    def clear(self, session_id: str) -> None:
        for key in [k for k in self._lines if k[0] == session_id]:
            for e in self._lines.pop(key, []):
                if e.id:
                    self._ids.pop(e.id, None)


broadcaster = CaptionBroadcaster()
history = CaptionHistory()


def now() -> float:
    return time.time()
