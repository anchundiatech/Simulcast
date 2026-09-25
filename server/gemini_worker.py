"""Gemini Live API worker: streams PCM audio and emits caption events.

Modes
-----
translate : ``gemini-3.5-live-translate-preview``
    One connection yields the original transcript (``input_transcription``)
    and the translated transcript (``output_transcription``).
transcribe : ``gemini-3.5-transcribe-live``
    One connection yields only the original transcript, with language
    auto-detection and optional custom vocabulary (glossary).

Long talks are supported via context-window compression + session resumption
(handles stored across reconnects), as recommended by the Live API docs.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from google import genai
from google.genai import errors, types

from .config import settings
from .models import CaptionEvent

logger = logging.getLogger(__name__)

EmitFn = Callable[[CaptionEvent], Awaitable[None] | None]

# Reconnect policy
_BASE_DELAY = 1.0
_MAX_DELAY = 30.0
# A connection that survived this long is considered healthy and resets
# the backoff; flapping connections keep doubling the delay instead of
# retrying every second forever.
_HEALTHY_SESSION_S = 30.0
# Audio buffering bounds (100 ms chunks):
#   50  (5 s)  — hard cap while connected (send-loop stall headroom).
#   20  (2 s)  — kept while disconnected: replaying a long backlog after a
#                reconnect would deliver stale speech on top of the new one.
_AUDIO_Q_MAX = 50
_KEEP_WHILE_DISCONNECTED = 20
# Watchdog: send queue near-full this long while connected ⇒ the send
# loop is stalled (Gemini not consuming); force a reconnect.
_BACKLOG_STUCK_S = 4.0
_BACKLOG_STUCK_FOR_S = 6.0


class GeminiWorker:
    """Owns one Live API connection for (session, track)."""

    def __init__(
        self,
        *,
        session_id: str,
        mode: str,
        target_lang: str,
        source_language: str = "auto",
        emit: EmitFn,
        custom_vocabulary: list[str] | None = None,
    ) -> None:
        if mode not in ("translate", "transcribe"):
            raise ValueError(f"unsupported mode: {mode}")
        self.session_id = session_id
        self.mode = mode
        self.target_lang = target_lang  # "es" for translate; unused for transcribe
        self.source_language = source_language
        self.emit = emit
        self.custom_vocabulary = custom_vocabulary or []

        self.audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_AUDIO_Q_MAX)
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._session_handle: str | None = None
        self.connected = False
        self.reconnects = 0
        self.last_error: str | None = None
        self.last_event_at: float | None = None
        self.latency_ms: float | None = None
        self._line_seq = 0
        self._current_line_id: str | None = None
        self._interim_text: dict[str, str] = {}

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(
            self._run(), name=f"gemini-{self.session_id}-{self.target_lang}"
        )

    async def stop(self) -> None:
        self._stop.set()
        # Unblock the sender.
        try:
            self.audio_q.put_nowait(b"")
        except asyncio.QueueFull:
            pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        self.connected = False

    @property
    def backlog_s(self) -> float:
        """Seconds of received audio still waiting to be sent to Gemini.

        Send-side lag: grows when the send loop is blocked/stalled or audio
        accumulated during a disconnect (reconnect replay risk). Complementary
        to per-track caption freshness, which catches Gemini-side lag.
        """
        return self.audio_q.qsize() * settings.audio_chunk_ms / 1000.0

    def feed(self, chunk: bytes) -> None:
        """Non-blocking audio ingest from RTMP/websocket sources."""
        if self._stop.is_set() or not chunk:
            return
        if not self.connected:
            # While disconnected keep only recent audio: on reconnect we
            # replay the tail for continuity, never a long stale backlog.
            while self.audio_q.qsize() >= _KEEP_WHILE_DISCONNECTED:
                try:
                    self.audio_q.get_nowait()
                except asyncio.QueueEmpty:
                    break
        try:
            self.audio_q.put_nowait(chunk)
        except asyncio.QueueFull:
            # Prefer freshness: drop one stale chunk then enqueue.
            try:
                self.audio_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.audio_q.put_nowait(chunk)
            except asyncio.QueueFull:
                pass

    # ------------------------------------------------------------------ connection

    def _model(self) -> str:
        return (
            settings.gemini_model_translate
            if self.mode == "translate"
            else settings.gemini_model_transcribe
        )

    def _build_config(self) -> types.LiveConnectConfig | dict[str, Any]:
        compression = types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow(),
        )
        resumption = types.SessionResumptionConfig(handle=self._session_handle)

        if self.mode == "translate":
            return types.LiveConnectConfig(
                response_modalities=["AUDIO"],
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                translation_config=types.TranslationConfig(
                    target_language_code=self.target_lang,
                    echo_target_language=True,
                ),
                context_window_compression=compression,
                session_resumption=resumption,
            )

        lang_codes: list[str] = []
        if self.source_language and self.source_language != "auto":
            lang_codes = [self.source_language]
        transcription = types.AudioTranscriptionConfig(
            language_codes=lang_codes,
            mode="SMART",
            custom_vocabulary=self.custom_vocabulary or None,
        )
        return types.LiveConnectConfig(
            response_modalities=["TEXT"],
            input_audio_transcription=transcription,
            context_window_compression=compression,
            session_resumption=resumption,
        )

    async def _run(self) -> None:
        client = genai.Client(api_key=settings.gemini_api_key)
        delay = _BASE_DELAY
        while not self._stop.is_set():
            conn_started = 0.0
            try:
                async with client.aio.live.connect(
                    model=self._model(), config=self._build_config()
                ) as session:
                    conn_started = time.time()
                    self.connected = True
                    self.last_error = None
                    logger.info(
                        "worker connected session=%s mode=%s track=%s",
                        self.session_id,
                        self.mode,
                        self.target_lang,
                    )
                    send_task = asyncio.create_task(self._send_loop(session))
                    recv_task = asyncio.create_task(self._recv_loop(session))
                    stop_task = asyncio.create_task(self._stop.wait())
                    watchdog_task = asyncio.create_task(self._backlog_watchdog())
                    tasks = (send_task, recv_task, stop_task, watchdog_task)
                    try:
                        done, _pending = await asyncio.wait(
                            tasks,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        # Never leak child tasks: also runs when stop()
                        # cancels this coroutine while it is waiting here.
                        for t in tasks:
                            t.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                    # Surface the first exception (if any) for logging.
                    for t in done:
                        if t is stop_task or t.cancelled():
                            continue
                        exc = t.exception()
                        if exc:
                            raise exc
                    if self._stop.is_set():
                        break
                    # recv/send finished on their own → reconnect below.
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{type(exc).__name__}: {exc}"
                self.reconnects += 1
                logger.warning(
                    "worker error session=%s track=%s reconnects=%d err=%s",
                    self.session_id,
                    self.target_lang,
                    self.reconnects,
                    self.last_error,
                )
                try:
                    from .metrics import metrics

                    metrics.note_error(self.session_id, "worker", self.last_error)
                except Exception:  # noqa: BLE001
                    pass
            finally:
                self.connected = False
                # A session that lasted ≥ _HEALTHY_SESSION_S is healthy:
                # reset the backoff even if it later ended with an error.
                if conn_started and time.time() - conn_started >= _HEALTHY_SESSION_S:
                    delay = _BASE_DELAY

            if self._stop.is_set():
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, _MAX_DELAY)

        logger.info("worker stopped session=%s track=%s", self.session_id, self.target_lang)

    async def _backlog_watchdog(self) -> None:
        """Force a reconnect when the send loop stalls with a full queue."""
        stuck_since: float | None = None
        while True:
            await asyncio.sleep(2.0)
            if self.backlog_s >= _BACKLOG_STUCK_S:
                now = time.time()
                if stuck_since is None:
                    stuck_since = now
                elif now - stuck_since >= _BACKLOG_STUCK_FOR_S:
                    raise RuntimeError(
                        f"send loop stalled: {self.backlog_s:.1f}s of audio "
                        f"queued for {now - stuck_since:.0f}s"
                    )
            else:
                stuck_since = None

    async def _send_loop(self, session: Any) -> None:
        chunk_size = settings.audio_chunk_bytes
        buf = b""
        while not self._stop.is_set():
            try:
                item = await asyncio.wait_for(self.audio_q.get(), timeout=1.0)
            except TimeoutError:
                continue
            if item == b"" and self._stop.is_set():
                break
            buf += item
            # Emit exact 100ms frames to keep the API happy.
            while len(buf) >= chunk_size:
                frame, buf = buf[:chunk_size], buf[chunk_size:]
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=frame,
                        mime_type=f"audio/pcm;rate={settings.audio_sample_rate}",
                    )
                )
        # Flush remainder as a final partial frame (API resamples fine).
        if buf and not self._stop.is_set():
            try:
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=buf,
                        mime_type=f"audio/pcm;rate={settings.audio_sample_rate}",
                    )
                )
            except Exception:  # noqa: BLE001
                pass

    async def _recv_loop(self, session: Any) -> None:
        try:
            async for response in session.receive():
                if self._stop.is_set():
                    break

                # Session resumption handle (survives reconnects).
                update = getattr(response, "session_resumption_update", None)
                if update is not None and getattr(update, "resumable", False):
                    handle = getattr(update, "new_handle", None)
                    if handle:
                        self._session_handle = handle

                go_away = getattr(response, "go_away", None)
                if go_away is not None:
                    logger.info(
                        "go_away session=%s track=%s time_left=%s",
                        self.session_id,
                        self.target_lang,
                        getattr(go_away, "time_left", None),
                    )

                content = getattr(response, "server_content", None) or getattr(
                    response, "serverContent", None
                )

                if content is None:
                    # Some SDK versions expose top-level text.
                    text = getattr(response, "text", None)
                    if text:
                        await self._emit_final("original", text)
                    continue

                interim = getattr(
                    content, "interim_input_transcription", None
                ) or getattr(content, "interimInputTranscription", None)

                if interim is not None and getattr(interim, "text", None):
                    await self._emit_interim("original", interim.text)

                final_in = getattr(
                    content, "input_transcription", None
                ) or getattr(content, "inputTranscription", None)

                if final_in is not None and getattr(final_in, "text", None):
                    await self._emit_final("original", final_in.text)

                if self.mode == "translate":
                    final_out = getattr(
                        content, "output_transcription", None
                    ) or getattr(content, "outputTranscription", None)

                    if final_out is not None and getattr(final_out, "text", None):
                        await self._emit_final(
                            self.target_lang,
                            final_out.text,
                        )

                    # Mirror interim input onto the target track is NOT done:
                    # translation finalizes as a whole utterance.
        except errors.APIError as exc:
            if getattr(exc, "code", None) == 1000:
                logger.info(
                    "gemini normal close session=%s track=%s",
                    self.session_id,
                    self.target_lang,
                )
                return
            raise

    # ------------------------------------------------------------------ emit helpers

    def _next_line_id(self) -> str:
        self._line_seq += 1
        return f"{self.session_id}:{self.target_lang}:{self._line_seq}:{uuid.uuid4().hex[:6]}"

    async def _emit_interim(self, lang: str, text: str) -> None:
        if not text:
            return
        line_id = self._current_line_id or self._next_line_id()
        self._current_line_id = line_id
        self._interim_text[line_id] = text
        await self._emit(lang, text, final=False, line_id=line_id)

    async def _emit_final(self, lang: str, text: str) -> None:
        if not text:
            return
        # Original finalization closes the open line; translation final is a
        # sibling of the same utterance when mode=translate.
        if lang == "original":
            line_id = self._current_line_id or self._next_line_id()
            self._current_line_id = None
            self._interim_text.pop(line_id, None)
        else:
            line_id = self._next_line_id()
        await self._emit(lang, text, final=True, line_id=line_id)

    async def _emit(self, lang: str, text: str, *, final: bool, line_id: str) -> None:
        now = time.time()
        self.last_event_at = now
        # Honest proxy: ms of audio queued but not yet delivered to Gemini.
        # True audio→caption latency is not directly measurable without content
        # alignment; send-side backlog (this) + per-track caption freshness
        # (metrics) are the observable signals for "falling behind".
        self.latency_ms = self.backlog_s * 1000.0
        event = CaptionEvent(
            session=self.session_id,
            lang=lang,
            text=text,
            final=final,
            t=now,
            id=line_id,
        )
        result = self.emit(event)
        if asyncio.iscoroutine(result):
            await result
