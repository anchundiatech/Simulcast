/* Simulcast landing interactions — light, no dependencies, reduced-motion aware. */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------ mobile nav */
  const navToggle = $("#navToggle");
  const navLinks = $("#navLinks");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
    });
    navLinks.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        navLinks.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ------------------------------------------------ live clock (hero player) */
  const clock = $("#lsClock");
  if (clock && !reduced) {
    let secs = 1 * 3600 + 24 * 60 + 38;
    setInterval(() => {
      secs += 1;
      const h = String(Math.floor(secs / 3600)).padStart(2, "0");
      const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
      const s = String(secs % 60).padStart(2, "0");
      clock.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  /* ------------------------------------------------ latency jitter */
  const latencyEls = ["#lsLatency", "#lsLatency2", "#lsLatency3"]
    .map((sel) => $(sel))
    .filter(Boolean);
  if (latencyEls.length && !reduced) {
    setInterval(() => {
      const base = latencyEls[0].id === "lsLatency2" ? 380 : 420;
      const v = base + Math.round((Math.random() - 0.5) * 70);
      latencyEls.forEach((el) => {
        el.textContent = el.id === "lsLatency2" ? Math.min(v, 420) : v;
      });
    }, 2400);
  }

  /* ------------------------------------------------ typewriter helper */
  function typeLoop(el, text, { speed = 42, hold = 2600 } = {}) {
    if (!el) return;
    if (reduced) {
      el.textContent = text;
      return;
    }
    let i = 0;
    el.textContent = "";
    el.classList.add("typing");
    const tick = () => {
      i += 1;
      el.textContent = text.slice(0, i);
      if (i < text.length) {
        setTimeout(tick, speed + Math.random() * 40);
      } else {
        el.classList.remove("typing");
        setTimeout(() => {
          i = 0;
          el.textContent = "";
          el.classList.add("typing");
          tick();
        }, hold);
      }
    };
    tick();
  }

  /* Hero captions: EN then ES, staggered */
  const heroCaps = $$("[data-typed-hero]");
  if (heroCaps[0]) {
    typeLoop(heroCaps[0], heroCaps[0].dataset.typedHero, { speed: 38, hold: 5200 });
  }
  if (heroCaps[1]) {
    setTimeout(
      () => typeLoop(heroCaps[1], heroCaps[1].dataset.typedHero, { speed: 34, hold: 5200 }),
      900,
    );
  }

  /* ------------------------------------------------ live demo typing */
  const demoOrig = $("#demoOrig");
  const demoEs = $("#demoEs");
  const DEMO_ORIG =
    "Welcome everyone to today's conference. We're going to talk about the future of open source technology.";
  const DEMO_ES =
    "Bienvenidos a la conferencia de hoy. Hablaremos sobre el futuro de la tecnología open source.";

  if (demoOrig && demoEs && !reduced) {
    demoOrig.textContent = "";
    demoEs.textContent = "";
    let i = 0;
    const step = () => {
      i += 1;
      demoOrig.textContent = DEMO_ORIG.slice(0, i);
      // Spanish trails the original by ~8 chars to mimic live translation.
      demoEs.textContent = DEMO_ES.slice(0, Math.max(0, i - 8));
      if (i <= DEMO_ORIG.length) {
        setTimeout(step, 34);
      } else {
        demoEs.textContent = DEMO_ES;
        setTimeout(() => {
          i = 0;
          demoOrig.textContent = "";
          demoEs.textContent = "";
          step();
        }, 3800);
      }
    };
    // Start only when the section is near the viewport.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            step();
          }
        },
        { rootMargin: "120px" },
      );
      io.observe(demoOrig.closest(".ls-demo") || demoOrig);
    } else {
      step();
    }
  }

  /* ------------------------------------------------ audience language tabs */
  const CAPTIONS = {
    original: "Welcome to the conference. Today we're going to talk about open source technology.",
    es: "Bienvenidos a la conferencia. Hoy vamos a hablar sobre tecnología open source.",
    en: "Welcome to the conference. Today we're going to talk about open source technology.",
    pt: "Boas-vindas à conferência. Hoje vamos falar sobre tecnologia open source.",
  };
  const audCaption = $("#audCaption");
  const tabs = $$(".ls-lang-tabs button");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      });
      if (audCaption) audCaption.textContent = CAPTIONS[btn.dataset.lang] || CAPTIONS.es;
    });
  });
})();
