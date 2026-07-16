"use strict";

const { ipcMain, WebContents } = require("electron");
const E3ChatService = require("./e3ChatService");
const e3ChatWindow = require("./e3ChatWindow");

let service = null;
let initialized = false;
const allowedWebContents = new Set();

function getService(options = {}) {
  if (!service)
    service = new E3ChatService({ projectRoot: options.projectRoot });
  return service;
}

function assertE3Sender(event) {
  const win = e3ChatWindow.getE3ChatWindow();
  if (
    !win ||
    win.isDestroyed() ||
    event.sender.id !== win.webContents.id ||
    !allowedWebContents.has(event.sender.id)
  ) {
    throw new Error("Unauthorized E3 Chat IPC sender");
  }
}

function safeError(error) {
  return {
    success: false,
    error: error?.message || String(error || "Unknown error"),
  };
}

function wrap(channel, handler) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertE3Sender(event);
      const data = await handler(event, ...args);
      return { success: true, data };
    } catch (error) {
      return safeError(error);
    }
  });
}

function initialize(options = {}) {
  if (initialized) return;
  initialized = true;
  const projectRoot = options.projectRoot;
  const svc = getService({ projectRoot });

  svc.on("event", (payload) => {
    const win = e3ChatWindow.getE3ChatWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("e3chat:event", payload);
  });

  ipcMain.removeHandler("e3chat:register-window");
  ipcMain.handle("e3chat:register-window", async (event) => {
    const win = e3ChatWindow.getE3ChatWindow();
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id)
      return { success: false, error: "Unauthorized" };
    allowedWebContents.add(event.sender.id);
    event.sender.once("destroyed", () =>
      allowedWebContents.delete(event.sender.id)
    );
    return { success: true };
  });

  wrap("e3chat:get-status", () => svc.status());
  wrap("e3chat:connect", (_event, optionsArg = {}) =>
    svc.connect(optionsArg || {})
  );
  wrap("e3chat:disconnect", () => svc.disconnect());
  wrap("e3chat:refresh-workspace", () => svc.refreshWorkspace());
  wrap("e3chat:list-sessions", () => svc.listSessions());
  wrap("e3chat:load-session", (_event, sessionId) =>
    svc.loadSession(sessionId)
  );
  wrap("e3chat:rename-session", (_event, sessionId, title) =>
    svc.renameSession(sessionId, title)
  );
  wrap("e3chat:send-message", (_event, input = {}) =>
    svc.sendMessage(
      input.content,
      input.attachments ?? null,
      input.sessionId ?? null
    )
  );
  wrap("e3chat:cancel", () => svc.cancel());
  wrap("e3chat:answer-question", (_event, input = {}) =>
    svc.answerQuestion(input.requestId, input.answerPayload)
  );
  wrap("e3chat:get-diagnostics", () => svc.getDiagnostics());
  wrap("e3chat:get-local-state", (_event, scope) => svc.getLocalState(scope));
  wrap("e3chat:save-local-state", (_event, scope, patch) =>
    svc.saveLocalState(scope, patch)
  );
}

module.exports = { initialize, getService };
