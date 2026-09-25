/* Simulcast audience UI — program picker + captions player */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const PROGRAM = "/program";

  const viewPicker = $("#viewPicker");
  const viewPlayer = $("#viewPlayer");
  const sessionGrid = $("#sessionGrid");
  const pickerEmpty = $("#pickerEmpty");
  const pickerFilter = $("#pickerFilter");
  const pickerStatus = $("#pickerStatus");

  const sessionSelect = $("#sessionSelect");
  const langSelect = $("#langSelect");
  const connBadge = $("#connBadge");
  const liveCaption = $("#liveCaption");
  const historyEl = $("#history");
  const captionLang = $("#captionLang");
  const captionState = $("#captionState");
  const sessionName = $("#sessionName");
  const playerTitle = $("#playerTitle");
  const playerSubtitle = $("#playerSubtitle");
  const mStatus = $("#mStatus");
  const mViewers = $("#mViewers");
  const mLast = $("#mLast");
  const mLangs = $("#mLangs");

  let ws = null;
  let sessions = [];
  let currentLang = localStorage.getItem("simulcast.lang") || "original";
  let filterQ = "";
  const CAPTION_PLACEHOLDER = "Esperando transcripción…";
  /**
   * Modelo de captions (interim/final, dedupe, agrupación, recorte):
   * lógica pura sin DOM, compartida con los tests en tests/frontend/.
   * El render lee `store.blocks` / `store.current` / `store.activeBlock`.
   */
  const store = window.SimulcastCaptions.createStore();
  /** @type {Map<object, HTMLElement>} bloque visible → <li> */
  const blockEls = new Map();

  function setBadge(el, text, cls) {
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  function langLabel(code) {
    const names = { es: "Español", en: "English", pt: "Português", auto: "Auto" };
    if (code === "original") return "Original (idioma hablado)";
    return `${names[code] || code.toUpperCase()} (${code})`;
  }

  /** Etiqueta corta para el chip del caption actual. */
  function langChip(code) {
    const names = { es: "Español", en: "English", pt: "Português", auto: "Auto" };
    if (code === "original") return "Original";
    return names[code] || String(code || "").toUpperCase();
  }

  /**
   * Estados del backend → 4 estados visibles para la audiencia.
   * Estados futuros desconocidos se muestran tal cual (sin romper nada).
   */
  const STATUS_LABELS = {
    live: { label: "en vivo", cls: "live" },
    degraded: { label: "degradado", cls: "warn" },
    starting: { label: "reconectando", cls: "warn" },
    reconnecting: { label: "reconectando", cls: "warn" },
    error: { label: "offline", cls: "err" },
    stopped: { label: "offline", cls: "" },
    idle: { label: "offline", cls: "" },
  };

  function statusInfo(status) {
    return STATUS_LABELS[status] || { label: status || "—", cls: "" };
  }

  function statusPill(status) {
    const info = statusInfo(status);
    return `<span class="pill ${info.cls}">${escapeHtml(info.label)}</span>`;
  }

  /**
   * Latencia medida por el backend (primer audio → primer caption) para
   * la sesión activa. Sin medición todavía → sin sufijo (no inventamos).
   */
  function latencySuffix() {
    const lat = currentSession()?.metrics?.first_caption_latency_s;
    return typeof lat === "number" && isFinite(lat) ? ` · ${lat.toFixed(1)}s` : "";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function filteredSessions() {
    const q = filterQ.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const id = (s.config?.id || "").toLowerCase();
      const name = (s.config?.name || "").toLowerCase();
      return id.includes(q) || name.includes(q);
    });
  }

  function renderPicker() {
    const list = filteredSessions();
    const liveCount = sessions.filter((s) => s.status === "live").length;
    setBadge(
      pickerStatus,
      liveCount > 0 ? `${liveCount} en vivo` : `${sessions.length} sesiones`,
      liveCount > 0 ? "badge-on" : "badge-off",
    );

    if (!sessions.length) {
      sessionGrid.innerHTML = "";
      pickerEmpty.hidden = false;
      return;
    }
    if (!list.length) {
      sessionGrid.innerHTML = `<p class="hint">Sin resultados para «${escapeHtml(filterQ)}».</p>`;
      pickerEmpty.hidden = true;
      return;
    }

    pickerEmpty.hidden = true;
    sessionGrid.innerHTML = list
      .map((s) => {
        const langs = (s.config?.output_languages || [])
          .map((l) =>
            l === "original"
              ? `<span class="pill">original</span>`
              : `<span class="pill live">${escapeHtml(langLabel(l))}</span>`,
          )
          .join(" ");
        const viewers = s.viewers ?? 0;
        const ingest = s.ingest?.active
          ? `<span class="muted-num">${escapeHtml(s.ingest.kind || "audio")} activo</span>`
          : `<span class="muted-num">sin audio</span>`;
        return `
        <a class="session-card ${s.status === "live" ? "is-live" : ""}" href="${PROGRAM}?session=${encodeURIComponent(s.config.id)}" data-id="${escapeHtml(s.config.id)}">
          <header class="session-card-h">
            <strong>${escapeHtml(s.config.name)}</strong>
            ${statusPill(s.status)}
          </header>
          <p class="session-card-id">${escapeHtml(s.config.id)}</p>
          <div class="session-card-langs">${langs}</div>
          <footer class="session-card-f">
            <span class="muted-num">${viewers} espectador${viewers === 1 ? "" : "es"}</span>
            ${ingest}
            <span class="session-card-cta">Ver subtítulos →</span>
          </footer>
        </a>`;
      })
      .join("");
  }

  function showPicker() {
    viewPlayer.hidden = true;
    viewPicker.hidden = false;
    document.title = "Simulcast — Subtítulos en vivo";
    disconnect();
    stopCaptionUi();
    renderPicker();
  }

  function showPlayer(sid) {
    viewPicker.hidden = true;
    viewPlayer.hidden = false;
    document.title = `Simulcast — ${sid}`;
    history.replaceState(null, "", `${PROGRAM}?session=${encodeURIComponent(sid)}`);
    // Ensure select has the session, then connect.
    ensureSessionSelected(sid);
    refreshLangs();
    updateMetaFromList();
    stopCaptionUi();
    connect();
  }

  function stopCaptionUi() {
    historyEl.innerHTML = "";
    blockEls.clear();
    store.reset();
    liveCaption.textContent = CAPTION_PLACEHOLDER;
    liveCaption.classList.add("is-empty");
    liveCaption.classList.remove("interim");
    if (captionLang) captionLang.textContent = langChip(currentLang);
    if (captionState) captionState.textContent = "esperando audio…";
  }

  function ensureSessionSelected(sid) {
    const exists = sessions.some((s) => s.config.id === sid);
    if (exists) {
      sessionSelect.value = sid;
      return;
    }
    // Session not loaded yet — put a placeholder option so select is valid.
    if (![...sessionSelect.options].some((o) => o.value === sid)) {
      const opt = document.createElement("option");
      opt.value = sid;
      opt.textContent = sid;
      sessionSelect.appendChild(opt);
    }
    sessionSelect.value = sid;
  }

  function routeFromUrl() {
    const sid = new URLSearchParams(location.search).get("session");
    if (sid) showPlayer(sid);
    else showPicker();
  }

  async function loadSessions({ keepRoute = true } = {}) {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    sessions = data.sessions || [];
    const prev = sessionSelect.value;
    sessionSelect.innerHTML = "";
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.config.id;
      opt.textContent = `${s.config.name} (${s.config.id})`;
      sessionSelect.appendChild(opt);
    }
    const urlSid = new URLSearchParams(location.search).get("session");
    if (urlSid && sessions.some((s) => s.config.id === urlSid)) {
      sessionSelect.value = urlSid;
    } else if (prev && sessions.some((s) => s.config.id === prev)) {
      sessionSelect.value = prev;
    } else if (sessions.length) {
      sessionSelect.value = sessions[0].config.id;
    }
    if (!viewPicker.hidden) renderPicker();
    if (!viewPlayer.hidden) {
      refreshLangs();
      updateMetaFromList();
      if (keepRoute && urlSid) ensureSessionSelected(urlSid);
    }
  }

  function currentSession() {
    return sessions.find((s) => s.config.id === sessionSelect.value) || null;
  }

  function refreshLangs() {
    const s = currentSession();
    const langs = s?.config?.output_languages || ["original"];
    const prev = currentLang;
    langSelect.innerHTML = "";
    for (const l of langs) {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = langLabel(l);
      langSelect.appendChild(opt);
    }
    langSelect.value = langs.includes(prev) ? prev : langs[0];
    currentLang = langSelect.value;
  }

  function updateMetaFromList() {
    const s = currentSession();
    if (!s) return;
    sessionName.textContent = s.config.name;
    playerTitle.textContent = s.config.name;
    playerSubtitle.textContent = `${s.config.id} · subtítulos en vivo`;
    mStatus.innerHTML = statusPill(s.status);
    mViewers.textContent = s.viewers ?? "—";
    mLast.textContent = s.last_caption_at
      ? new Date(s.last_caption_at * 1000).toLocaleTimeString()
      : "—";
    mLangs.textContent = (s.config.output_languages || []).map(langLabel).join(", ");
    renderCurrent(); // refresca el sufijo de latencia del estado
  }

  function connect() {
    const sid = sessionSelect.value;
    if (!sid) return;
    disconnect();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/captions/${sid}?lang=${encodeURIComponent(currentLang)}`;
    setBadge(connBadge, "conectando…", "badge-warn");
    ws = new WebSocket(url);

    ws.onopen = () => setBadge(connBadge, "conectado", "badge-on");
    ws.onclose = () => {
      // Si seguimos en el reproductor ya estamos en el retry programado:
      // el estado correcto es "reconectando", no "desconectado".
      if (viewPlayer.hidden) {
        setBadge(connBadge, "desconectado", "badge-off");
        return;
      }
      setBadge(connBadge, "reconectando…", "badge-warn");
      setTimeout(() => {
        if (!viewPlayer.hidden && sessionSelect.value === sid) connect();
      }, 2000);
    };
    ws.onerror = () => setBadge(connBadge, "error", "badge-err");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "caption") upsertCaption(msg);
      if (msg.type === "state" || msg.type === "hello") {
        if (msg.state) applyState(msg.state);
        loadSessionsMetaOnly(msg.state);
      }
    };
  }

  function loadSessionsMetaOnly(state) {
    if (!state?.config) return;
    const idx = sessions.findIndex((s) => s.config.id === state.config.id);
    if (idx >= 0) sessions[idx] = state;
    else sessions.push(state);
    if (!viewPicker.hidden) renderPicker();
    if (state.config.id === sessionSelect.value && !viewPlayer.hidden) {
      updateMetaFromList();
    }
  }

  function applyState(state) {
    loadSessionsMetaOnly(state);
  }

  // ---------------------------------------------------------------- captions
  //
  // El modelo vive en web/captions.js (window.SimulcastCaptions): interim →
  // reemplaza `current` en lugar y sella el bloque activo; final → crea o
  // extiende un bloque (dedupe por id, fusión de texto, agrupación ≤ GAP) y
  // recorta el historial. Acá solo queda el render.

  function fmtTime(t) {
    return new Date(t * 1000).toLocaleTimeString();
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }

  function renderCurrent() {
    const current = store.current;
    if (!current || !current.text) {
      if (!liveCaption.classList.contains("is-empty")) {
        liveCaption.textContent = CAPTION_PLACEHOLDER;
        liveCaption.classList.add("is-empty");
      }
      liveCaption.classList.remove("interim");
    } else {
      liveCaption.classList.remove("is-empty");
      liveCaption.classList.toggle("interim", !!current.interim);
      if (liveCaption.textContent !== current.text) liveCaption.textContent = current.text;
    }
    if (captionLang) captionLang.textContent = langChip(current ? current.lang : currentLang);
    if (captionState) {
      captionState.textContent = !current
        ? "esperando audio…"
        : current.interim
          ? "transcribiendo…"
          : "en vivo";
    }
  }

  function renderHistory() {
    // Se hace antes de tocar el DOM: solo scrolleamos si el usuario ya estaba
    // al final (no le robamos el scroll si está leyendo algo anterior).
    const stick = isNearBottom(historyEl);
    const visible = store.blocks.filter((b) => b !== store.activeBlock);
    const visibleSet = new Set(visible);

    for (const [block, el] of blockEls) {
      if (!visibleSet.has(block)) {
        el.remove();
        blockEls.delete(block);
        block.el = null;
      }
    }

    for (const block of visible) {
      let el = blockEls.get(block);
      if (!el) {
        el = document.createElement("li");
        el.className = "line";
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = fmtTime(block.t);
        const txt = document.createElement("span");
        txt.className = "txt";
        txt.textContent = block.text;
        el.append(ts, txt);
        el.dataset.text = block.text;
        block.el = el;
        blockEls.set(block, el);
        historyEl.appendChild(el);
      } else if (el.dataset.text !== block.text) {
        // Actualización en lugar: sin re-append ni salto visual.
        el.querySelector(".txt").textContent = block.text;
        el.dataset.text = block.text;
      }
    }

    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  function upsertCaption(cap) {
    // El modelo (validación, dedupe, agrupación, recorte) vive en captions.js.
    if (!store.apply(cap, currentLang)) return;
    renderCurrent();
    renderHistory();
  }

  function disconnect() {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  // Card click via event delegation (also works after re-render).
  sessionGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".session-card");
    if (!card) return;
    e.preventDefault();
    const sid = card.getAttribute("data-id");
    if (sid) {
      // Soft navigation so back button still works via history.
      history.pushState({ session: sid }, "", `${PROGRAM}?session=${encodeURIComponent(sid)}`);
      showPlayer(sid);
    }
  });

  window.addEventListener("popstate", routeFromUrl);

  pickerFilter.addEventListener("input", () => {
    filterQ = pickerFilter.value;
    renderPicker();
  });

  sessionSelect.addEventListener("change", () => {
    const sid = sessionSelect.value;
    if (!sid) return;
    history.pushState({ session: sid }, "", `${PROGRAM}?session=${encodeURIComponent(sid)}`);
    refreshLangs();
    updateMetaFromList();
    stopCaptionUi();
    connect();
  });

  langSelect.addEventListener("change", () => {
    currentLang = langSelect.value;
    localStorage.setItem("simulcast.lang", currentLang);
    stopCaptionUi(); // historial pertenece al idioma anterior
    connect();
  });

  // Poll session list lightly to pick up new sessions / status changes.
  setInterval(async () => {
    const before = JSON.stringify(sessions.map((s) => [s.config.id, s.status, s.viewers]));
    try {
      await loadSessions();
      const after = JSON.stringify(sessions.map((s) => [s.config.id, s.status, s.viewers]));
      if (!viewPlayer.hidden && before !== after) {
        const urlSid = new URLSearchParams(location.search).get("session");
        if (urlSid) ensureSessionSelected(urlSid);
        updateMetaFromList();
      }
    } catch {
      /* ignore */
    }
  }, 8000);

  loadSessions().then(routeFromUrl);
})();
