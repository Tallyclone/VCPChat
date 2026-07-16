"use strict";
(function (global) {
  function create(message, source) {
    const el = document.createElement("article");
    el.className = "error-block";
    el.textContent = `${source === "invocation" ? "调用失败" : "E3 错误"}：${message || "未知错误"}`;
    return el;
  }
  global.E3ErrorBlock = { create };
})(window);
