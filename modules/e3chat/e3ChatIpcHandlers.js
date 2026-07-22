"use strict";

const { ipcMain, dialog } = require("electron");
const path = require("path");
const fileManager = require("../fileManager");
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

function normalizeHistoryRequest(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("无效的 E3 历史操作请求");
  }
  const allowedKeys = new Set(
    options.includeText
      ? ["sessionId", "reference", "newText"]
      : ["sessionId", "reference"]
  );
  const unsupportedKey = Object.keys(input).find(
    (key) => !allowedKeys.has(key)
  );
  if (unsupportedKey) {
    throw new Error(`E3 历史操作包含不受支持的字段: ${unsupportedKey}`);
  }
  const reference = input.reference;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("无效的 E3 消息引用");
  }
  const unsupportedReferenceKey = Object.keys(reference).find(
    (key) => key !== "rowIndex" && key !== "fingerprint"
  );
  if (unsupportedReferenceKey) {
    throw new Error(
      `E3 消息引用包含不受支持的字段: ${unsupportedReferenceKey}`
    );
  }
  const request = {
    sessionId: input.sessionId,
    reference: {
      rowIndex: reference.rowIndex,
      fingerprint: reference.fingerprint,
    },
  };
  if (options.includeText) request.newText = input.newText;
  return request;
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
  wrap("e3chat:edit-message", (_event, input) => {
    const request = normalizeHistoryRequest(input, { includeText: true });
    return svc.editMessage(
      request.sessionId,
      request.reference,
      request.newText
    );
  });
  wrap("e3chat:delete-message", (_event, input) => {
    const request = normalizeHistoryRequest(input);
    return svc.deleteMessage(request.sessionId, request.reference);
  });
  wrap("e3chat:regenerate-message", (_event, input) => {
    const request = normalizeHistoryRequest(input);
    return svc.regenerateMessage(request.sessionId, request.reference);
  });
  wrap("e3chat:select-files", async () => {
    const win = e3ChatWindow.getE3ChatWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择要发送的文件",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    const attachments = [];
    for (const filePath of result.filePaths) {
      attachments.push(
        await fileManager.storeFile(
          filePath,
          path.basename(filePath),
          "e3chat",
          "chat"
        )
      );
    }
    return attachments;
  });
  wrap("e3chat:store-pasted-file", async (_event, file = {}) => {
    if (!file.name || !file.data) throw new Error("无效的粘贴文件");
    const data = Buffer.from(file.data);
    if (!data.length || data.length > 25 * 1024 * 1024)
      throw new Error("粘贴文件为空或超过 25MB");
    return await fileManager.storeFile(
      data,
      String(file.name),
      "e3chat",
      "chat",
      file.type || "application/octet-stream"
    );
  });
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
  wrap("e3chat:get-viewport-path", () => {
    try {
      return svc.viewport.viewportPath();
    } catch (_) {
      return null;
    }
  });

  wrap("e3chat:select-custom-wallpaper", async () => {
    const win = e3ChatWindow.getE3ChatWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择自定义壁纸",
      properties: ["openFile"],
      filters: [
        {
          name: "支持的壁纸格式",
          extensions: [
            "jpg",
            "jpeg",
            "png",
            "gif",
            "webp",
            "bmp",
            "svg",
            "mp4",
            "webm",
          ],
        },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const fileUrl = `file:///${filePath.replace(/\\/g, "/")}`;
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    const type = ["mp4", "webm"].includes(ext) ? "video" : "image";
    return { filePath, fileUrl, type };
  });
  wrap("e3chat:list-wallpapers", async () => {
    const fs = require("fs-extra");
    const wpDir = path.join(projectRoot, "assets", "wallpaper");
    if (!(await fs.pathExists(wpDir))) return [];
    const files = await fs.readdir(wpDir);
    return files
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return [
          ".jpg",
          ".jpeg",
          ".png",
          ".gif",
          ".webp",
          ".mp4",
          ".webm",
        ].includes(ext);
      })
      .map((f) => {
        const filePath = path.join(wpDir, f);
        const fileUrl = `file:///${filePath.replace(/\\/g, "/")}`;
        const ext = path.extname(f).toLowerCase().replace(".", "");
        const type = ["mp4", "webm"].includes(ext) ? "video" : "image";
        return { name: f, filePath, fileUrl, type };
      });
  });
  wrap("e3chat:minimize", () => {
    const win = e3ChatWindow.getE3ChatWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });
  wrap("e3chat:maximize", () => {
    const win = e3ChatWindow.getE3ChatWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });
  wrap("e3chat:close", () => {
    const win = e3ChatWindow.getE3ChatWindow();
    if (win && !win.isDestroyed()) win.close();
  });
}

let shutdownPromise = null;

async function shutdown() {
  if (!service) return { shutdown: false, reason: "not-initialized" };
  if (!shutdownPromise) {
    shutdownPromise = service.shutdown().catch((error) => {
      shutdownPromise = null;
      throw error;
    });
  }
  return await shutdownPromise;
}

module.exports = { initialize, getService, shutdown };
