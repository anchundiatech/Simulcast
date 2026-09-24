"""Application settings loaded from environment / .env."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    gemini_api_key: str = ""
    simulcast_host: str = "0.0.0.0"
    simulcast_port: int = 8000
    simulcast_sessions_file: str = "sessions.yaml"
    simulcast_log_level: str = "info"
    simulcast_max_sessions: int = 20

    gemini_model_translate: str = "gemini-3.5-live-translate-preview"
    gemini_model_transcribe: str = "gemini-3.5-transcribe-live"

    # Audio pipeline
    audio_sample_rate: int = 16000
    audio_chunk_ms: int = 100

    @property
    def audio_chunk_bytes(self) -> int:
        # 16-bit mono
        return int(self.audio_sample_rate * (self.audio_chunk_ms / 1000) * 2)

    @property
    def sessions_path(self) -> Path:
        return Path(self.simulcast_sessions_file)


settings = Settings()
