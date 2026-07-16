"use strict";
(function (global) {
  function render(items) {
    const el = document.getElementById("diagnostics");
    if (!el) return;
    el.textContent = Array.isArray(items) ? items.map((item) => `${item.at} [${item.level}] ${item.message}`).join("\n") : "";
  }
  global.E3DiagnosticsPanel = { render };
})(window);
