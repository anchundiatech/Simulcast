/* Simulcast captions model — pure logic, no DOM.
 *
 * Loaded by the program page as window.SimulcastCaptions (classic script)
 * and by the node:test suite via module.exports — same file, no deps.
 *
 * Model:
 *   current   — one live caption element updated in place (interim or the
 *               active final block).
 *   blocks[]  — confirmed final segments (oldest first), one timestamp per
 *               block, capped at maxHistory + 1 (the +1 is the active block).
 *   interim   → replaces `current`, never enters history, seals the active
 *               block; final is authoritative (replaces, never concatenates
 *               onto, the interim hypothesis of the same turn).
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimulcastCaptions = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Max rendered history blocks. */
  var MAX_HISTORY = 20;
  /** Max seconds between consecutive finals that still group into a block. */
  var GROUP_GAP_S = 6;

  /**
   * Joins two fragments of the same sentence without duplicating words:
   * cumulative text → the most complete wins; partial overlap → merge;
   * otherwise space-join.
   */
  function mergeText(prev, next) {
    var a = String(prev || "").trim();
    var b = String(next || "").trim();
    if (!b) return a;
    if (!a) return b;
    if (a === b) return a;
    if (b.indexOf(a) === 0) return b;
    if (a.indexOf(b) >= 0) return a;
    if (b.indexOf(a) >= 0) return b;
    var wa = a.split(/\s+/);
    var wb = b.split(/\s+/);
    for (var k = Math.min(wa.length, wb.length); k > 0; k--) {
      var tail = wa.slice(-k).join(" ").toLowerCase();
      var head = wb.slice(0, k).join(" ").toLowerCase();
      if (tail === head) return (a + " " + wb.slice(k).join(" ")).trim() || a;
    }
    return a + " " + b;
  }

  /** Creates an independent caption store (model-only; the caller renders). */
  function createStore(options) {
    var opts = options || {};
    var maxHistory = opts.maxHistory != null ? opts.maxHistory : MAX_HISTORY;
    var groupGapS = opts.groupGapS != null ? opts.groupGapS : GROUP_GAP_S;

    var blocks = [];
    /** id de evento → bloque (dedupe de finales repetidos). */
    var blockIndex = new Map();
    var current = null;
    var activeBlock = null;

    function findBlock(id) {
      if (!id || !blockIndex.has(id)) return null;
      var block = blockIndex.get(id);
      if (blocks.indexOf(block) >= 0) return block;
      blockIndex.delete(id); // already trimmed from history
      return null;
    }

    /** Resolves the block of a final: reuses it, groups it or opens a new one. */
    function blockForFinal(ev) {
      var existing = findBlock(ev.id);
      if (existing) {
        existing.text = mergeText(existing.text, ev.text);
        existing.lastT = ev.t;
        return existing;
      }
      var last = blocks[blocks.length - 1];
      var groupable =
        last && !last.sealed && last.lang === ev.lang && ev.t - last.lastT <= groupGapS;
      if (groupable) {
        last.text = mergeText(last.text, ev.text);
        last.lastT = ev.t;
        if (ev.id) blockIndex.set(ev.id, last);
        return last;
      }
      var block = {
        id: ev.id || "seg-" + ev.lang + "-" + Math.round(ev.t * 1000),
        lang: ev.lang,
        t: ev.t,
        lastT: ev.t,
        text: ev.text,
        sealed: false,
        el: null,
      };
      blocks.push(block);
      if (ev.id) blockIndex.set(ev.id, block);
      return block;
    }

    /** Caps history: keeps at most maxHistory rendered + the active block. */
    function trim() {
      while (blocks.length > maxHistory + 1) {
        var block = blocks.shift();
        if (!block) break;
        if (block.id) blockIndex.delete(block.id);
        if (activeBlock === block) activeBlock = null;
      }
    }

    /**
     * Applies one caption event to the model.
     * Returns false for events that change nothing (no render needed).
     */
    function apply(cap, fallbackLang) {
      if (!cap || typeof cap.text !== "string") return false;
      var text = cap.text.trim();
      if (!text) return false;
      var ev = {
        id: cap.id || "",
        lang: cap.lang || fallbackLang || "original",
        t: typeof cap.t === "number" ? cap.t : Date.now() / 1000,
        text: text,
      };

      if (cap.final) {
        // The final is authoritative: it replaces the interim, it does not
        // concatenate onto it (the interim is only a hypothesis of the turn).
        var block = blockForFinal(ev);
        current = { id: ev.id || block.id, lang: block.lang, text: block.text, interim: false };
        activeBlock = block;
      } else {
        // A new interim closes the previous utterance → it goes to history.
        if (activeBlock) {
          activeBlock.sealed = true;
          activeBlock = null;
        }
        current = { id: ev.id, lang: ev.lang, text: ev.text, interim: true };
      }
      trim();
      return true;
    }

    function reset() {
      blocks = [];
      blockIndex.clear();
      activeBlock = null;
      current = null;
    }

    return {
      apply: apply,
      reset: reset,
      get blocks() {
        return blocks;
      },
      get current() {
        return current;
      },
      get activeBlock() {
        return activeBlock;
      },
    };
  }

  return {
    MAX_HISTORY: MAX_HISTORY,
    GROUP_GAP_S: GROUP_GAP_S,
    mergeText: mergeText,
    createStore: createStore,
  };
});
