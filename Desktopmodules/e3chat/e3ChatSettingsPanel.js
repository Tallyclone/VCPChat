"use strict";
(function (global) {
  function renderStatus(status) {
    const el = document.getElementById("connection-state");
    if (!el) return;
    const workspace = status?.workspace?.displayName || status?.workspace?.identity || "未知工作空间";
    el.textContent = `${status?.connected ? "已连接" : "未连接"} · ${workspace}`;
  }
  global.E3ChatSettingsPanel = { renderStatus };
})(window);
