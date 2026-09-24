/* Simulcast operator UI: session CRUD + browser audio ingest */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const apiBadge = $("#apiBadge");
  const sessionsTable = $("#sessionsTable").querySelector("tbody");
  const ingestSession = $("#ingestSession");
  const startBtn = $("#startBtn");
  const stopBtn = $("#stopBtn");
  const statSent = $("#statSent");
  const statChunks = $("#statChunks");
  const statWs = $("#statWs");
  const audioMeter = $("#audioMeter");
  const ingestError = $("#ingestError");

  let sessions = [];
  let ws = null;
  let audioCtx = null;
  let workletNode = null;
  let mediaStream = null;
  let sourceNode = null;
  let sending = false;
  let bytesSent = 0;
  let chunksSent = 0;

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
      tr.innerHTML = `
        <td><strong>${esc(s.config.name)}</strong><br><span class="pill">${esc(s.config.id)}</span></td>
        <td>${esc(s.config.source_language)}</td>
        <td>${(s.config.output_languages || []).map(esc).join(", ")}</td>
        <td><span class="pill ${s.status === "live" ? "live" : s.status === "error" || s.status === "degraded" ? "err" : "warn"}">${esc(s.status)}</span></td>
        <td>${s.ingest?.active ? `● ${esc(s.ingest.kind)}` : "○ inactivo"}</td>
        <td>${workers || "—"}</td>
        <td>${s.viewers ?? 0}</td>
        <td title="${esc(errors)}">${errors ? "⚠" : "—"}</td>
        <td>
          <a class="btn ghost" href="/?session=${encodeURIComponent(s.config.id)}" target="_blank">Ver</a>
          <button class="btn ghost" data-del="${esc(s.config.id)}">✕</button>
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
    const prev = ingestSession.value;
    ingestSession.innerHTML = "";
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.config.id;
      opt.textContent = `${s.config.name} (${s.config.id})`;
      ingestSession.appendChild(opt);
    }
    if (prev && sessions.some((s) => s.config.id === prev)) ingestSession.value = prev;
    $("#viewLink").href = ingestSession.value
      ? `/?session=${encodeURIComponent(ingestSession.value)}`
      : "/";
  }

  ingestSession.addEventListener("change", () => {
    $("#viewLink").href = `/?session=${encodeURIComponent(ingestSession.value)}`;
  });

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

  // ---------------------------------------------------------------- ingest

  startBtn.addEventListener("click", async () => {
    ingestError.hidden = true;
    const sid = ingestSession.value;
    if (!sid) {
      showError("Elegí una sesión");
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
      // Buffer 2048 samples ≈ 128 ms — we forward in ~100 ms PCM frames.
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
        // Flush when we have >= 1600 bytes (100 ms @ 16k s16le mono).
        flushPcm(pcmQueue);
      };

      // Keep processor alive (not connected to destination → no feedback).
      const silent = audioCtx.createGain();
      silent.gain.value = 0;
      sourceNode.connect(workletNode);
      workletNode.connect(silent);
      silent.connect(audioCtx.destination);

      connectIngestWs(sid);
    } catch (err) {
      showError(String(err?.message || err));
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
    while (ingestBuffer.length >= frameBytes && ws && ws.readyState === 1) {
      const frame = ingestBuffer.subarray(0, frameBytes);
      ingestBuffer = ingestBuffer.slice(frameBytes);
      ws.send(frame);
      bytesSent += frame.length;
      chunksSent += 1;
      statSent.textContent = `${(bytesSent / 1048576).toFixed(2)} MB`;
      statChunks.textContent = String(chunksSent);
    }
  }

  function connectIngestWs(sid) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/ingest/${sid}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      sending = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statWs.textContent = "conectado";
      // Stop video tracks (we only need audio).
      mediaStream.getVideoTracks().forEach((t) => t.stop());
    };
    ws.onclose = () => {
      statWs.textContent = "cerrado";
      if (sending) stopIngest();
    };
    ws.onerror = () => {
      statWs.textContent = "error";
      showError("No se pudo enviar el audio");
    };
  }

  stopBtn.addEventListener("click", stopIngest);

  function stopIngest() {
    sending = false;
    try {
      ws && ws.close();
    } catch {}
    ws = null;
    try {
      workletNode && workletNode.disconnect();
      sourceNode && sourceNode.disconnect();
      audioCtx && audioCtx.close();
    } catch {}
    workletNode = sourceNode = audioCtx = null;
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    ingestBuffer = new Uint8Array(0);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statWs.textContent = "idle";
    audioMeter.style.width = "0%";
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
