# Simulcast

**Subtítulos simultáneos open source a escala para conferencias.**

Simulcast toma audio en vivo de un escenario (RTMP desde OBS o audio del navegador) y produce subtítulos en tiempo real:

- **Transcripción** en el idioma original
- **Traducción** al español (y opción inglés / portugués)

Diseñado para eventos como [Nerdearla](https://nerdearla.com) con **decenas de sesiones en paralelo**, bajo licencia **Apache-2.0** (aprobada por la Open Source Initiative).

```
OBS / RTMP ──► MediaMTX ──► ffmpeg (PCM 16 kHz) ──┐
                                                   ├──► Session Manager ──► Gemini Live workers
Navegador (mic/pestaña) ──► WebSocket /ingest ─────┘                              │
                                                                                  ▼
                              Audiencia ◄── WebSocket /ws/captions ◄── EventBus
                              (elegir sesión + idioma)
```

## Características (MVP)

| | |
|---|---|
| ✅ | Transcripción en vivo del idioma original + traducción a español |
| ✅ | Multi-sesión / multi-escenario (10+, configurable) |
| ✅ | Dos fuentes de audio: **RTMP (OBS)** y **navegador** (demo sin infra) |
| ✅ | Vista de **programa público**: grilla de sesiones/casts para elegir y ver subtítulos |
| ✅ | Vista de audiencia web: elegir sesión + idioma, subtítulos live |
| ✅ | Resiliencia: session resumption + compresión de contexto (charlas largas) |
| ✅ | Docker / docker-compose para despliegue en una máquina |
| ✅ | Licencia Apache-2.0 + documentación de despliegue |
| ✅ | Export SRT / VTT / TXT por sesión e idioma (API REST) |
| ✅ | `/overlay` — página transparente para **quemar subtítulos en OBS/vMix** (Browser Source, dual EN+ES, posicionable) |
| ✅ | `/monitor` — **panel de monitoreo** para producción: estado, latencia, rates, errores en vivo |

## Requisitos

- Python 3.11+ (o Docker)
- `ffmpeg` (solo si usás RTMP)
- Una **API key de Gemini** → [Google AI Studio](https://aistudio.google.com/apikey)

## Quickstart (desarrollo)

```bash
git clone <repo-url> simulcast && cd simulcast
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# editá .env y poné tu GEMINI_API_KEY

cp sessions.example.yaml sessions.yaml   # ya viene un ejemplo con 3 escenarios

uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
```

- Audiencia: <http://localhost:8000/>
- Operación / ingesta navegador: <http://localhost:8000/operator>
- Monitoreo producción: <http://localhost:8000/monitor>
- Overlay OBS (Browser Source): <http://localhost:8000/overlay?session=stage-1&langs=original,es>
- Health: <http://localhost:8000/api/health>

### Demo en 60 segundos (sin OBS)

1. Abrí `/` → elegí una sesión de la grilla (o `/operator` para crear una: ej. `stage-1`, origen `en`, traducción `es`).
2. En `/operator` → **Iniciar ingesta** → compartí una pestaña con audio (un video de YouTube en inglés sirve).
3. Volvé a `/` → la sesión pasa a **en vivo** → entrá y elegí idioma → subtítulos en vivo.

## Despliegue con Docker

```bash
cp .env.example .env          # GEMINI_API_KEY=...
cp sessions.example.yaml sessions.yaml
docker compose up --build -d
```

- API + audiencia: `http://TU_HOST:8000`
- RTMP para OBS: `rtmp://TU_HOST:1935/<session_id>`  
  (ej. `rtmp://TU_HOST:1935/stage-1`)

## Configurar sesiones (`sessions.yaml`)

```yaml
sessions:
  - id: stage-1
    name: "Main Stage"
    source_language: en          # en | es | pt | auto
    output_languages: [original, es]
```

- `original` → transcripción del idioma hablado
- `es` / `en` / `pt` → traducción
- Cada conexión Gemini Live entrega **original + una traducción** (input/output transcription). Para dos traducciones desde el mismo origen, duplicá la sesión o agregá una segunda salida en una versión futura.

También se pueden crear/editar sesiones en runtime:

```bash
curl -X POST http://localhost:8000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"id":"stage-4","name":"Stage 4","source_language":"en","output_languages":["original","es"]}'
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado general, modelos, sesiones live, rates, uptime |
| GET | `/api/monitor` | Snapshot de monitoreo (sesiones + métricas + errores) |
| GET | `/api/monitor/errors` | Últimos errores (limit configurable) |
| GET | `/api/sessions` | Lista de sesiones + workers + ingest |
| POST | `/api/sessions` | Crear sesión |
| PUT | `/api/sessions/{id}` | Reconfigurar (reinicia workers) |
| DELETE | `/api/sessions/{id}` | Eliminar |
| GET | `/api/sessions/{id}/captions?lang=es` | Historial de captions |
| GET | `/api/sessions/{id}/export.srt?lang=original` | Export `srt` \| `vtt` \| `txt` |
| WS | `/ws/captions/{id}?lang=es` | Stream de subtítulos (`lang=all` para todo) |
| WS | `/ws/ingest/{id}` | Ingesta PCM binaria desde navegador |
| WS | `/ws/monitor` | Push de estado + snapshots al panel de monitoreo |

### Formato de eventos WS

```json
{
  "type": "caption",
  "session": "stage-1",
  "lang": "es",
  "text": "Hola, bienvenidos a Nerdearla",
  "final": true,
  "t": 1769000000.123,
  "id": "stage-1:es:42:ab12cd"
}
```

Los eventos con `final:false` son parciales (interim) y se reemplazan en la UI por el mismo `id`.

## Cómo funciona (Gemini Live API)

| Modo | Modelo | Resultado |
|---|---|---|
| `translate` | `gemini-3.5-live-translate-preview` | `input_transcription` → original, `output_transcription` → traducción |
| `transcribe` | `gemini-3.5-transcribe-live` | Solo original, con auto-detección de idioma y `custom_vocabulary` (glosario) |

Detalles operativos:

- Audio **PCM s16le mono 16 kHz**, chunks de **100 ms** (3200 bytes).
- **Session resumption** + **context window compression** (`sliding_window`) para charlas de 30–60 min (el Live API corta conexiones ~10–15 min sin esto).
- Reintentos con backoff exponencial (1s → 30s).
- Un worker asyncio por `(sesión, pista)`; el fan-out de audio es no bloqueante (`asyncio.Queue` con drop de chunks viejos para priorizar latencia).

## Arquitectura del código

```
server/
├── main.py               # FastAPI + WS captions/ingest + static
├── api.py                # REST
├── config.py             # Settings (env)
├── models.py             # Pydantic models
├── session_manager.py    # Registro de sesiones, workers, ingest, health
├── gemini_worker.py      # Conexión Live API, resumption, reintentos
├── broadcast.py          # Pub/sub de captions + historial
└── ingest/
    ├── websocket_ingest.py  # Audio desde navegador
    └── rtmp_ingest.py       # ffmpeg desde MediaMTX
web/
├── index.html / app.js   # Vista audiencia
├── operator.html / operator.js  # Ingesta demo + panel
├── monitor.html / monitor.js    # Panel de monitoreo producción
├── overlay.html          # Overlay OBS/vMix
└── style.css
```

## Rendimiento y escala

- **10 escenarios** ≈ 10 conexiones Live API (una por sesión con traducción). El bottleneck habitual es la **cuota de Gemini**, no la CPU local.
- Ajustá `SIMULCAST_MAX_SESSIONS` (default 20).
- Monitoreá `/monitor` (dashboard), `GET /api/monitor` o el estado de workers en `/operator`.
- Cada WS de audiencia es ~unos KB/s; miles de espectadores por sesión no son problema (broadcast en memoria).

## Seguridad

- La **API key nunca sale del servidor** (los navegadores solo hablan WS con tu backend).
- El endpoint `/ws/ingest` está pensado para operadores; **poné auth o una red privada** en producción (ver `docs/DEPLOY.md`).
- MediaMTX corre sin auth por defecto: usalo en LAN/VPN o delantalo con firewall.

## Roadmap (opcionales del reto)

- [x] Quemar subtítulos en OBS/vMix → `/overlay` (Browser Source dual, params de estilo)
- [x] Panel de monitoreo para producción → `/monitor` (estado, latencia, rates, errores)
- [ ] Glosario de términos vía `custom_vocabulary` en `transcribe`
- [ ] Portugués y más idiomas de salida (más workers de translate)
- [ ] Latencia p50/p95 y costos en el panel de monitoreo
- [ ] Auth por sesión + tokens efímeros Gemini para clientes
- [ ] Caller SRT/ffmpeg para quemar subtítulos sin Browser Source

## Licencia

Apache License 2.0 — ver [LICENSE](./LICENSE).
