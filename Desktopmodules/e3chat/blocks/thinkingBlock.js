"use strict";
(function (global) {
  function create(text) {
    const el = document.createElement("details");
    el.className = "thinking-block e3-thinking-block";
    el.open = false;
    const summary = document.createElement("summary");
    summary.textContent = "E3 思考过程";
    const content = document.createElement("div");
    content.className = "thinking-content";
    el.append(summary, content);
    update(el, text);
    return el;
  }

  function update(el, text) {
    const content = el.querySelector(".thinking-content");
    if (!content) return;
    const raw = String(text ?? "");
    if (global.marked?.parse) {
      try {
        let html = global.marked.parse(raw, { mangle: false, headerIds: false });
        html = global.DOMPurify?.sanitize ? global.DOMPurify.sanitize(html) : html;
        content.innerHTML = html;
        return;
      } catch (_) {}
    }
    content.textContent = raw;
  }

  global.E3ThinkingBlock = { create, update };
})(window);
