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
  const transField = $("#transField");
  const statusIndicator = $("#statusIndicator");
  const statusText = statusIndicator.querySelector(".status-text");
  const latencyLabel = $("#latencyLabel");
  const srcLangName = $("#srcLangName");
  const currentCaptionEl = $("#currentCaption");
  const historyEl = $("#history");
  const toLiveBtn = $("#toLiveBtn");
  const captionState = $("#captionState");
  const sessionName = $("#sessionName");
  const playerTitle = $("#playerTitle");
  const playerSubtitle = $("#playerSubtitle");
  const mStatus = $("#mStatus");
  const mViewers = $("#mViewers");
  const mLast = $("#mLast");
  const mLatency = $("#mLatency");
  const mLangs = $("#mLangs");

  let ws = null;
  let sessions = [];
  /** Idioma de traducción elegido (null = sesión solo-original). */
  let currentTarget = localStorage.getItem("simulcast.lang") || null;
  /** Estado de la conexión WS: connecting | open | retrying | closed. */
  let connState = "closed";
  let filterQ = "";
  let lastHistoryCount = 0;
  const CAPTION_PLACEHOLDER = "Esperando transcripción…";
  /**
   * Modelo de captions bilingüe (interim/final, dedupe, agrupación,
   * emparejado original↔traducción, recorte): lógica pura sin DOM,
   * compartida con los tests en tests/frontend/.
   * El render lee `store.segments` / `store.current` y dibuja con el
   * componente LiveCaption (window.SimulcastLiveCaption), el mismo que
   * usa el overlay de OBS.
   */
  const store = window.SimulcastCaptions.createStore();
  const currentCap = window.SimulcastLiveCaption.mount(currentCaptionEl, {
    placeholder: CAPTION_PLACEHOLDER,
  });
  /** @type {Map<object, {li: HTMLElement, lc: object}>} segmento → vista */
  const segViews = new Map();
  const reduceMotion = () =>
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setBadge(el, text, cls) {
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  function langLabel(code) {
    const names = { es: "Español", en: "English", pt: "Português", auto: "Auto" };
    if (code === "original") return "Original (idioma hablado)";
    return `${names[code] || code.toUpperCase()} (${code})`;
  }

  /** Etiqueta corta del idioma, en su propio idioma (spec §9-10). */
  function langName(code) {
    const names = {
      es: "Español",
      en: "English",
      pt: "Português",
      fr: "Français",
      de: "Deutsch",
      auto: "Auto",
      original: "Original",
    };
    if (code == null || code === "") return "—";
    return names[code] || String(code).toUpperCase();
  }

  /**
   * Estados del backend → 4 estados visibles para la audiencia (§11).
   * Siempre con representación textual además del punto de color (§21).
   * Estados futuros desconocidos caen en OFFLINE (sin captions en vivo).
   */
  function audienceStateInfo() {
    if (connState !== "open") return { key: "reconnecting", label: "RECONNECTING" };
    switch (currentSession()?.status) {
      case "live":
        return { key: "live", label: "LIVE" };
      case "degraded":
        return { key: "degraded", label: "DEGRADED" };
      case "starting":
      case "reconnecting":
        return { key: "reconnecting", label: "RECONNECTING" };
      default:
        return { key: "offline", label: "OFFLINE" };
    }
  }

  /**
   * Latencia medida real (primer audio → primer caption) de la sesión
   * activa. Sin medición todavía → null y no se muestra nada (§12:
   * no inventar números).
   */
  function measuredLatencyS() {
    const lat = currentSession()?.metrics?.first_caption_latency_s;
    return typeof lat === "number" && isFinite(lat) ? lat : null;
  }

  function updateStatusIndicator() {
    const info = audienceStateInfo();
    statusIndicator.dataset.state = info.key;
    statusText.textContent = info.label;
    statusIndicator.setAttribute("aria-label", `Estado de la sesión: ${info.label}`);
    const lat = measuredLatencyS();
    if (lat == null) {
      latencyLabel.hidden = true;
      latencyLabel.textContent = "";
      if (mLatency) mLatency.textContent = "—";
    } else {
      latencyLabel.hidden = false;
      latencyLabel.textContent = `Latencia ${lat.toFixed(1)}s`;
      if (mLatency) mLatency.textContent = `${lat.toFixed(1)} s`;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Pills de estado para las tarjetas del programa y la ficha de sesión
   * (etiquetas en español; el indicador principal del header usa los
   * tokens §11 LIVE/DEGRADED/…).
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

  function statusPill(status) {
    const info = STATUS_LABELS[status] || { label: status || "—", cls: "" };
    return `<span class="pill ${info.cls}">${escapeHtml(info.label)}</span>`;
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
    segViews.clear();
    lastHistoryCount = 0;
    store.reset();
    currentCap.update({
      original: "",
      translation: "",
      interim: false,
      expected: store.target != null,
    });
    if (captionState) captionState.textContent = "esperando audio…";
    if (toLiveBtn) toLiveBtn.hidden = true;
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

  /**
   * Selector de traducción (spec §9-10): la sesión define output_languages
   * (siempre con "original" primero); el selector lista solo las
   * traducciones y cambia cuál se muestra — la traducción aparece
   * automáticamente, sin que haya que "activarla".
   * No resetea el store: el polling de sesiones también pasa por acá.
   */
  function refreshLangs() {
    const s = currentSession();
    const translations = (s?.config?.output_languages || []).filter((l) => l !== "original");
    const prev = currentTarget;
    langSelect.innerHTML = "";
    if (!translations.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "—";
      langSelect.appendChild(opt);
      langSelect.value = "";
      langSelect.disabled = true;
      if (transField) transField.hidden = true;
      currentTarget = null;
    } else {
      if (transField) transField.hidden = false;
      langSelect.disabled = false;
      for (const l of translations) {
        const opt = document.createElement("option");
        opt.value = l;
        opt.textContent = langName(l);
        langSelect.appendChild(opt);
      }
      langSelect.value = translations.includes(prev) ? prev : translations[0];
      currentTarget = langSelect.value;
      if (currentTarget !== prev) {
        // Corrección automática (ej. valor viejo "original" guardado):
        // persistir para que el default sea estable.
        localStorage.setItem("simulcast.lang", currentTarget);
      }
    }
    // Cabecera: "Original: English" + "English → Español" (§9, §24).
    const srcName = langName(s?.config?.source_language || "auto");
    if (srcLangName) srcLangName.textContent = srcName;
    if (playerSubtitle) {
      playerSubtitle.textContent = currentTarget
        ? `${srcName} → ${langName(currentTarget)}`
        : srcName;
    }
    store.configure({ sourceLang: "original", targetLang: currentTarget });
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
    updateStatusIndicator(); // estado LIVE/… + latencia medida del header
  }

  function connect() {
    const sid = sessionSelect.value;
    if (!sid) return;
    disconnect();
    connState = "connecting";
    updateStatusIndicator();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Una sola suscripción por sesión ("all", spec §17): original y
    // traducción llegan por el mismo socket y el modelo los empareja en
    // segmentos bilingües. Elegir traducción ya no reconecta.
    const url = `${proto}://${location.host}/ws/captions/${sid}?lang=all`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      connState = "open";
      updateStatusIndicator();
    };
    ws.onclose = () => {
      connState = "retrying";
      // Si seguimos en el reproductor ya estamos en el retry programado:
      // el estado correcto es "reconnecting", no "desconectado".
      if (viewPlayer.hidden) {
        connState = "closed";
        return;
      }
      updateStatusIndicator();
      setTimeout(() => {
        if (!viewPlayer.hidden && sessionSelect.value === sid) connect();
      }, 2000);
    };
    ws.onerror = () => {
      connState = "retrying";
      if (!viewPlayer.hidden) updateStatusIndicator();
    };
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
  // El modelo vive en web/captions.js (window.SimulcastCaptions): segmentos
  // bilingües original+traducción — interim actualiza el caption actual en
  // lugar, final lo confirma, la traducción final se empareja por
  // tiempo/orden, y el historial conserva segmentos completos (≤20).
  // El render usa el componente LiveCaption (window.SimulcastLiveCaption),
  // el mismo que el overlay de OBS.

  function fmtTime(t) {
    return new Date(t * 1000).toLocaleTimeString();
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }

  function smoothScroll() {
    return !(typeof reduceMotion === "function" && reduceMotion());
  }

  function renderCurrent() {
    const cur = store.current;
    currentCap.update({
      original: cur ? cur.original : "",
      translation: cur ? cur.translation : "",
      interim: cur ? cur.status === "interim" : false,
      expected: store.target != null,
    });
    if (captionState) {
      captionState.textContent = !cur
        ? "esperando audio…"
        : cur.status === "interim"
          ? "transcribiendo…"
          : "en vivo";
    }
  }

  function renderHistory() {
    // Se hace antes de tocar el DOM: solo scrolleamos si el usuario ya estaba
    // al final (no le robamos el scroll si está leyendo algo anterior).
    const stick = isNearBottom(historyEl);
    // El último segmento ES el caption actual → el historial es todo lo demás.
    const visible = store.segments.slice(0, -1);
    const visibleSet = new Set(visible);
    let appended = false;

    for (const [seg, view] of segViews) {
      if (!visibleSet.has(seg)) {
        view.li.remove();
        segViews.delete(seg);
      }
    }

    for (const seg of visible) {
      let view = segViews.get(seg);
      if (!view) {
        const li = document.createElement("li");
        li.className = "seg";
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = fmtTime(seg.t);
        li.appendChild(ts);
        const lc = window.SimulcastLiveCaption.mount(li, {});
        view = { li, lc };
        segViews.set(seg, view);
        historyEl.appendChild(li);
        appended = true;
      }
      // Actualización en lugar (ej. llega la traducción tarde): sin
      // re-append ni salto visual.
      view.lc.update({
        original: seg.original,
        translation: seg.translation,
        interim: seg.status === "interim",
        expected: store.target != null,
      });
    }

    // Scroll suave solo cuando entró un segmento nuevo; las actualizaciones
    // en lugar no deben mover nada.
    const grew = visible.length > lastHistoryCount;
    lastHistoryCount = visible.length;
    if (stick) {
      historyEl.scrollTo({
        top: historyEl.scrollHeight,
        behavior: appended && grew && smoothScroll() ? "smooth" : "auto",
      });
    }
    if (toLiveBtn && viewPlayer && !viewPlayer.hidden) {
      toLiveBtn.hidden = isNearBottom(historyEl) || !visible.length;
    }
  }

  function upsertCaption(cap) {
    // El modelo (validación, dedupe, agrupación, emparejado, recorte)
    // vive en captions.js.
    if (!store.apply(cap)) return;
    renderCurrent();
    renderHistory();
  }

  function disconnect() {
    connState = "closed";
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
    // Cambia la traducción mostrada, no "activa" la traducción: el socket
    // ya trae original + traducción (lang=all), así que no reconecta.
    currentTarget = langSelect.value || null;
    localStorage.setItem("simulcast.lang", langSelect.value);
    refreshLangs();
    stopCaptionUi(); // historial pertenece al idioma anterior
  });

  toLiveBtn.addEventListener("click", () => {
    historyEl.scrollTo({
      top: historyEl.scrollHeight,
      behavior: smoothScroll() ? "smooth" : "auto",
    });
  });

  historyEl.addEventListener("scroll", () => {
    toLiveBtn.hidden = isNearBottom(historyEl) || !store.segments.length;
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
