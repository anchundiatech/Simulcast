/* Simulcast production monitor — polls /api/monitor and streams /ws/monitor. */

(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    mode: "ws", // "ws" | number seconds | "0" paused
    ws: null,
    pollTimer: null,
    clockTimer: null,
    lastSnapshot: null,
  };

  function fmtUptime(s) {
    if (s == null) return "—";
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function fmtAge(s) {
    if (s == null) return "—";
    if (s < 1) return `${Math.round(s * 1000)} ms`;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  }

  function fmtMs(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function fmtClock(t) {
    const d = t ? new Date(t * 1000) : new Date();
    return d.toLocaleTimeString();
  }

  function statusPill(status) {
    const map = {
      live: "live",
      starting: "warn",
      degraded: "err",
      error: "err",
      stopped: "",
      idle: "",
    };
    const cls = map[status] ?? "";
    return `<span class="pill ${cls}">${status}</span>`;
  }

  function ingestCell(ing) {
    if (!ing || !ing.active) return `<span class="pill">off</span>`;
    const kind = ing.kind || "?";
    const age = ing.last_chunk_at ? fmtAge(Date.now() / 1000 - ing.last_chunk_at) : "—";
    return `<span class="pill live">${kind}</span> <span class="muted-num">${age}</span>`;
  }

  function workersCell(workers) {
    const list = Object.values(workers || {});
    if (!list.length) return `<span class="pill">—</span>`;
    return list
      .map((w) => {
        const cls = w.connected ? "live" : w.last_error ? "err" : "warn";
        const label = `${w.track}${w.connected ? "" : " ✕"}`;
        const title = w.last_error
          ? ` title="${String(w.last_error).replace(/"/g, "&quot;")}"`
          : "";
        return `<span class="pill ${cls}"${title}>${label}</span>`;
      })
      .join(" ");
  }

  function renderKpis(data) {
    $("kUptime").textContent = fmtUptime(data.uptime_s);
    $("kLive").textContent = `${data.sessions_live ?? 0} / ${data.sessions_total ?? 0}`;
    const deg = data.sessions_degraded ?? 0;
    $("kDegraded").textContent = String(deg);
    $("kDegraded").classList.toggle("bad", deg > 0);
    $("kRate").textContent = String(data.captions_per_min ?? 0);
    $("kTotal").textContent = String(data.captions_total ?? 0);
    const err = data.errors_total ?? 0;
    $("kErrors").textContent = String(err);
    $("kErrors").classList.toggle("bad", err > 0);
    $("kGemini").textContent = data.gemini_configured ? "ok" : "MISSING";
    $("kGemini").classList.toggle("bad", !data.gemini_configured);
  }

  function renderSessions(sessions) {
    const grid = $("sessionGrid");
    if (!sessions || !sessions.length) {
      grid.innerHTML = `<p class="hint">No hay sesiones creadas. Creá una en <a href="/operator">Operación</a>.</p>`;
      return;
    }
    grid.innerHTML = sessions
      .map((s) => {
        const m = s.metrics || {};
        const workers = Object.values(s.workers || {});
        const reconnects = workers.reduce((a, w) => a + (w.reconnects || 0), 0);
        const queue = workers.reduce((a, w) => a + (w.audio_queue || 0), 0);
        const errs = workers.filter((w) => w.last_error);
        const errHtml = errs.length
          ? `<p class="error">${errs
              .map((w) => `${w.track}: ${escapeHtml(w.last_error)}`)
              .join("<br>")}</p>`
          : "";
        return `
        <article class="mon-card ${s.status === "live" ? "on" : s.status === "degraded" || s.status === "error" ? "bad" : ""}">
          <header class="mon-card-h">
            <div>
              <strong>${escapeHtml(s.config?.name || s.config?.id)}</strong>
              <span class="muted-num">${escapeHtml(s.config?.id || "")}</span>
            </div>
            ${statusPill(s.status)}
          </header>
          <dl class="mon-stats">
            <div><dt>Ingesta</dt><dd>${ingestCell(s.ingest)}</dd></div>
            <div><dt>Workers</dt><dd>${workersCell(s.workers)}</dd></div>
            <div><dt>Espectadores</dt><dd>${s.viewers ?? 0}</dd></div>
            <div><dt>Captions/min</dt><dd>${m.captions_per_min ?? 0}</dd></div>
            <div><dt>Finales/min</dt><dd>${m.finals_per_min ?? 0}</dd></div>
            <div><dt>Latencia (EMA)</dt><dd>${fmtMs(m.latency_ms)}</dd></div>
            <div><dt>Últ. caption</dt><dd>${fmtAge(m.last_caption_age_s)}</dd></div>
            <div><dt>Audio fresco</dt><dd>${fmtAge(m.audio_age_s)}</dd></div>
            <div><dt>Totales</dt><dd>${m.captions_total ?? 0} (${m.finals_total ?? 0} fin.)</dd></div>
            <div><dt>Reconex.</dt><dd>${reconnects}</dd></div>
            <div><dt>Cola audio</dt><dd>${queue}</dd></div>
            <div><dt>Uptime</dt><dd>${fmtUptime(m.uptime_s)}</dd></div>
            <div><dt>Errores</dt><dd>${m.errors_total ?? 0}</dd></div>
            <div><dt>Origen</dt><dd>${escapeHtml(s.config?.source_language || "auto")} → ${(s.config?.output_languages || []).join(", ")}</dd></div>
          </dl>
          ${errHtml}
          <footer class="mon-card-f">
            <a class="btn ghost" href="/?session=${encodeURIComponent(s.config?.id || "")}" target="_blank">Audiencia</a>
            <a class="btn ghost" href="/operator">Operar</a>
            <a class="btn ghost" href="/overlay?session=${encodeURIComponent(s.config?.id || "")}&langs=original,es" target="_blank">Overlay</a>
          </footer>
        </article>`;
      })
      .join("");
  }

  function renderErrors(errors) {
    const tbody = $("errorsTable").querySelector("tbody");
    const empty = $("errorsEmpty");
    if (!errors || !errors.length) {
      tbody.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = errors
      .map(
        (e) => `<tr>
          <td>${fmtClock(e.t)}</td>
          <td><code>${escapeHtml(e.session)}</code></td>
          <td>${escapeHtml(e.source)}</td>
          <td>${escapeHtml(e.message)}</td>
        </tr>`,
      )
      .join("");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function applySnapshot(data) {
    if (!data) return;
    state.lastSnapshot = data;
    renderKpis(data);
    renderSessions(data.sessions);
    renderErrors(data.recent_errors);
    $("apiBadge").textContent = "api ok";
    $("apiBadge").className = "badge badge-on";
    $("clock").textContent = fmtClock();
  }

  function applyStateMessage(msg) {
    // Merge single-session state into last snapshot and re-render sessions only.
    if (!state.lastSnapshot || !msg?.state) return;
    const sessions = state.lastSnapshot.sessions || [];
    const idx = sessions.findIndex((s) => s.config?.id === msg.session);
    if (idx >= 0) {
      sessions[idx] = msg.state;
      renderSessions(sessions);
    }
  }

  async function fetchMonitor() {
    try {
      const r = await fetch("/api/monitor");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      applySnapshot(await r.json());
    } catch (err) {
      $("apiBadge").textContent = "api err";
      $("apiBadge").className = "badge badge-off";
      console.warn("monitor fetch failed", err);
    }
  }

  function closeWs() {
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_) {
        /* ignore */
      }
      state.ws = null;
    }
  }

  function connectWs() {
    closeWs();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/monitor`);
    state.ws = ws;

    ws.onopen = () => {
      $("connBadge").textContent = "ws live";
      $("connBadge").className = "badge badge-on";
    };
    ws.onclose = () => {
      $("connBadge").textContent = "ws off";
      $("connBadge").className = "badge badge-off";
      if (state.mode === "ws") {
        setTimeout(connectWs, 2000);
      }
    };
    ws.onerror = () => {
      $("connBadge").textContent = "ws err";
      $("connBadge").className = "badge badge-off";
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        applySnapshot(msg);
      } else if (msg.type === "state") {
        applyStateMessage(msg);
      }
    };
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function applyMode() {
    const mode = $("refreshMode").value;
    state.mode = mode;
    stopPoll();
    closeWs();
    if (mode === "ws") {
      connectWs();
    } else if (mode === "0") {
      $("connBadge").textContent = "pausado";
      $("connBadge").className = "badge badge-off";
    } else {
      const sec = parseInt(mode, 10) || 5;
      $("connBadge").textContent = `poll ${sec}s`;
      $("connBadge").className = "badge badge-on";
      fetchMonitor();
      state.pollTimer = setInterval(fetchMonitor, sec * 1000);
    }
  }

  $("refreshBtn").addEventListener("click", fetchMonitor);
  $("refreshMode").addEventListener("change", applyMode);

  state.clockTimer = setInterval(() => {
    $("clock").textContent = fmtClock();
  }, 1000);

  applyMode();
  fetchMonitor();
})();
