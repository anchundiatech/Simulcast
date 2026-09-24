/* Simulcast operator UI: session CRUD + browser audio share (multi-session) */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const apiBadge = $("#apiBadge");
  const sessionsTable = $("#sessionsTable").querySelector("tbody");
  const ingestSessions = $("#ingestSessions");
  const startBtn = $("#startBtn");
  const stopBtn = $("#stopBtn");
  const statSent = $("#statSent");
  const statChunks = $("#statChunks");
  const statWs = $("#statWs");
  const statSes = $("#statSes");
  const audioMeter = $("#audioMeter");
  const ingestError = $("#ingestError");

  let sessions = [];
  /** @type {Map<string, WebSocket>} sid → ws */
  const sockets = new Map();
  let audioCtx = null;
  let workletNode = null;
  let mediaStream = null;
  let sourceNode = null;
  let sending = false;
  let bytesSent = 0;
  let chunksSent = 0;
  /** Checked session ids that survive re-renders. */
  const checked = new Set();
  /** First session id when sharing started (for the audience link). */
  let primarySid = null;

  const TARGET_RATE = 16000;

  async function refresh() {
    try {
      const [hres, sres] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/sessions"),
      ]);
      const health = await hres.json();
      const data = await sres.json();
      sessions = data.sessions || [];
      apiBadge.textContent = health.gemini_configured
        ? `api ok · ${health.live_sessions}/${health.sessions} live`
        : "api sin GEMINI_API_KEY";
      apiBadge.className = `badge ${health.gemini_configured ? "badge-on" : "badge-err"}`;
      renderTable();
      renderIngestOptions();
    } catch (e) {
      apiBadge.textContent = "api offline";
      apiBadge.className = "badge badge-err";
    }
  }

  function renderTable() {
    sessionsTable.innerHTML = "";
    for (const s of sessions) {
      const tr = document.createElement("tr");
      const workers = Object.entries(s.workers || {})
        .map(
          ([k, w]) =>
            `<span class="pill ${w.connected ? "live" : w.last_error ? "err" : "warn"}">${k}${w.connected ? " ●" : w.last_error ? " ✕" : " …"}</span>`
        )
        .join(" ");
      const errors = Object.values(s.workers || {})
        .map((w) => w.last_error)
        .filter(Boolean)
        .join("; ");
      const sharing = sockets.has(s.config.id) ? ` <span class="ico" title="recibiendo audio">▶</span>` : "";
      tr.innerHTML = `
        <td><strong>${esc(s.config.name)}</strong><br><span class="pill">${esc(s.config.id)}</span></td>
        <td>${esc(s.config.source_language)}</td>
        <td>${(s.config.output_languages || []).map(esc).join(", ")}</td>
        <td><span class="pill ${s.status === "live" ? "live" : s.status === "error" || s.status === "degraded" ? "err" : "warn"}">${esc(s.status)}</span></td>
        <td>${s.ingest?.active ? `<span class="ico">●</span> ${esc(s.ingest.kind)}${sharing}` : `<span class="ico">○</span> inactivo`}</td>
        <td>${workers || "—"}</td>
        <td>${s.viewers ?? 0}</td>
        <td class="cell-icon" title="${esc(errors)}">${errors ? "⚠" : "—"}</td>
        <td>
          <a class="btn ghost" href="/program?session=${encodeURIComponent(s.config.id)}" target="_blank">Ver</a>
          <button class="btn ghost icon" data-del="${esc(s.config.id)}" title="Eliminar sesión" aria-label="Eliminar sesión"><span class="ico">✕</span></button>
        </td>`;
      sessionsTable.appendChild(tr);
    }
    sessionsTable.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Eliminar sesión?")) return;
        await fetch(`/api/sessions/${btn.dataset.del}`, { method: "DELETE" });
        refresh();
      });
    });
  }

  function renderIngestOptions() {
    // Drop checks for sessions that no longer exist.
    for (const sid of [...checked]) {
      if (!sessions.some((s) => s.config.id === sid)) checked.delete(sid);
    }
    ingestSessions.innerHTML = "";
    if (!sessions.length) {
      ingestSessions.innerHTML = `<span class="empty">No hay sesiones — creá una arriba.</span>`;
      updateViewLink();
      return;
    }
    for (const s of sessions) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = s.config.id;
      cb.checked = checked.has(s.config.id) || sockets.has(s.config.id);
      cb.addEventListener("change", () => {
        if (cb.checked) checked.add(cb.value);
        else checked.delete(cb.value);
        updateViewLink();
        updateSessionStat();
      });
      const span = document.createElement("span");
      span.textContent = `${s.config.name} (${s.config.id})`;
      label.appendChild(cb);
      label.appendChild(span);
      ingestSessions.appendChild(label);
    }
    updateViewLink();
    updateSessionStat();
  }

  function selectedSessions() {
    return [...checked].filter((sid) => sessions.some((s) => s.config.id === sid));
  }

  function updateViewLink() {
    const first = selectedSessions()[0] || primarySid;
    $("#viewLink").href = first ? `/program?session=${encodeURIComponent(first)}` : "/program";
  }

  function updateSessionStat() {
    const n = sending ? sockets.size : selectedSessions().length;
    statSes.textContent = sending ? `${n} en vivo` : String(n);
  }

  function updateWsStat() {
    if (!sending) {
      statWs.textContent = "idle";
      return;
    }
    const ok = [...sockets.values()].filter((w) => w.readyState === 1).length;
    const total = sockets.size;
    statWs.textContent = ok === total ? `conectado (${ok})` : `${ok}/${total} ok`;
  }

  $("#createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#fName").value.trim();
    const id = $("#fId").value.trim() || undefined;
    const source = $("#fSource").value;
    const target = $("#fTarget").value;
    const outputs = target === "none" ? ["original"] : ["original", target];
    const body = { name, source_language: source, output_languages: outputs };
    if (id) body.id = id;
    const existing = id && sessions.some((s) => s.config.id === id);
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok && existing) {
      await fetch(`/api/sessions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else if (!res.ok) {
      alert(await res.text());
      return;
    }
    e.target.reset();
    refresh();
  });

  $("#refreshBtn").addEventListener("click", refresh);
  setInterval(refresh, 4000);

  // ---------------------------------------------------------------- audio

  startBtn.addEventListener("click", async () => {
    ingestError.hidden = true;
    const sids = selectedSessions();
    if (!sids.length) {
      showError("Elegí al menos una sesión");
      return;
    }
    try {
      // Prefer tab audio; fall back to microphone.
      mediaStream = await navigator.mediaDevices
        .getDisplayMedia({ video: true, audio: true })
        .catch(async (err) => {
          if (err && err.name === "NotAllowedError") {
            return navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true },
            });
          }
          throw err;
        });

      // If display media gave no audio track, request mic as well.
      if (!mediaStream.getAudioTracks().length) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        mediaStream.getAudioTracks().forEach((t) => mediaStream.addTrack(t));
        mic.getTracks().forEach((t) => t.stop());
      }
      if (!mediaStream.getAudioTracks().length) {
        throw new Error("No se obtuvo pista de audio");
      }

      audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);

      // Downsample / mono-mix via ScriptProcessor (universally available).
      workletNode = audioCtx.createScriptProcessor(4096, 1, 1);
      const pcmQueue = [];

      workletNode.onaudioprocess = (e) => {
        if (!sending) return;
        const input = e.inputBuffer.getChannelData(0);
        // Float32 → Int16 LE
        const out = new Int16Array(input.length);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          sum += s * s;
        }
        const rms = Math.sqrt(sum / input.length);
        audioMeter.style.width = `${Math.min(100, rms * 400)}%`;
        pcmQueue.push(new Uint8Array(out.buffer));
        flushPcm(pcmQueue);
      };

      // Keep processor alive (not connected to destination → no feedback).
      const silent = audioCtx.createGain();
      silent.gain.value = 0;
      sourceNode.connect(workletNode);
      workletNode.connect(silent);
      silent.connect(audioCtx.destination);

      primarySid = sids[0];
      sending = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      for (const sid of sids) connectIngestWs(sid);
      updateViewLink();
      updateSessionStat();
      updateWsStat();
    } catch (err) {
      sending = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      showError(String(err?.message || err));
      teardownAudio();
    }
  });

  let ingestBuffer = new Uint8Array(0);
  function flushPcm(queue) {
    while (queue.length) {
      const chunk = queue.shift();
      const merged = new Uint8Array(ingestBuffer.length + chunk.length);
      merged.set(ingestBuffer);
      merged.set(chunk, ingestBuffer.length);
      ingestBuffer = merged;
    }
    const frameBytes = 3200; // 100 ms
    const open = [...sockets.values()].filter((w) => w.readyState === 1);
    while (ingestBuffer.length >= frameBytes && open.length) {
      const frame = ingestBuffer.subarray(0, frameBytes);
      // Fan-out the same PCM frame to every selected session.
      for (const w of open) {
        try {
          w.send(frame);
        } catch {
          /* socket died; stats updated elsewhere */
        }
      }
      ingestBuffer = ingestBuffer.slice(frameBytes);
      bytesSent += frame.length;
      chunksSent += 1;
      statSent.textContent = `${(bytesSent / 1048576).toFixed(2)} MB`;
      statChunks.textContent = String(chunksSent);
    }
    // No open sockets → drop buffer so we don't grow unbounded.
    if (!open.length && ingestBuffer.length > frameBytes * 50) {
      ingestBuffer = new Uint8Array(0);
    }
  }

  function connectIngestWs(sid) {
    if (sockets.has(sid)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/ingest/${sid}`);
    ws.binaryType = "arraybuffer";
    sockets.set(sid, ws);

    ws.onopen = () => {
      // Stop video tracks once (only needed at capture start).
      if (mediaStream) mediaStream.getVideoTracks().forEach((t) => t.stop());
      updateWsStat();
      updateSessionStat();
      renderTable();
    };
    ws.onclose = () => {
      sockets.delete(sid);
      updateWsStat();
      updateSessionStat();
      renderTable();
      // Every socket gone while we thought we were live → full stop.
      if (sending && sockets.size === 0) stopIngest();
    };
    ws.onerror = () => {
      updateWsStat();
      showError(`No se pudo enviar el audio a «${sid}»`);
    };
  }

  stopBtn.addEventListener("click", stopIngest);

  function teardownAudio() {
    try {
      workletNode && workletNode.disconnect();
      sourceNode && sourceNode.disconnect();
      audioCtx && audioCtx.close();
    } catch {}
    workletNode = sourceNode = audioCtx = null;
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    ingestBuffer = new Uint8Array(0);
  }

  function stopIngest() {
    sending = false;
    for (const w of sockets.values()) {
      try {
        w.close();
      } catch {}
    }
    sockets.clear();
    teardownAudio();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statWs.textContent = "idle";
    statSes.textContent = String(selectedSessions().length);
    audioMeter.style.width = "0%";
    renderTable();
  }

  function showError(msg) {
    ingestError.hidden = false;
    ingestError.textContent = msg;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  refresh();
})();
