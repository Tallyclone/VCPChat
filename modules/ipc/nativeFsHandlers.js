"use strict";

/**
 * nativeFsHandlers.js — NativeFileMount IPC 处理器
 *
 * 注册主进程 IPC handler，桥接桌面窗口 preload API 到 NativeFsService。
 * Phase 1 仅实现基础能力：registerMount, list, open, reveal
 */

const { ipcMain } = require("electron");
const nativeFsService = require("./NativeFsService");

function initialize() {
  console.log("[NativeFsHandlers] Initializing NativeFs IPC handlers...");

  // ============================================================
  // Mount 管理
  // ============================================================

  ipcMain.handle("nativeFs:registerMount", async (event, args) => {
    try {
      const result = nativeFsService.registerMount(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] registerMount error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:unmount", async (event, args) => {
    try {
      const result = nativeFsService.unmount(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] unmount error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:getInfo", async (event, args) => {
    try {
      const result = nativeFsService.getInfo(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] getInfo error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // 文件浏览
  // ============================================================

  ipcMain.handle("nativeFs:list", async (event, args) => {
    try {
      const result = await nativeFsService.list(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] list error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:stat", async (event, args) => {
    try {
      const result = await nativeFsService.stat(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] stat error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // 文件操作
  // ============================================================

  ipcMain.handle("nativeFs:open", async (event, args) => {
    try {
      const result = await nativeFsService.open(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] open error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:reveal", async (event, args) => {
    try {
      const result = await nativeFsService.reveal(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] reveal error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // Phase 2: 文件操作
  // ============================================================

  ipcMain.handle("nativeFs:copy", async (event, args) => {
    try {
      const result = await nativeFsService.copy(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] copy error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:cut", async (event, args) => {
    try {
      const result = await nativeFsService.cut(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] cut error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:rename", async (event, args) => {
    try {
      const result = await nativeFsService.rename(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] rename error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:trash", async (event, args) => {
    try {
      const result = await nativeFsService.trash(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] trash error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:newFolder", async (event, args) => {
    try {
      const result = await nativeFsService.newFolder(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] newFolder error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:newFile", async (event, args) => {
    try {
      const result = await nativeFsService.newFile(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] newFile error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:unzip", async (event, args) => {
    try {
      const result = await nativeFsService.unzip(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] unzip error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // Phase 2: 剪贴板
  // ============================================================

  ipcMain.handle("nativeFs:copyToClipboard", async (event, args) => {
    try {
      const result = await nativeFsService.copyToClipboard(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] copyToClipboard error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:cutToClipboard", async (event, args) => {
    try {
      const result = await nativeFsService.cutToClipboard(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] cutToClipboard error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:pasteFromClipboard", async (event, args) => {
    try {
      const result = await nativeFsService.pasteFromClipboard(args);
      return { success: true, ...result };
    } catch (err) {
      console.error(
        "[NativeFsHandlers] pasteFromClipboard error:",
        err.message
      );
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // Phase 2: 监听 & 辅助
  // ============================================================

  ipcMain.handle(
    "nativeFs:unwatch",
    async (event, { mountId, capabilityToken, path: relPath }) => {
      try {
        nativeFsService._validateToken(mountId, capabilityToken);
        const NativeFsWatcher = require("./NativeFsWatcher");
        NativeFsWatcher.unwatch(mountId, relPath);
        return { success: true };
      } catch (err) {
        console.error("[NativeFsHandlers] unwatch error:", err.message);
        return { success: false, error: err.message };
      }
    }
  );

  ipcMain.handle("nativeFs:requestOperations", async (event, args) => {
    try {
      const result = await nativeFsService.requestOperations(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] requestOperations error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("nativeFs:confirm", async (event, args) => {
    try {
      const result = await nativeFsService.confirm(args);
      return { success: true, ...result };
    } catch (err) {
      console.error("[NativeFsHandlers] confirm error:", err.message);
      return { success: false, error: err.message };
    }
  });

  console.log(
    "[NativeFsHandlers] NativeFs IPC handlers registered successfully"
  );
}

module.exports = { initialize };
