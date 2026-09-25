/* Simulcast clipboard helper — copy-to-clipboard with fallback.
 *
 * navigator.clipboard only exists in secure contexts (https / localhost);
 * on a venue LAN served over plain http it is undefined, so we fall back
 * to the classic hidden-textarea + document.execCommand("copy") trick.
 *
 * copyText(text, deps?) → Promise<boolean> (true = copied).
 * `deps` ({ clipboard, document }) is injectable for the node:test suite;
 * when omitted it resolves from the globals.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimulcastClipboard = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function defaultDeps() {
    var nav = typeof navigator !== "undefined" ? navigator : undefined;
    var doc = typeof document !== "undefined" ? document : undefined;
    return {
      clipboard: nav && nav.clipboard ? nav.clipboard : null,
      document: doc || null,
    };
  }

  function fallbackCopy(text, doc) {
    try {
      var ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.opacity = "0";
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = doc.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      doc.body.removeChild(ta);
      return !!ok;
    } catch (err) {
      return false;
    }
  }

  function copyText(text, deps) {
    var d = deps || defaultDeps();
    var value = String(text == null ? "" : text);
    var hasApi =
      d.clipboard && typeof d.clipboard.writeText === "function";
    if (hasApi) {
      var result = null;
      try {
        result = d.clipboard.writeText(value);
      } catch (err) {
        result = null;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          function () {
            return true;
          },
          function () {
            // Clipboard API rejected (ej. permiso denegado) → fallback.
            return d.document ? fallbackCopy(value, d.document) : false;
          },
        );
      }
    }
    if (d.document) return Promise.resolve(fallbackCopy(value, d.document));
    return Promise.resolve(false);
  }

  return { copyText: copyText };
});
