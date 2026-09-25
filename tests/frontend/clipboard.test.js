/* Tests for web/clipboard.js — copy-to-clipboard with execCommand fallback.
 * Zero dependencies: node --test.
 *
 * Run: node --test "tests/frontend/*.test.js"
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const C = require("../../web/clipboard.js");

// Fake textarea element returned by the stub document.
function makeTextarea() {
  return {
    value: "",
    setAttribute() {},
    style: {},
    select() {},
  };
}

// Stub document: execBehavior true/false/"throw".
function makeDoc(execBehavior) {
  const areas = [];
  return {
    areas,
    createElement: (tag) => {
      assert.equal(tag, "textarea");
      const ta = makeTextarea();
      areas.push(ta);
      return ta;
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
    execCommand: (cmd) => {
      assert.equal(cmd, "copy");
      if (execBehavior === "throw") throw new Error("denied");
      return !!execBehavior;
    },
  };
}

test("Clipboard API success resolves true with the exact text", async () => {
  let written = null;
  const deps = {
    clipboard: { writeText: (t) => Promise.resolve((written = t)) },
    document: makeDoc(true),
  };
  assert.equal(await C.copyText("rtmp://host:1935", deps), true);
  assert.equal(written, "rtmp://host:1935");
  // fallback textarea never needed
  assert.equal(deps.document.areas.length, 0);
});

test("Clipboard API rejection falls back to execCommand", async () => {
  const doc = makeDoc(true);
  const deps = {
    clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    document: doc,
  };
  assert.equal(await C.copyText("main", deps), true);
  assert.equal(doc.areas.length, 1);
  assert.equal(doc.areas[0].value, "main");
});

test("Clipboard API sync throw falls back to execCommand", async () => {
  const deps = {
    clipboard: {
      writeText: () => {
        throw new Error("sync");
      },
    },
    document: makeDoc(true),
  };
  assert.equal(await C.copyText("main", deps), true);
});

test("no Clipboard API: execCommand success resolves true", async () => {
  const doc = makeDoc(true);
  assert.equal(await C.copyText("main", { clipboard: null, document: doc }), true);
  assert.equal(doc.areas[0].value, "main");
});

test("execCommand false resolves false (nothing copied)", async () => {
  assert.equal(
    await C.copyText("main", { clipboard: null, document: makeDoc(false) }),
    false,
  );
});

test("execCommand throw resolves false", async () => {
  assert.equal(
    await C.copyText("main", { clipboard: null, document: makeDoc("throw") }),
    false,
  );
});

test("no clipboard and no document resolves false", async () => {
  assert.equal(await C.copyText("main", { clipboard: null, document: null }), false);
});

test("values are stringified", async () => {
  let written = null;
  const deps = {
    clipboard: { writeText: (t) => Promise.resolve((written = t)) },
    document: null,
  };
  assert.equal(await C.copyText(null, deps), true);
  assert.equal(written, "");
});
