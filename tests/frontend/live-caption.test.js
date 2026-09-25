/* Tests for web/live-caption.js — the shared bilingual caption renderer.
 * Uses a minimal DOM stub via the injectable `doc` option (no jsdom).
 *
 * Run: node --test "tests/frontend/*.test.js"
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const LC = require("../../web/live-caption.js");

// Minimal DOM stub: only what mount()/update() touch.
function makeEl(tag) {
  const children = [];
  const classes = new Set();
  const attrs = {};
  return {
    tagName: tag,
    children,
    get className() {
      return [...classes].join(" ");
    },
    set className(v) {
      classes.clear();
      for (const c of String(v || "").split(/\s+/)) {
        if (c) classes.add(c);
      }
    },
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
    },
    appendChild: (c) => {
      children.push(c);
      return c;
    },
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hidden: false,
    textContent: "",
    _classes: classes,
    _attrs: attrs,
  };
}

const fakeDoc = { createElement: makeEl };

function mounted(opts) {
  const container = makeEl("div");
  const lc = LC.mount(container, { doc: fakeDoc, placeholder: "Esperando…", ...opts });
  const [origLine, transLine] = container.children;
  return {
    container,
    lc,
    origLine,
    transLine,
    origText: origLine.children[1],
    transText: transLine.children[1],
  };
}

test("mount creates the bilingual structure once", () => {
  const { container, origLine, transLine, origText, transText } = mounted();
  assert.ok(container._classes.has("lc"));
  assert.equal(container.children.length, 2);
  assert.ok(origLine._classes.has("lc-line--original"));
  assert.ok(transLine._classes.has("lc-line--translation"));
  // screen-reader labels, visually hidden by CSS
  assert.equal(origLine.children[0].textContent, "Original:");
  assert.equal(transLine.children[0].textContent, "Traducción:");
  assert.ok(origLine.children[0]._classes.has("sr-only"));
  assert.equal(origText.textContent, "");
  assert.equal(transText.textContent, "");
});

test("empty state shows the placeholder and hides the translation", () => {
  const { container, origText, transLine, lc } = mounted();
  lc.update({ original: "", translation: "", interim: false, expected: true });
  assert.equal(container.getAttribute("data-status"), "empty");
  assert.equal(origText.textContent, "Esperando…");
  assert.equal(transLine.hidden, true);
});

test("interim updates the same caption and reserves the translation line", () => {
  const { container, origText, transLine, transText, lc } = mounted();
  lc.update({ original: "That's a", translation: "", interim: true, expected: true });
  lc.update({ original: "That's a very short", translation: "", interim: true, expected: true });
  assert.equal(container.getAttribute("data-status"), "interim");
  assert.equal(container.getAttribute("data-interim"), "1");
  assert.equal(container.children.length, 2); // updated in place, no new lines
  assert.equal(origText.textContent, "That's a very short");
  assert.equal(transLine.hidden, true);
  assert.equal(transText.textContent, "");
});

test("final without translation shows the pending marker", () => {
  const { container, transLine, transText, lc } = mounted();
  lc.update({ original: "Welcome.", translation: "", interim: false, expected: true });
  assert.equal(container.getAttribute("data-status"), "final");
  assert.equal(container.getAttribute("data-interim"), "0");
  assert.equal(transLine.hidden, false);
  assert.equal(transLine.getAttribute("data-pending"), "1");
  assert.equal(transText.textContent, LC.PENDING_MARK);
});

test("final with translation shows both lines", () => {
  const { container, origLine, transLine, origText, transText, lc } = mounted();
  lc.update({
    original: "Welcome.",
    translation: "Bienvenidos.",
    interim: false,
    expected: true,
  });
  assert.equal(origLine.hidden, false);
  assert.equal(origText.textContent, "Welcome.");
  assert.equal(transLine.hidden, false);
  assert.equal(transLine.getAttribute("data-pending"), "0");
  assert.equal(transText.textContent, "Bienvenidos.");
});

test("translation in place does not recreate lines", () => {
  const { container, transText, lc } = mounted();
  lc.update({ original: "Welcome.", translation: "", interim: false, expected: true });
  assert.equal(transText.textContent, LC.PENDING_MARK);
  lc.update({ original: "Welcome.", translation: "Bienvenidos.", interim: false, expected: true });
  assert.equal(container.children.length, 2);
  assert.equal(transText.textContent, "Bienvenidos.");
});

test("without an expected translation the second line stays hidden", () => {
  const { transLine, transText, lc } = mounted();
  lc.update({ original: "Hello.", translation: "", interim: false, expected: false });
  assert.equal(transLine.hidden, true);
  assert.equal(transText.textContent, "");
});

test("translation-only segment hides the original line", () => {
  const { origLine, transLine, transText, lc } = mounted();
  lc.update({ original: "", translation: "Solo traducción.", interim: false, expected: true });
  assert.equal(origLine.hidden, true);
  assert.equal(transLine.hidden, false);
  assert.equal(transText.textContent, "Solo traducción.");
});

test("clear() returns to the placeholder", () => {
  const { container, origText, lc } = mounted();
  lc.update({ original: "x", translation: "y", interim: false, expected: true });
  lc.clear();
  assert.equal(container.getAttribute("data-status"), "empty");
  assert.equal(origText.textContent, "Esperando…");
});
