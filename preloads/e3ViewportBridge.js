"use strict";

const { ipcRenderer } = require("electron");

ipcRenderer.on("e3-viewport-rpc-invoke", (_event, payload) => {
  window.postMessage(
    {
      type: "rpc",
      method: payload.methodName,
      body: payload.body,
      requestId: payload.requestId,
    },
    "*"
  );
});

window.addEventListener("message", (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "rpc-response") return;
  ipcRenderer.send("e3-viewport-rpc-response", {
    requestId: payload.requestId,
    result: payload.result,
  });
});
