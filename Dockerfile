# Simulcast — single image for the FastAPI app.

FROM python:3.12-slim

# ffmpeg: RTMP → PCM extraction.
# tini: proper PID1 signal handling.

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        tini \
        curl \
        tar \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# MediaMTX — single-binary RTMP/SRT server for OBS ingest.
#
# v1.13.0 ships an H264 DTS-extractor bug that closes RTMP reader
# connections with "too many reordered frames" (bluenviron/mediamtx#4617,
# fixed by bluenviron/mediacommon#252 + #263). Keep in sync with the
# config validated in mediamtx.yml.

ARG MEDIAMTX_VERSION=v1.21.1

RUN curl -fsSL \
      "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/mediamtx.tar.gz \
    && tar -xzf /tmp/mediamtx.tar.gz -C /tmp mediamtx \
    && mv /tmp/mediamtx /mediamtx \
    && chmod +x /mediamtx \
    && rm -f /tmp/mediamtx.tar.gz

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY web/ web/

COPY sessions.example.yaml ./sessions.yaml
COPY mediamtx.yml /mediamtx.yml

ENV PYTHONUNBUFFERED=1 \
    SIMULCAST_SESSIONS_FILE=/app/sessions.yaml \
    SIMULCAST_HOST=0.0.0.0 \
    SIMULCAST_PORT=8000

EXPOSE 8000

# Default: run both MediaMTX (RTMP ingest) and the API in one container.
# via the entrypoint script.
# Override command for API-only deployments.

COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/docker-entrypoint.sh"]
