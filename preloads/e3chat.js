"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then((result) => {
    if (!result?.success)
      throw new Error(result?.error || "E3 Chat IPC failed");
    return result.data;
  });
}

const api = {
  ready: () => invoke("e3chat:register-window"),
  getStatus: () => invoke("e3chat:get-status"),
  connect: (options) => invoke("e3chat:connect", options || {}),
  disconnect: () => invoke("e3chat:disconnect"),
  refreshWorkspace: () => invoke("e3chat:refresh-workspace"),
  listSessions: () => invoke("e3chat:list-sessions"),
  loadSession: (sessionId) => invoke("e3chat:load-session", sessionId),
  renameSession: (sessionId, title) =>
    invoke("e3chat:rename-session", sessionId, title),
  selectFiles: () => invoke("e3chat:select-files"),
  storePastedFile: (file) => invoke("e3chat:store-pasted-file", file),
  sendMessage: (input) => invoke("e3chat:send-message", input),
  cancel: () => invoke("e3chat:cancel"),
  answerQuestion: (input) => invoke("e3chat:answer-question", input),
  getDiagnostics: () => invoke("e3chat:get-diagnostics"),
  getLocalState: (scope) => invoke("e3chat:get-local-state", scope),
  saveLocalState: (scope, patch) =>
    invoke("e3chat:save-local-state", scope, patch),
  onEvent: (listener) => {
    if (typeof listener !== "function")
      throw new TypeError("listener must be a function");
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("e3chat:event", wrapped);
    return () => ipcRenderer.removeListener("e3chat:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("e3chat", Object.freeze(api));
