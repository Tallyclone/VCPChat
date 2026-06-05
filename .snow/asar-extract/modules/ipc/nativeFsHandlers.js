"use strict";

const { ipcMain } = require("electron");
const { NativeFsService, NativeFsError } = require("./NativeFsService");

let service = null;
let registered = false;

function normalizeError(error) {
  return {
    success: false,
    error: error?.code || error?.message || String(error),
    message: error?.message || String(error),
  };
}

async function call(handler) {
  try {
    return await handler();
  } catch (error) {
    if (!(error instanceof NativeFsError)) {
      console.error("[NativeFsHandlers] IPC error:", error);
    }
    return normalizeError(error);
  }
}

function initialize({ getDesktopWindow, sendToDesktop } = {}) {
  if (!service) {
    service = new NativeFsService({ getDesktopWindow, sendToDesktop });
  }

  if (registered) return service;
  registered = true;

  ipcMain.handle("desktop:nfs:registerMount", (event, config) =>
    call(() => service.registerMount(config))
  );
  ipcMain.handle("desktop:nfs:list", (event, params) =>
    call(() => service.list(params))
  );
  ipcMain.handle("desktop:nfs:action", (event, params) =>
    call(() => service.action(params))
  );
  ipcMain.handle("desktop:nfs:startDrag", (event, params) =>
    call(() => service.startDrag(params, event))
  );
  ipcMain.handle("desktop:nfs:importFiles", (event, params) =>
    call(() => service.importFiles(params))
  );
  ipcMain.handle("desktop:nfs:watchDir", (event, params) =>
    call(() => service.watchDir(params))
  );
  ipcMain.handle("desktop:nfs:unwatchDir", (event, params) =>
    call(() => service.unwatchDir(params))
  );
  ipcMain.handle("desktop:nfs:unmount", (event, params) =>
    call(() => service.unmount(params))
  );
  ipcMain.handle("desktop:nfs:cancelJob", (event, params) =>
    call(() => service.cancelJob(params))
  );
  ipcMain.handle("desktop:nfs:listActiveMounts", () =>
    call(() => service.listActiveMounts())
  );

  return service;
}

function getService() {
  return service;
}

async function closeAll() {
  if (service) {
    await service.closeAll();
  }
}

module.exports = {
  initialize,
  getService,
  closeAll,
};
