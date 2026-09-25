/* Simulcast LiveCaption component — shared bilingual caption renderer.
 *
 * One conceptual component for both the audience page and the OBS overlay
 * (spec "Lineamiento de UI" §16): it receives { original, translation,
 * status } and renders one bilingual unit — never two independent events.
 *
 * Loaded as window.SimulcastLiveCaption (classic script). The consumer
 * provides the container element and its variant class
 * (e.g. `lc-box--current`, `lc-box--history`, `lc-box--overlay`); the
 * component only manages structure + text + status attributes so both
 * pages share the exact same caption model and markup.
 *
 * Structure created once inside the container:
 *
 *   <p class="lc-line lc-line--original">
 *     <span class="lc-tag sr-only">Original:</span>
 *     <span class="lc-text"></span>
 *   </p>
 *   <p class="lc-line lc-line--translation" data-pending="0">
 *     <span class="lc-tag sr-only">Traducción:</span>
 *     <span class="lc-text"></span>
 *   </p>
 *
 * Status is exposed as `data-status` ("empty" | "interim" | "final") and
 * `data-interim` ("1" while the original is still a hypothesis) so CSS
 * can differentiate the live caption without re-rendering.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimulcastLiveCaption = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Marker shown in the translation line while a final awaits translation. */
  var PENDING_MARK = "…";

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function makeLine(doc, modifier, tagText) {
    var line = doc.createElement("p");
    line.className = "lc-line " + modifier;
    var tag = doc.createElement("span");
    tag.className = "lc-tag sr-only";
    tag.textContent = tagText;
    var text = doc.createElement("span");
    text.className = "lc-text";
    line.appendChild(tag);
    line.appendChild(text);
    return { line: line, text: text };
  }

  /**
   * Mounts a LiveCaption into `container`.
   *
   * options: { placeholder, expected, sourceLabel, targetLabel, doc }
   *   placeholder: shown in the original line when there is no caption.
   *   expected: default for update()'s `expected` (whether the session
   *     configures a translation — reserves the translation line).
   *   sourceLabel/targetLabel: screen-reader prefixes ("Original:",
   *     "Traducción:" by default).
   *   doc: document to create elements with (defaults to the global one;
   *     injectable for tests).
   */
  function mount(container, options) {
    var opts = options || {};
    var doc =
      opts.doc || (typeof document !== "undefined" ? document : undefined);
    var placeholder = opts.placeholder != null ? opts.placeholder : "";
    var defaultExpected = !!opts.expected;

    var original = makeLine(doc, "lc-line--original", opts.sourceLabel || "Original:");
    var translation = makeLine(
      doc,
      "lc-line--translation",
      opts.targetLabel || "Traducción:",
    );

    container.classList.add("lc");
    container.appendChild(original.line);
    container.appendChild(translation.line);

    /**
     * Updates the caption in place.
     *
     * data: { original, translation, interim, expected }
     *   original/translation: current texts (may be empty strings).
     *   interim: true while the original is still a hypothesis.
     *   expected: true when the session configures a translation — the
     *     translation line is then reserved (no layout jumps when it
     *     arrives late) and shows a muted "…" once the original is final.
     */
    function update(data) {
      var d = data || {};
      var hasOriginal = !!String(d.original || "").trim();
      var hasTranslation = !!String(d.translation || "").trim();
      var expected = d.expected != null ? !!d.expected : defaultExpected;
      var status = !hasOriginal && !hasTranslation ? "empty" : d.interim ? "interim" : "final";

      setAttr(container, "data-status", status);
      setAttr(container, "data-interim", d.interim ? "1" : "0");

      // Original line: placeholder when empty, hidden only when the segment
      // is a translation alone (rare straggler pairing — see captions.js).
      original.line.hidden = status !== "empty" && !hasOriginal;
      setText(original.text, hasOriginal ? d.original : placeholder);

      // Translation line: hidden unless a translation is expected for this
      // session; pending marker only after the original finalized.
      var showTranslation = expected && status !== "empty" && (hasTranslation || !d.interim);
      translation.line.hidden = !showTranslation;
      if (showTranslation) {
        var pending = !hasTranslation;
        setAttr(translation.line, "data-pending", pending ? "1" : "0");
        setText(translation.text, hasTranslation ? d.translation : PENDING_MARK);
      }
    }

    function clear() {
      update({ original: "", translation: "", interim: false, expected: false });
    }

    return { el: container, update: update, clear: clear };
  }

  return { mount: mount, PENDING_MARK: PENDING_MARK };
});
