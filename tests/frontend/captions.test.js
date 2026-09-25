/* Tests for web/captions.js — the bilingual captions model (segments with
 * original + translation, interim/final, dedupe, grouping, pairing,
 * history cap). Zero dependencies: node --test.
 *
 * Run: node --test "tests/frontend/*.test.js"
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const C = require("../../web/captions.js");

const ev = (over) => ({ id: "e1", lang: "original", t: 100, text: "hola", final: true, ...over });
const es = (text, over) => ({ id: "t1", lang: "es", t: 101, text, final: true, ...over });

// ---------------------------------------------------------------- mergeText

test("mergeText: cumulative text wins (no duplication)", () => {
  assert.equal(C.mergeText("hola", "hola mundo"), "hola mundo");
  assert.equal(C.mergeText("hola mundo", "hola"), "hola mundo");
  assert.equal(C.mergeText("abc", "abc"), "abc");
});

test("mergeText: partial overlap joins at the shared words", () => {
  assert.equal(C.mergeText("and so my", "fellow Americans"), "and so my fellow Americans");
  // shared tail/head of 2 words: "my fellow" — no words repeated
  assert.equal(C.mergeText("and so my", "my fellow americans"), "and so my fellow americans");
});

test("mergeText: unrelated fragments are joined with a space", () => {
  assert.equal(C.mergeText("uno", "dos"), "uno dos");
  assert.equal(C.mergeText("", "dos"), "dos");
  assert.equal(C.mergeText("uno", ""), "uno");
  assert.equal(C.mergeText("", ""), "");
});

// ------------------------------------------------------------------ interim

test("interim updates the same caption in place and opens no history", () => {
  const s = C.createStore();
  assert.equal(s.apply(ev({ final: false, text: "hola" })), true);
  assert.equal(s.apply(ev({ final: false, text: "hola mun" })), true);
  assert.equal(s.segments.length, 1);
  assert.equal(s.current, s.segments[0]);
  assert.equal(s.current.original, "hola mun");
  assert.equal(s.current.status, "interim");
  // history (everything but current) is empty
  assert.equal(s.segments.slice(0, -1).length, 0);
});

test("interim with a new id seals the previous segment into history", () => {
  const s = C.createStore();
  s.apply(ev({ id: "a", final: true, text: "primera frase" }));
  assert.equal(s.segments.length, 1);
  assert.equal(s.current, s.segments[0]);

  // new utterance → previous current moves to history, new current opens
  s.apply(ev({ id: "b", final: false, text: "segunda" }));
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments[0].original, "primera frase");
  assert.equal(s.segments[0].status, "final");
  assert.equal(s.current.original, "segunda");
  assert.equal(s.current.status, "interim");
});

test("stray interim for an already finalized segment is ignored", () => {
  const s = C.createStore();
  s.apply(ev({ id: "x", final: true, text: "cerrada" }));
  assert.equal(s.apply(ev({ id: "x", final: false, text: "cerrada?" })), false);
  assert.equal(s.current.original, "cerrada");
  assert.equal(s.current.status, "final");
});

test("stale interim for a history segment id is ignored", () => {
  const s = C.createStore();
  s.apply(ev({ id: "old", final: true, text: "vieja" }));
  s.apply(ev({ id: "new", final: false, text: "nueva" }));
  assert.equal(s.apply(ev({ id: "old", final: false, text: "vieja reenviada" })), false);
  assert.equal(s.segments.length, 2);
});

// ----------------------------------------------------- final authoritative

test("final replaces the interim of the same turn (never concatenates)", () => {
  const s = C.createStore();
  s.apply(ev({ id: "x", final: false, text: "And so my fellow" }));
  s.apply(ev({ id: "x", final: true, text: "And so, my fellow Americans, ask not" }));
  assert.equal(s.current.original, "And so, my fellow Americans, ask not");
  assert.equal(s.current.status, "final");
  assert.equal(s.segments.length, 1);
  // the interim text is not appended anywhere
  assert.ok(!s.current.original.includes("And so my fellow And"));
});

test("final with a new id while an interim is open closes it in place", () => {
  const s = C.createStore();
  s.apply(ev({ id: "y", final: false, text: "hola mu" }));
  s.apply(ev({ id: "z", final: true, text: "hola mundo cruel" }));
  assert.equal(s.segments.length, 1);
  assert.equal(s.current.original, "hola mundo cruel");
  assert.equal(s.current.status, "final");
});

// ------------------------------------------------------------------ dedupe

test("duplicate finals (same id) merge into one segment", () => {
  const s = C.createStore();
  s.apply(ev({ id: "d1", t: 100, text: "una frase" }));
  s.apply(ev({ id: "d1", t: 101, text: "una frase completa" }));
  assert.equal(s.segments.length, 1);
  assert.equal(s.segments[0].original, "una frase completa");
  assert.equal(s.current.original, "una frase completa");
  assert.equal(s.segments[0].lastT, 101);
});

test("identical duplicate finals change nothing", () => {
  const s = C.createStore();
  s.apply(ev({ id: "d1", t: 100, text: "una frase" }));
  assert.equal(s.apply(ev({ id: "d1", t: 101, text: "una frase" })), false);
});

test("a later final never rewrites the sealed history segment", () => {
  const s = C.createStore();
  s.apply(ev({ id: "s1", t: 100, text: "primera" }));
  s.apply(ev({ id: "s2", t: 101, final: false, text: "interim" })); // seals s1
  s.apply(ev({ id: "s3", t: 102, text: "segunda" }));
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments[0].original, "primera");
  assert.equal(s.segments[1].original, "segunda");
});

// ---------------------------------------------------------------- grouping

test("consecutive finals within the gap group into one segment", () => {
  const s = C.createStore();
  s.apply(ev({ id: "g1", t: 100, text: "fragmento uno." }));
  s.apply(ev({ id: "g2", t: 103, text: "fragmento dos." }));
  assert.equal(s.segments.length, 1);
  assert.equal(s.segments[0].original, "fragmento uno. fragmento dos.");
  assert.equal(s.segments[0].t, 100); // original timestamp kept
  assert.equal(s.segments[0].lastT, 103);
});

test("finals beyond the gap open a new segment", () => {
  const s = C.createStore(); // GROUP_GAP_S = 6
  s.apply(ev({ id: "g1", t: 100, text: "uno" }));
  s.apply(ev({ id: "g2", t: 107, text: "dos" }));
  assert.equal(s.segments.length, 2);
});

test("grouping window is configurable", () => {
  const s = C.createStore({ groupGapS: 2 });
  s.apply(ev({ id: "a", t: 100, text: "uno" }));
  s.apply(ev({ id: "b", t: 101, text: "dos" }));
  s.apply(ev({ id: "c", t: 104, text: "tres" }));
  assert.equal(s.segments.length, 2); // 100-101 grouped, 104 separate
});

// ------------------------------------------------- translation pairing

test("translation final attaches to the current finalized segment", () => {
  const s = C.createStore({ targetLang: "es" });
  s.apply(ev({ id: "o1", t: 100, text: "hello everyone" }));
  assert.equal(s.apply(es("hola a todos", { t: 101 })), true);
  assert.equal(s.segments.length, 1);
  assert.equal(s.current.original, "hello everyone");
  assert.equal(s.current.translation, "hola a todos");
});

test("translation attaches to the history segment when a new interim is current", () => {
  const s = C.createStore({ targetLang: "es" });
  s.apply(ev({ id: "o1", t: 100, text: "first sentence" }));
  s.apply(ev({ id: "o2", t: 104, final: false, text: "second sent" }));
  // translation for the FIRST utterance arrives while the second is interim
  s.apply(es("primera frase", { t: 105 }));
  assert.equal(s.segments[0].translation, "primera frase");
  assert.equal(s.current.original, "second sent");
  assert.equal(s.current.translation, "");
});

test("translations merge into a grouped segment", () => {
  const s = C.createStore({ targetLang: "es" });
  s.apply(ev({ id: "o1", t: 100, text: "fragment one." }));
  s.apply(es("fragmento uno.", { t: 100.5 }));
  s.apply(ev({ id: "o2", t: 103, text: "fragment two." }));
  s.apply(es("fragmento dos.", { t: 103.5 }));
  assert.equal(s.segments.length, 1);
  assert.equal(s.current.original, "fragment one. fragment two.");
  assert.equal(s.current.translation, "fragmento uno. fragmento dos.");
});

test("translation events are ignored when no target is configured", () => {
  const s = C.createStore();
  assert.equal(s.apply(es("hola", { t: 100 })), false);
  assert.equal(s.segments.length, 0);
});

test("events of other languages are ignored", () => {
  const s = C.createStore({ targetLang: "es" });
  assert.equal(s.apply(ev({ id: "p1", lang: "pt", text: "olá" })), false);
  assert.equal(s.segments.length, 0);
});

test("translation interim events never disturb segments", () => {
  const s = C.createStore({ targetLang: "es" });
  assert.equal(s.apply(es("hola", { final: false })), false);
  assert.equal(s.segments.length, 0);
});

test("straggler translation beyond the pairing window is dropped", () => {
  const s = C.createStore({ targetLang: "es" });
  s.apply(ev({ id: "o1", t: 100, text: "old sentence" }));
  // 60s later: too old to pair honestly → no change at all
  assert.equal(s.apply(es("frase vieja", { t: 160 })), false);
  assert.equal(s.segments.length, 1);
  assert.equal(s.segments[0].translation, "");
});

test("source language is configurable (single-language overlay mode)", () => {
  const s = C.createStore({ sourceLang: "es" });
  s.apply({ id: "x", lang: "es", t: 100, text: "solo español", final: true });
  assert.equal(s.current.original, "solo español");
  // "original" events are not the configured source → ignored
  assert.equal(s.apply(ev({ id: "y", t: 101, text: "english" })), false);
  assert.equal(s.segments.length, 1);
});

// ------------------------------------------------------------------- cap

test("history is capped: rendered ≤ maxHistory, current kept", () => {
  const s = C.createStore({ maxHistory: 3 });
  for (let i = 0; i < 10; i++) {
    s.apply(ev({ id: `f${i}`, t: 100 + i * 10, text: `frase ${i}` }));
  }
  // segments = cap + 1 (the current segment is part of segments)
  assert.equal(s.segments.length, 4);
  assert.equal(s.segments[0].original, "frase 6"); // oldest dropped
  assert.equal(s.current.original, "frase 9"); // newest is current
});

test("default cap is 20 rendered segments", () => {
  const s = C.createStore();
  for (let i = 0; i < 50; i++) {
    s.apply(ev({ id: `f${i}`, t: 100 + i * 10, text: `frase ${i}` }));
  }
  assert.equal(s.segments.length, C.MAX_HISTORY + 1);
  assert.equal(C.MAX_HISTORY, 20);
});

// ------------------------------------------------------------- validation

test("invalid events are rejected without touching the model", () => {
  const s = C.createStore();
  assert.equal(s.apply(null), false);
  assert.equal(s.apply({}), false);
  assert.equal(s.apply({ text: "   " }), false);
  assert.equal(s.apply({ text: 42 }), false);
  assert.equal(s.current, null);
  assert.equal(s.segments.length, 0);
});

test("normalization: missing lang/t/id", () => {
  const s = C.createStore({ targetLang: "es" });
  assert.equal(s.apply({ text: "hola", final: true }), true);
  assert.equal(s.current.original, "hola");
  // segments get generated ids and timestamps
  assert.ok(s.segments[0].id.startsWith("seg-"));
  assert.ok(Number.isFinite(s.segments[0].t));
});

test("configure switches the language pair without side effects", () => {
  const s = C.createStore();
  s.apply(ev({ id: "o1", t: 100, text: "hello" }));
  s.configure({ targetLang: "es" });
  assert.equal(s.segments.length, 1); // nothing reset
  s.apply(es("hola", { t: 101 }));
  assert.equal(s.current.translation, "hola");
});

test("reset clears current, segments and index", () => {
  const s = C.createStore({ targetLang: "es" });
  s.apply(ev({ id: "r1", text: "algo" }));
  s.apply(es("algo traducido", { t: 101 }));
  s.reset();
  assert.equal(s.current, null);
  assert.equal(s.segments.length, 0);
  // after reset, a recycled id behaves as brand new
  assert.equal(s.apply(ev({ id: "r1", text: "de nuevo" })), true);
  assert.equal(s.segments.length, 1);
});

test("stores are independent from each other", () => {
  const a = C.createStore();
  const b = C.createStore();
  a.apply(ev({ text: "solo en a" }));
  assert.equal(b.current, null);
  assert.equal(b.segments.length, 0);
});
