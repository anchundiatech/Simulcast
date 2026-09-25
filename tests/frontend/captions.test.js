/* Tests for web/captions.js — the pure captions model (interim/final,
 * dedupe, grouping, history cap). Zero dependencies: node --test.
 *
 * Run: node --test tests/frontend/
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const C = require("../../web/captions.js");

const ev = (over) => ({ id: "e1", lang: "original", t: 100, text: "hola", final: true, ...over });

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

test("interim replaces current in place and never enters history", () => {
  const s = C.createStore();
  assert.equal(s.apply(ev({ final: false, text: "hola" })), true);
  assert.equal(s.apply(ev({ final: false, text: "hola mun" })), true);
  assert.equal(s.current.text, "hola mun");
  assert.equal(s.current.interim, true);
  assert.equal(s.blocks.length, 0);
});

test("interim seals the previous active block (final goes to history)", () => {
  const s = C.createStore();
  s.apply(ev({ id: "a", final: true, text: "primera frase" }));
  assert.equal(s.blocks.length, 1);
  assert.equal(s.activeBlock, s.blocks[0]);

  // new interim closes the utterance → active sealed, cleared
  s.apply(ev({ id: "b", final: false, text: "segunda" }));
  assert.equal(s.activeBlock, null);
  assert.equal(s.blocks[0].sealed, true);
  assert.equal(s.current.interim, true);
  // history still has 1 block (the sealed one) + current is separate
  assert.equal(s.blocks.length, 1);
});

// ----------------------------------------------------- final authoritative

test("final replaces the interim of the same turn (never concatenates)", () => {
  const s = C.createStore();
  s.apply(ev({ id: "x", final: false, text: "And so my fellow" }));
  s.apply(ev({ id: "x", final: true, text: "And so, my fellow Americans, ask not" }));
  assert.equal(s.current.text, "And so, my fellow Americans, ask not");
  assert.equal(s.current.interim, false);
  assert.equal(s.blocks.length, 1);
  // the interim text is not appended anywhere
  assert.ok(!s.blocks[0].text.includes("And so my fellow And"));
});

test("final with a rewritten text replaces the interim hypothesis", () => {
  const s = C.createStore();
  s.apply(ev({ id: "y", final: false, text: "hola mu" }));
  s.apply(ev({ id: "y", final: true, text: "hola mundo cruel" }));
  assert.equal(s.current.text, "hola mundo cruel");
});

// ------------------------------------------------------------------ dedupe

test("duplicate finals (same id) merge into one block", () => {
  const s = C.createStore();
  s.apply(ev({ id: "d1", t: 100, text: "una frase" }));
  s.apply(ev({ id: "d1", t: 101, text: "una frase completa" }));
  assert.equal(s.blocks.length, 1);
  assert.equal(s.blocks[0].text, "una frase completa");
  assert.equal(s.current.text, "una frase completa");
  assert.equal(s.blocks[0].lastT, 101);
});

test("stale id already trimmed from history is not resurrected", () => {
  const s = C.createStore({ maxHistory: 1 });
  s.apply(ev({ id: "old", t: 10, text: "viejo" }));
  s.apply(ev({ id: "new1", t: 20, text: "bloque nuevo" }));
  s.apply(ev({ id: "new2", t: 30, text: "bloque más nuevo" }));
  // "old" was trimmed (cap = maxHistory + 1 = 2 blocks)
  assert.equal(s.blocks.length, 2);
  const again = s.apply(ev({ id: "old", t: 40, text: "viejo reenviado" }));
  assert.equal(again, true);
  assert.equal(s.blocks.length, 2); // opened a fresh block, no merge
  assert.notEqual(s.blocks.find((b) => b.text.includes("reenviado")), undefined);
});

// ---------------------------------------------------------------- grouping

test("consecutive finals within the gap group into one block", () => {
  const s = C.createStore();
  s.apply(ev({ id: "g1", t: 100, text: "fragmento uno." }));
  s.apply(ev({ id: "g2", t: 103, text: "fragmento dos." }));
  assert.equal(s.blocks.length, 1);
  assert.equal(s.blocks[0].text, "fragmento uno. fragmento dos.");
  assert.equal(s.blocks[0].t, 100); // original timestamp kept
  assert.equal(s.blocks[0].lastT, 103);
});

test("finals beyond the gap open a new block", () => {
  const s = C.createStore(); // GROUP_GAP_S = 6
  s.apply(ev({ id: "g1", t: 100, text: "uno" }));
  s.apply(ev({ id: "g2", t: 107, text: "dos" }));
  assert.equal(s.blocks.length, 2);
});

test("a sealed block is never extended by a later final", () => {
  const s = C.createStore();
  s.apply(ev({ id: "s1", t: 100, text: "primera" }));
  s.apply(ev({ id: "s2", t: 101, final: false, text: "interim" })); // seals s1
  s.apply(ev({ id: "s3", t: 102, text: "segunda" }));
  assert.equal(s.blocks.length, 2);
  assert.equal(s.blocks[0].text, "primera");
  assert.equal(s.blocks[1].text, "segunda");
});

test("finals of different languages never group together", () => {
  const s = C.createStore();
  s.apply(ev({ id: "l1", lang: "original", t: 100, text: "hello" }));
  s.apply(ev({ id: "l2", lang: "es", t: 101, text: "hola" }));
  assert.equal(s.blocks.length, 2);
});

test("grouping window is configurable", () => {
  const s = C.createStore({ groupGapS: 2 });
  s.apply(ev({ id: "a", t: 100, text: "uno" }));
  s.apply(ev({ id: "b", t: 101, text: "dos" }));
  s.apply(ev({ id: "c", t: 104, text: "tres" }));
  assert.equal(s.blocks.length, 2); // 100-101 grouped, 104 separate
});

// ------------------------------------------------------------------- cap

test("history is capped: rendered ≤ maxHistory, active kept", () => {
  const s = C.createStore({ maxHistory: 3 });
  for (let i = 0; i < 10; i++) {
    s.apply(ev({ id: `f${i}`, t: 100 + i * 10, text: `frase ${i}` }));
  }
  // blocks = cap + 1 (the active block is part of blocks)
  assert.equal(s.blocks.length, 4);
  assert.equal(s.blocks[0].text, "frase 6"); // oldest dropped
  assert.equal(s.current.text, "frase 9"); // newest is current
});

test("default cap is 20 rendered segments", () => {
  const s = C.createStore();
  for (let i = 0; i < 50; i++) {
    s.apply(ev({ id: `f${i}`, t: 100 + i * 10, text: `frase ${i}` }));
  }
  assert.equal(s.blocks.length, C.MAX_HISTORY + 1);
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
  assert.equal(s.blocks.length, 0);
});

test("normalization: missing lang/t/id and fallback language", () => {
  const s = C.createStore();
  assert.equal(s.apply({ text: "hola", final: true }, "es"), true);
  assert.equal(s.current.lang, "es");
  // blocks get generated ids and timestamps
  s.apply({ text: "mundo", final: true }, "es");
  assert.ok(s.blocks[0].id.startsWith("seg-"));
  assert.ok(Number.isFinite(s.blocks[0].t));
  assert.ok(typeof s.blocks[0].t === "number");
});

test("reset clears current, blocks and index", () => {
  const s = C.createStore();
  s.apply(ev({ id: "r1", text: "algo" }));
  s.reset();
  assert.equal(s.current, null);
  assert.equal(s.activeBlock, null);
  assert.equal(s.blocks.length, 0);
  // after reset, a recycled id behaves as brand new
  assert.equal(s.apply(ev({ id: "r1", text: "de nuevo" })), true);
  assert.equal(s.blocks.length, 1);
});

test("stores are independent from each other", () => {
  const a = C.createStore();
  const b = C.createStore();
  a.apply(ev({ text: "solo en a" }));
  assert.equal(b.current, null);
  assert.equal(b.blocks.length, 0);
});
