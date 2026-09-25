/* Simulcast OBS overlay — transparent Browser Source (single caption unit).
 *
 * Uses the SAME model (window.SimulcastCaptions) and the SAME component
 * (window.SimulcastLiveCaption) as the audience page: one bilingual
 * segment (original + translation) updated in place — no event log, no
 * rolling fragment buffers. See the parameter docs in web/overlay.html.
 */
(() => {
  const params = new URLSearchParams(location.search);

  /** Session id from the /overlay/<id> path (query param wins). */
  function sessionFromPath() {
    const m = location.pathname.match(/^\/overlay\/([^/]+)\/?$/);
    try {
      return m ? decodeURIComponent(m[1]) : null;
    } catch {
      return m ? m[1] : null;
    }
  }

  const cfg = {
    session: sessionFromPath() || params.get("session") || "stage-1",
    lang: (params.get("lang") || "").toLowerCase(),
    pos: params.get("pos") === "top" ? "top" : "bottom",
    align: ["left", "center", "right"].includes(params.get("align"))
      ? params.get("align")
      : "center",
    size: clampInt(params.get("size"), 14, 96, 36),
    hold: clampFloat(params.get("hold"), 1, 60, 6),
    bg: clampFloat(params.get("bg"), 0, 1, 0),
    fg: params.get("fg") || "#ffffff",
    accent: params.get("accent") || "#069ddb",
    radius: clampInt(params.get("radius"), 0, 40, 8),
    maxChars: clampInt(params.get("maxchars"), 16, 200, 64),
    badge: params.get("badge") === "1",
    status: params.get("status") === "1",
    style: params.get("style") === "clean" ? "clean" : "bar",
    edge: params.get("edge") === "solid" ? "solid" : "fade",
    gap: clampFloat(params.get("gap"), 0, 1, 0.15),
  };

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v ?? "", 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }
  function clampFloat(v, min, max, dflt) {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }

  // Apply config to CSS / DOM.
  const root = document.documentElement;
  root.style.setProperty("--fg", cfg.fg);
  root.style.setProperty("--accent", cfg.accent);
  root.style.setProperty("--bg-alpha", String(cfg.bg));
  root.style.setProperty("--radius", cfg.radius + "px");
  root.style.setProperty("--font-size", cfg.size + "px");
  root.style.setProperty("--gap", cfg.gap + "em");
  if (cfg.style === "clean") document.body.classList.add("style-clean");
  if (cfg.edge === "solid") document.body.classList.add("edge-solid");

  const stage = document.getElementById("stage");
  stage.className = `pos-${cfg.pos} align-${cfg.align}`;

  const badge = document.getElementById("badge");
  const statusEl = document.getElementById("status");
  if (cfg.status) statusEl.classList.add("show");

  const linesEl = document.getElementById("lines");
  const captionEl = document.getElementById("overlayCaption");
  const cap = window.SimulcastLiveCaption.mount(captionEl, {});

  let hideTimer = null;
  let reconnectDelay = 1000;
  let closed = false;
  let wsOpen = false;
  let sessionStatus = null;
  let store = null;

  const SESSION_STATES = {
    live: ["LIVE", "ok"],
    degraded: ["DEGRADED", ""],
    starting: ["RECONNECTING", ""],
    reconnecting: ["RECONNECTING", ""],
    idle: ["OFFLINE", "err"],
    error: ["OFFLINE", "err"],
    stopped: ["OFFLINE", "err"],
  };

  function setStatus(text, cls) {
    if (!cfg.status) return;
    statusEl.textContent = text;
    statusEl.className = cls || "";
    statusEl.classList.add("show");
  }

  function refreshStatus() {
    if (!wsOpen) {
      setStatus("RECONNECTING", "");
      return;
    }
    const info = SESSION_STATES[sessionStatus] || ["LIVE", "ok"];
    setStatus(info[0], info[1]);
  }

  function showBadge() {
    if (!cfg.badge || !store) return;
    badge.textContent = store.target
      ? `${cfg.session} · ${store.source} → ${store.target}`
      : `${cfg.session} · ${store.source}`;
    badge.classList.add("show");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      linesEl.classList.remove("show");
    }, cfg.hold * 1000);
  }

  function render() {
    const cur = store.current;
    cap.update({
      original: cur ? cur.original : "",
      translation: cur ? cur.translation : "",
      interim: cur ? cur.status === "interim" : false,
      expected: store.target != null,
    });
    // One current caption only (no history, no rolling buffers): it updates
    // in place while Gemini streams the interim, then shows the final.
    if (cur && (cur.original || cur.translation)) linesEl.classList.add("show");
    scheduleHide();
  }

  function pushCaption(msg) {
    if (!store.apply(msg)) return;
    render();
  }

  function start(pair) {
    store = window.SimulcastCaptions.createStore({
      sourceLang: pair.source,
      targetLang: pair.target,
    });
    showBadge();
    connect();
  }

  /**
   * Resolves the (source, target) language pair — the same pair the
   * audience page shows for the session:
   *   ?langs=a,b → explicit (single line only when a === b).
   *   ?lang=<x>  → single line in language x.
   *   ?lang=all  → dual original + first translation (config-derived).
   *   (nothing)  → NEW default: dual from the session config, so
   *                /overlay/<id> just works with original + translation.
   *                Falls back to original-only if the config fetch fails.
   */
  async function resolvePair() {
    const langsParam = params.get("langs");
    if (langsParam) {
      const parts = langsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const source = parts[0] || "original";
      const second = parts[1] || null;
      return { source, target: second && second !== source ? second : null };
    }
    if (cfg.lang && cfg.lang !== "all") {
      return { source: cfg.lang, target: null };
    }
    // Dual: ask the session for its configured translation.
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(cfg.session)}`);
      if (res.ok) {
        const body = await res.json();
        const outputs = body?.config?.output_languages || [];
        const first = outputs.find((l) => l !== "original") || null;
        if (first) return { source: "original", target: first };
        return { source: "original", target: null };
      }
    } catch {
      /* offline/config unreachable → fall through to the fallback */
    }
    if (cfg.lang === "all") return { source: "original", target: "es" };
    return { source: "original", target: null };
  }

  // Single WebSocket with lang=all (the store filters to the pair above).
  let ws = null;

  function connect() {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/ws/captions/${encodeURIComponent(cfg.session)}` +
      `?lang=all`;
    setStatus("RECONNECTING", "");
    wsOpen = false;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      wsOpen = true;
      refreshStatus();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "caption") pushCaption(msg);
      if (msg.type === "hello" || msg.type === "state") {
        if (msg.state && msg.state.status) {
          sessionStatus = msg.state.status;
          refreshStatus();
        } else if (msg.type === "hello") {
          sessionStatus = "live";
          refreshStatus();
        }
      }
    };
    ws.onerror = () => setStatus("OFFLINE", "err");
    ws.onclose = () => {
      if (closed) return;
      wsOpen = false;
      setStatus("RECONNECTING", "");
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
    };
  }

  // Visibility: OBS may keep the source active; no special handling needed.
  window.addEventListener("beforeunload", () => {
    closed = true;
    try {
      ws && ws.close();
    } catch {
      /* ignore */
    }
  });

  resolvePair().then(start);
})();
