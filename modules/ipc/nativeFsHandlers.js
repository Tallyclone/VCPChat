'use strict';

/**
 * nativeFsHandlers.js — NativeFileMount IPC 处理器
 * 
 * 注册主进程 IPC handler，桥接桌面窗口 preload API 到 NativeFsService。
 * Phase 1 仅实现基础能力：registerMount, list, open, reveal
 */

const { ipcMain } = require('electron');
const nativeFsService = require('./NativeFsService');

function initialize() {
    console.log('[NativeFsHandlers] Initializing NativeFs IPC handlers...');

    // ============================================================
    // Mount 管理
    // ============================================================

    ipcMain.handle('nativeFs:registerMount', async (event, args) => {
        try {
            const result = nativeFsService.registerMount(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] registerMount error:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('nativeFs:unmount', async (event, args) => {
        try {
            const result = nativeFsService.unmount(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] unmount error:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('nativeFs:getInfo', async (event, args) => {
        try {
            const result = nativeFsService.getInfo(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] getInfo error:', err.message);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // 文件浏览
    // ============================================================

    ipcMain.handle('nativeFs:list', async (event, args) => {
        try {
            const result = await nativeFsService.list(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] list error:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('nativeFs:stat', async (event, args) => {
        try {
            const result = await nativeFsService.stat(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] stat error:', err.message);
            return { success: false, error: err.message };
        }
    });

    // ============================================================
    // 文件操作
    // ============================================================

    ipcMain.handle('nativeFs:open', async (event, args) => {
        try {
            const result = await nativeFsService.open(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] open error:', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('nativeFs:reveal', async (event, args) => {
        try {
            const result = await nativeFsService.reveal(args);
            return { success: true, ...result };
        } catch (err) {
            console.error('[NativeFsHandlers] reveal error:', err.message);
            return { success: false, error: err.message };
        }
    });

    console.log('[NativeFsHandlers] NativeFs IPC handlers registered successfully');
}

module.exports = { initialize };
