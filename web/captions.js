/* Simulcast captions model — pure logic, no DOM.
 *
 * Loaded by the program/overlay pages as window.SimulcastCaptions
 * (classic script) and by the node:test suite via module.exports —
 * same file, no deps.
 *
 * Model (bilingual segment as the unit — spec "Lineamiento de UI"):
 *   segments[] — all segments oldest first. The newest segment IS the
 *                current (live) caption; everything before it is history.
 *                Capped at maxHistory + 1 (history + current).
 *   current    — segments[segments.length - 1], or null when empty.
 *
 *   Segment:
 *     { id, t, lastT,
 *       original, translation,
 *       sourceLang, targetLang,
 *       status: "interim" | "final",
 *       ids: Set<event id> (dedupe of repeated finals) }
 *
 *   Event flow (CaptionEvent{session, lang, text, final, t, id}):
 *   interim(source) → updates the current caption in place (same id);
 *                     a new id seals the current segment and opens a new one.
 *   final(source)   → authoritative: replaces the interim hypothesis, never
 *                     concatenates onto it; consecutive finals ≤ groupGapS
 *                     group into the current segment; a later final opens a
 *                     new segment; duplicates (same id) update in place.
 *   final(target)   → attaches to the newest FINALIZED segment within
 *                     pairWindowS (the backend emits translation finals with
 *                     their own ids, so pairing is time/order-based, not
 *                     id-based). Translation never opens a visual event of
 *                     its own: it always enriches a bilingual segment.
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

  /** Max rendered history segments (the current one is kept on top). */
  var MAX_HISTORY = 20;
  /** Max seconds between consecutive finals that still group into a segment. */
  var GROUP_GAP_S = 6;
  /** Max age (s) of a segment for a translation final to pair with it. */
  var PAIR_WINDOW_S = 15;

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
    var pairWindowS = opts.pairWindowS != null ? opts.pairWindowS : PAIR_WINDOW_S;
    var sourceLang = opts.sourceLang || "original";
    var targetLang = opts.targetLang != null ? opts.targetLang : null;

    var segments = [];
    /** id de evento final → segmento (dedupe de finales repetidos). */
    var segIndex = new Map();

    function findSegment(id) {
      if (!id || !segIndex.has(id)) return null;
      var seg = segIndex.get(id);
      if (segments.indexOf(seg) >= 0) return seg;
      segIndex.delete(id); // already trimmed from history
      return null;
    }

    function pushSegment(seg) {
      segments.push(seg);
      if (seg.id) {
        segIndex.set(seg.id, seg);
        for (var extra of seg.ids) segIndex.set(extra, seg);
      }
      return seg;
    }

    function rememberId(seg, id) {
      if (!id) return;
      seg.ids.add(id);
      segIndex.set(id, seg);
    }

    /** Caps history: keeps at most maxHistory rendered + the current one. */
    function trim() {
      while (segments.length > maxHistory + 1) {
        var seg = segments.shift();
        if (!seg) break;
        if (seg.id) segIndex.delete(seg.id);
        for (var extra of seg.ids) segIndex.delete(extra);
      }
    }

    function current() {
      return segments.length ? segments[segments.length - 1] : null;
    }

    function newSegment(id, t) {
      return {
        id: id || "seg-" + Math.round(t * 1000) + "-" + segments.length,
        t: t,
        lastT: t,
        original: "",
        translation: "",
        sourceLang: sourceLang,
        targetLang: targetLang,
        status: "interim",
        ids: new Set(),
      };
    }

    /**
     * Applies a source-language event (usually "original").
     * Interim updates the current caption in place; final is authoritative.
     */
    function applySource(ev) {
      var cur = current();

      if (!ev.final) {
        if (cur) {
          if (cur.id === ev.id) {
            if (cur.status !== "interim") {
              // Stray interim for an already finalized segment: the final
              // is authoritative, so it must not regress the text.
              return false;
            }
            if (cur.original === ev.text) return false;
            cur.original = ev.text;
            cur.lastT = ev.t;
            trim();
            return true;
          }
          if (segIndex.has(ev.id)) {
            // Stale interim for a segment that already finalized in history.
            return false;
          }
        }
        // New utterance: the previous current moves to history and a new
        // current opens (the view reads "all but last" as history).
        var seg = newSegment(ev.id, ev.t);
        seg.original = ev.text;
        pushSegment(seg);
        trim();
        return true;
      }

      // --- final (authoritative) ---
      var known = findSegment(ev.id);
      if (known) {
        if (known.status === "interim") {
          // This final closes an open interim: it replaces the hypothesis,
          // never concatenates onto it.
          if (known.original === ev.text) {
            known.status = "final";
            known.lastT = ev.t;
            return true;
          }
          known.original = ev.text;
          known.status = "final";
          known.lastT = ev.t;
          rememberId(known, ev.id);
          trim();
          return true;
        }
        var dup = mergeText(known.original, ev.text);
        if (dup === known.original) return false;
        known.original = dup;
        known.lastT = ev.t;
        rememberId(known, ev.id);
        trim();
        return true;
      }
      if (cur && cur.status === "final" && ev.t - cur.lastT <= groupGapS) {
        // Consecutive final within the grouping window: same utterance.
        cur.original = mergeText(cur.original, ev.text);
        cur.lastT = ev.t;
        rememberId(cur, ev.id);
        trim();
        return true;
      }
      if (cur && cur.status === "interim") {
        // Final closes the open interim: replaces the hypothesis.
        cur.original = ev.text;
        cur.status = "final";
        cur.lastT = ev.t;
        cur.id = ev.id || cur.id;
        rememberId(cur, ev.id);
        trim();
        return true;
      }
      var fresh = newSegment(ev.id, ev.t);
      fresh.original = ev.text;
      fresh.status = "final";
      pushSegment(fresh);
      trim();
      return true;
    }

    /**
     * Applies a translation final to the newest finalized segment within
     * the pairing window. The backend gives translation finals their own
     * ids, so pairing is time/order-based: a translation belongs to the
     * utterance whose original already finalized. Translation-only events
     * are ignored — there is no translation without a segment yet (the
     * store only answers original/translation as one unit).
     */
    function applyTarget(ev) {
      if (!ev.final) {
        // The backend emits translation finals only; a (future) translation
        // interim must not create or disturb segments.
        return false;
      }
      for (var i = segments.length - 1; i >= 0; i--) {
        var seg = segments[i];
        if (ev.t - seg.t > pairWindowS) break;
        if (seg.status === "final") {
          var merged = mergeText(seg.translation, ev.text);
          if (merged === seg.translation) return false;
          seg.translation = merged;
          trim();
          return true;
        }
      }
      var cur = current();
      if (cur && ev.t - cur.t <= pairWindowS) {
        // Translation arrived before its original finalized (or no final
        // yet at all): keep it visible on the current caption.
        var joined = mergeText(cur.translation, ev.text);
        if (joined === cur.translation) return false;
        cur.translation = joined;
        trim();
        return true;
      }
      // Straggler beyond the window with no current utterance to hold it:
      // too old to pair honestly → drop it (no visual change).
      return false;
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
        lang: cap.lang || fallbackLang || sourceLang,
        t: typeof cap.t === "number" ? cap.t : Date.now() / 1000,
        text: text,
        final: !!cap.final,
      };

      if (ev.lang === sourceLang) return applySource(ev);
      if (targetLang && ev.lang === targetLang) return applyTarget(ev);
      return false;
    }

    /**
     * Reconfigures the language pair (no side effects: the caller decides
     * whether switching translation resets the store — e.g. a user-driven
     * change does, background polling does not).
     */
    function configure(pair) {
      if (!pair) return;
      if (pair.sourceLang) sourceLang = pair.sourceLang;
      if (pair.targetLang !== undefined) targetLang = pair.targetLang;
    }

    function reset() {
      segments = [];
      segIndex.clear();
    }

    return {
      apply: apply,
      reset: reset,
      configure: configure,
      get segments() {
        return segments;
      },
      get current() {
        return current();
      },
      get source() {
        return sourceLang;
      },
      get target() {
        return targetLang;
      },
    };
  }

  return {
    MAX_HISTORY: MAX_HISTORY,
    GROUP_GAP_S: GROUP_GAP_S,
    PAIR_WINDOW_S: PAIR_WINDOW_S,
    mergeText: mergeText,
    createStore: createStore,
  };
});
