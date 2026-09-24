# Despliegue de Simulcast en una conferencia

Guía para que cualquier evento open source ponga Simulcast en producción.

## 1. Requisitos de infraestructura

| Recurso | Mínimo (demo) | Recomendado (10 escenarios) |
|---|---|---|
| VM / servidor | 2 vCPU · 4 GB RAM | 4 vCPU · 8 GB RAM |
| Ancho de banda subida | 5 Mbps | 20+ Mbps (salida de captions es liviana) |
| ffmpeg | sí (RTMP) | sí |
| API key Gemini | 1 | 1 (monitorear cuota) |
| Docker | opcional | sí |

El consumo real de CPU/RAM es bajo: el trabajo pesado lo hace la Gemini Live API. Lo local es I/O (ffmpeg + WebSockets).

## 2. Instalación con Docker (recomendado)

```bash
git clone <repo-url> simulcast && cd simulcast
cp .env.example .env
$EDITOR .env                 # GEMINI_API_KEY=tu_key
cp sessions.example.yaml sessions.yaml
$EDITOR sessions.yaml        # tus escenarios reales

docker compose up -d --build
curl -s http://localhost:8000/api/health | jq
```

Salida esperada: `"gemini_configured": true`.

## 3. Configurar escenarios

Editá `sessions.yaml` y reiniciá (o usá la API `POST /api/sessions` sin reiniciar):

```yaml
sessions:
  - id: main
    name: "Main Stage"
    source_language: en
    output_languages: [original, es]
  - id: workshop
    name: "Workshop Room"
    source_language: en
    output_languages: [original, es]
```

**Importante:** el `id` es el nombre del path RTMP en OBS (`rtmp://TU_HOST:1935/main`).

## 4. Conectar OBS (por escenario)

En cada computadora de escenario / máquina de streaming:

1. OBS → **Settings → Stream**
   - Service: **Custom…**
   - Server: `rtmp://TU_HOST:1935`
   - Stream Key: `main` (el `id` de la sesión)
2. Verificá en `/operator` que la sesión pase a **Audio ● activo**.
3. Los workers de Gemini arrancan solos con el primer audio.

Si el evento ya tiene un MediaMTX / nginx-rtmp existente, apuntá `SIMULCAST` a esa fuente o reutilizá el mismo proceso (ver §7).

## 5. Vista para la audiencia

Compartí la URL del evento (programa con todas las sesiones/casts):

```
https://captions.tuevento.com/
```

- La portada muestra una **grilla de sesiones** con estado (`en vivo`), idiomas y espectadores.
- Al elegir una cast se abre `/?session=main` con la transcripción + traducción.
- Cada persona también puede elegir **idioma** (Original / Español / English).
- Ideal embeber como **iframe** o link en el programa del evento.
- Para apps móviles: la misma URL es PWA-ready (podés agregar manifest después).

## 6. OBS / vMix — "quemar" subtítulos en el stream

Simulcast incluye una página transparente **`/overlay`** pensada como
**Browser Source** de OBS, vMix, Streamlabs o cualquier tool que cargue HTML.

### Opción A — Browser Source (recomendada)

1. En OBS: **Sources → + → Browser**.
2. **URL** (elegí la variante que necesites):

| Caso | URL |
|---|---|
| Solo español (EN talk) | `https://captions.tuevento.com/overlay?session=main&lang=es` |
| Dual EN + ES (arriba/abajo) | `https://captions.tuevento.com/overlay?session=main&langs=original,es` |
| Solo original | `https://captions.tuevento.com/overlay?session=main&lang=original` |
| Sin caja (texto + sombra) | `…&style=clean` |
| Chico / grande | `…&size=28` / `…&size=48` |
| Arriba a la izquierda | `…&pos=top&align=left` |
| Debug de conexión | `…&status=1&badge=1` |

3. **Width/Height**: 1920×1080 (igual al canvas).
4. Desactivá **“Refresh browser when scene becomes active”** para no cortar el WS.
5. Custom CSS: dejá vacío (la página ya es transparente).

### Parámetros del overlay

