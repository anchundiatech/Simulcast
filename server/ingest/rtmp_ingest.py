"""RTMP ingest: pull audio from MediaMTX with ffmpeg and feed workers.

For each session we expect an RTMP publish at:
    rtmp://mediamtx:1935/{session_id}

ffmpeg converts to PCM s16le mono 16 kHz on stdout; we slice 100 ms frames.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time

from ..config import settings
from ..session_manager import manager

logger = logging.getLogger(__name__)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


class RtmpIngest:
    """Spawns one ffmpeg child per active RTMP path."""

    def __init__(self, rtmp_base: str = "rtmp://localhost:1935") -> None:
        self.rtmp_base = rtmp_base.rstrip("/")
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._desired: set[str] = set()
        self._stopping = False
        self._restart_counts: dict[str, int] = {}

    async def start(self) -> None:
        self._stopping = False
        logger.info("rtmp ingest watching base=%s", self.rtmp_base)

    async def stop(self) -> None:
        self._stopping = True
        for sid in list(self._procs):
            await self._stop_one(sid)
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()

    def ensure(self, session_id: str) -> None:
        """Make sure an ffmpeg pipeline exists for this session."""
        self._desired.add(session_id)
        if session_id in self._procs and self._procs[session_id].returncode is None:
            return
        self._tasks[session_id] = asyncio.create_task(
            self._run_one(session_id), name=f"rtmp-{session_id}"
        )

    def release(self, session_id: str) -> None:
        self._desired.discard(session_id)
        task = self._tasks.get(session_id)
        if task:
            task.cancel()

    async def _stop_one(self, session_id: str) -> None:
        proc = self._procs.pop(session_id, None)
        task = self._tasks.pop(session_id, None)
        if task:
            task.cancel()
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=3)
            except (TimeoutError, ProcessLookupError):
                proc.kill()

    async def _run_one(self, session_id: str) -> None:
        chunk = settings.audio_chunk_bytes
        url = f"{self.rtmp_base}/{session_id}"
        cmd = [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostdin",
            "-rw_timeout",
            "15000000",  # 15s network I/O timeout (microseconds)
            "-i",
            url,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(settings.audio_sample_rate),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ]
        logger.info("rtmp spawn session=%s url=%s", session_id, url)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            logger.error("ffmpeg not found; RTMP ingest disabled")
            manager.set_rtmp_ingest(session_id, False)
            return

        self._procs[session_id] = proc
        assert proc.stdout is not None
        was_active = False
        buf = b""
        last_data = time.time()
        stderr_task = asyncio.create_task(self._drain_stderr(session_id, proc))
        try:
            while True:
                try:
                    data = await asyncio.wait_for(proc.stdout.read(4096), timeout=1.0)
                except TimeoutError:
                    # No data for 1s → consider the source inactive.
                    if was_active and time.time() - last_data > 1.5:
                        was_active = False
                        manager.set_rtmp_ingest(session_id, False)
                        logger.info("rtmp idle session=%s", session_id)
                    if proc.returncode is not None:
                        break
                    continue
                if not data:
                    break
                if not was_active:
                    was_active = True
                    self._restart_counts[session_id] = 0
                    manager.set_rtmp_ingest(session_id, True)
                    logger.info("rtmp active session=%s", session_id)
                last_data = time.time()
                buf += data
                while len(buf) >= chunk:
                    frame, buf = buf[:chunk], buf[chunk:]
                    manager.on_audio(session_id, frame)
            if was_active:
                manager.set_rtmp_ingest(session_id, False)
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.kill()
            raise
        finally:
            stderr_task.cancel()
            self._procs.pop(session_id, None)
            if session_id in self._desired and not self._stopping:
                # Restart with backoff if we still want this stream.
                delay = min(2.0 * (self._restart_counts.get(session_id, 0) + 1), 15.0)
                self._restart_counts[session_id] = self._restart_counts.get(session_id, 0) + 1
                await asyncio.sleep(delay)
                if session_id in self._desired and not self._stopping:
                    self._tasks[session_id] = asyncio.create_task(self._run_one(session_id))
            logger.info("rtmp loop exit session=%s rc=%s", session_id, proc.returncode)

    def _stop_event_set(self) -> bool:
        return self._stopping

    async def _drain_stderr(self, session_id: str, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode(errors="replace").strip()
            if text:
                logger.debug("ffmpeg[%s]: %s", session_id, text)


rtmp_ingest = RtmpIngest(rtmp_base=settings.simulcast_rtmp_base)
