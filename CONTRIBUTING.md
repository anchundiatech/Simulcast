# Contribuir a Simulcast

Gracias por querer mejorar Simulcast. Este documento explica cómo preparar tu
entorno, qué revisar antes de mandar un PR y cómo se trabaja en el proyecto.

## Cómo contribuir

- **Bugs y mejoras**: abrí una issue describiendo pasos para reproducir,
  resultado esperado y real.
- **Código**: siempre desde una issue o un PR de referencia.
- **Docs / traducciones**: `README.md`, `docs/DEPLOY.md` y los textos de la UI
  (la interfaz está en español rioplatense, mantené ese tono).
- **Code of Conduct**: al participar aceptás el
  [Código de Conducta](CODE_OF_CONDUCT.md).

## Entorno de desarrollo

Requisitos: Python 3.11+, `ffmpeg` (solo si probás RTMP) y una
`GEMINI_API_KEY` en `.env` (nunca la subas al repo).

```bash
git clone <repo-url> simulcast && cd simulcast
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # poné tu GEMINI_API_KEY
cp sessions.example.yaml sessions.yaml

./scripts/dev-server.sh     # http://127.0.0.1:8765
```

O con uvicorn directo: `uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload`.

## Checks antes de abrir el PR

```bash
.venv/bin/ruff check server/ tests/
.venv/bin/pytest tests/ -q
node --check web/*.js
```

Los tres tienen que pasar. Si agregás una ruta, endpoint o cambio en el HTML,
sumá/redactá el assert correspondiente en `tests/test_smoke.py`.

## Convenciones

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`, `test:`) en inglés, como el historial.
- **Backend**: Python + FastAPI en `server/`; tipá los parámetros nuevos.
- **Frontend**: HTML/CSS/JS plano en `web/`, sin build. Usá las clases `.btn`,
  `.pill`, `.field` y la paleta de `web/style.css`. Accesibilidad WCAG AA:
  `aria-labels`, foco visible, soporte `prefers-reduced-motion` en animaciones.
- **No commitees** `.env`, `sessions.yaml` ni claves (están en `.gitignore`).
- **Sin pushes directos a `main`** sin que un maintainer lo pida: mandá PR.

## Futuras features

1. Glosario / vocabulario por sesión (`custom_vocabulary` → Gemini).
2. Métricas p50/p95 de latencia y costos por sesión.
3. Portugués como tercer idioma de traducción.
4. Auth MVP por sesión / token de admin.
5. Burn SRT/ffmpeg y export mejorado.

## Licencia

Al contribuir, tus cambios quedan licenciados bajo
[Apache License 2.0](LICENSE), la misma licencia del proyecto.