| Param | Default | Descripción |
|---|---|---|
| `session` | `stage-1` | Id de la sesión |
| `lang` | `original` | `original` \| `es` \| `en` \| `pt` \| `all` (= dual original+es) |
| `langs` | — | Dual explícito: `original,es` o `es,en` |
| `pos` | `bottom` | `bottom` \| `top` |
| `align` | `center` | `left` \| `center` \| `right` |
| `size` | `36` | Tamaño de fuente px (14–96) |
| `hold` | `6` | Segundos que queda el texto visible |
| `bg` | `0` | Opacidad del fondo 0–1 (**0 = barra transparente**) |
| `fg` / `accent` | `#fff` / `#069ddb` | Color original / traducción (primario) |
| `radius` | `8` | Border-radius px |
| `style` | `bar` | `bar` (caja) \| `clean` (solo texto+shadow) |
| `badge` | `0` | `1` muestra chip sesión·idioma |
| `status` | `0` | `1` muestra pill de estado WS |
| `edge` | `fade` | `fade` = fondo se disuelve a los costados (sin línea vertical); `solid` = pill con borde duro |

El overlay:

- se reconecta solo con backoff exponencial
- hace **rolling de 4 fragments** para que los captions cortos se lean como oración
- en dual muestra original (blanco) + traducción (cian) apilados
- **no muestra scrollbars ni líneas laterales** (ideal OBS Browser Source)
- **no envía la API key al navegador** (solo WS a tu backend)

### Opción B — vMix

**Settings → Global → Web Browser** o *Input → Web Browser* con la misma URL.
vMix acepta fondos transparentes en el overlay; usá `style=clean` si el player no compone alpha correctamente.

### Opción C — Streamlabs / Cloud OBS

Mismo Browser Source; asegurate de que el host del overlay esté en HTTPS.

**Pre-warm:** por defecto los workers Gemini arrancan con el primer audio (ahorra cuota). Para mínimo time-to-first-caption en el vivo, exportá `SIMULCAST_EAGER_WORKERS=1`.

**Opción D — Fuera del overlay (futuro):** export VTT + un caller SRT para quemar vía ffmpeg. Ya existe el export en la API (`/api/sessions/{id}/export.vtt`).

## 7. Instalación sin Docker

```bash
sudo apt-get install -y ffmpeg
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# RTMP server (binario único)
wget https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz
tar xf mediamtx_*.tar.gz mediamtx
./mediamtx mediamtx.yml &

export GEMINI_API_KEY=...
export SIMULCAST_RTMP_BASE=rtmp://localhost:1935   # default
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

## 8. Seguridad en producción

1. **TLS** con Caddy/nginx delante de `:8000` (WSS obligatorio para WebSockets en https).
2. **API key** solo en el servidor (ya lo es por diseño).
3. **Audio en vivo**: restringí `/ws/ingest` y el RTMP a la red del venue (firewall / VPN / `allow` en MediaMTX).
4. **Rate limit** opcional en `/api/*` si es público.

Ejemplo mínimo con Caddy:

```
captions.tuevento.com {
    reverse_proxy localhost:8000
}
```

## 9. Operación durante el evento

- Abrí **`/monitor`** en una pantalla dedicada del equipo de producción:
  - KPIs globales: uptime, sesiones live/degradadas, captions/min, errores, Gemini
  - Por sesión: ingest (frescura de audio), workers (conectados / reconexiones / cola), latencia EMA, rates, espectadores
  - Tabla de **errores recientes** (worker reconnects, etc.)
  - Se actualiza por **WebSocket** (`/ws/monitor`) con fallback a polling 2s/5s
- También podés pegar `GET /api/monitor` o `GET /api/health` en un script/alerta.
- Si una sesión se degrada, los workers reintentan solos con backoff (se ve en reconexiones del panel).
- Al final de cada charla:  
  `GET /api/sessions/main/export.vtt?lang=es` → archivo para publicar.

## 10. Costos / cuota Gemini

- Cada sesión con traducción = **1 conexión Live API** (audio de entrada + transcripts).
- Activa solo los escenarios que están en aire (los workers se detienen ~60 s después de que muere el RTMP).
- Mirá el uso en [Google AI Studio → Usage](https://aistudio.google.com/usage).

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `gemini_configured: false` | Falta `GEMINI_API_KEY` | `.env` + `docker compose restart` |
| Audio inactivo en OBS | Stream key ≠ `id` | Usá el id exacto del `sessions.yaml` |
| Workers `error` | Key inválida o cuota | `/monitor`, `/api/health`, logs `docker compose logs -f` |
| Subtítulos lentos | Interim deshabilitado / red | Revisá logs; el UI usa interims para latencia |
| Sesión corta a los ~10 min | Falta resumption | Ya está habilitado; mirar logs `go_away` |
