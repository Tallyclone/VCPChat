'use strict';

/**
 * NativeFsWatcher.js — 原生文件系统实时监听服务
 *
 * 职责：
 * - 使用 chokidar 监听 NativeFileMount 挂载目录的变更
 * - 最多维护 8 个 watcher（LRU 淘汰）
 * - 节流：单个 watchKey 超过 100 events/sec 时发送 resync 信号
 * - 将变更事件推送到桌面窗口渲染进程
 */

const path = require("path");
const chokidar = require("chokidar");

const MAX_WATCHERS = 8;
const THROTTLE_LIMIT = 100;
const THROTTLE_WINDOW_MS = 1000;

class NativeFsWatcher {
  constructor() {
    /** @type {Map<string, WatcherEntry>} watchKey -> WatcherEntry */
    this._watchers = new Map();

    /** @type {Map<string, ThrottleState>} watchKey -> { count, windowStart, throttled } */
    this._throttleCounters = new Map();

    /** @type {Function|null} Function that returns the BrowserWindow */
    this._getDesktopWindow = null;
  }

  /**
   * 设置桌面窗口获取函数（延迟绑定，因为窗口可能在初始化时尚不存在）
   * @param {Function} getterFn - 返回 BrowserWindow 的函数
   */
  setDesktopWindowGetter(getterFn) {
    this._getDesktopWindow = getterFn;
  }

  /**
   * 开始监听指定目录
   * @param {string} mountId - 挂载 ID
   * @param {string} relativePath - 相对路径
   * @param {string} realPath - 磁盘上的实际绝对路径
   */
  watch(mountId, relativePath, realPath) {
    const watchKey = `${mountId}::${relativePath || ''}`;

    // 如果已存在，更新 lastAccess 并返回
    if (this._watchers.has(watchKey)) {
      const entry = this._watchers.get(watchKey);
      entry.lastAccess = Date.now();
      return;
    }

    // LRU 淘汰：超过上限时移除最久未访问的 watcher
    if (this._watchers.size >= MAX_WATCHERS) {
      this._evictLRU();
    }

    // 创建 chokidar watcher
    const watcher = chokidar.watch(realPath, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // 监听所有变更事件
    const eventTypes = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'];
    for (const eventType of eventTypes) {
      watcher.on(eventType, (filePath) => {
        this._pushChange(watchKey, mountId, relativePath, eventType, filePath);
      });
    }

    // 错误处理：记录日志，不崩溃
    watcher.on('error', (err) => {
      console.log(`[NativeFsWatcher] Error on ${watchKey}: ${err.message}`);
    });

    const entry = {
      watcher,
      mountId,
      relativePath,
      realPath,
      lastAccess: Date.now(),
    };

    this._watchers.set(watchKey, entry);
    console.log(`[NativeFsWatcher] Watching: ${watchKey} -> ${realPath}`);
  }

  /**
   * 停止监听指定目录
   * @param {string} mountId - 挂载 ID
   * @param {string} relativePath - 相对路径
   */
  unwatch(mountId, relativePath) {
    const watchKey = `${mountId}::${relativePath || ''}`;
    const entry = this._watchers.get(watchKey);
    if (!entry) return;

    entry.watcher.close();
    this._watchers.delete(watchKey);
    this._throttleCounters.delete(watchKey);
    console.log(`[NativeFsWatcher] Unwatched: ${watchKey}`);
  }

  /**
   * 停止某个 mount 下的所有 watcher（卸载 mount 时调用）
   * @param {string} mountId - 挂载 ID
   */
  unwatchMount(mountId) {
    const keysToRemove = [];
    for (const [watchKey, entry] of this._watchers) {
      if (entry.mountId === mountId) {
        keysToRemove.push(watchKey);
      }
    }

    for (const watchKey of keysToRemove) {
      const entry = this._watchers.get(watchKey);
      entry.watcher.close();
      this._watchers.delete(watchKey);
      this._throttleCounters.delete(watchKey);
    }

    if (keysToRemove.length > 0) {
      console.log(
        `[NativeFsWatcher] Unwatched mount: ${mountId} (${keysToRemove.length} watchers)`
      );
    }
  }

  /**
   * LRU 淘汰：移除最久未访问的 watcher
   * @private
   */
  _evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [watchKey, entry] of this._watchers) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = watchKey;
      }
    }

    if (oldestKey) {
      const entry = this._watchers.get(oldestKey);
      entry.watcher.close();
      this._watchers.delete(oldestKey);
      this._throttleCounters.delete(oldestKey);
      console.log(`[NativeFsWatcher] Evicted LRU: ${oldestKey}`);
    }
  }

  /**
   * 推送变更事件到桌面窗口
   * @private
   * @param {string} watchKey - 监听 key
   * @param {string} mountId - 挂载 ID
   * @param {string} relativePath - 相对路径
   * @param {string} eventType - 事件类型 ('add'|'addDir'|'change'|'unlink'|'unlinkDir')
   * @param {string} filePath - chokidar 报告的文件路径
   */
  _pushChange(watchKey, mountId, relativePath, eventType, filePath) {
    // 更新 lastAccess
    const entry = this._watchers.get(watchKey);
    if (entry) {
      entry.lastAccess = Date.now();
    }

    // 获取桌面窗口
    const win = this._getDesktopWindow ? this._getDesktopWindow() : null;
    if (!win || win.isDestroyed()) {
      return;
    }

    // 节流检查
    if (this._shouldThrottle(watchKey)) {
      return;
    }

    const fileName = path.basename(filePath);

    win.webContents.send('nativeFs:change', {
      mountId,
      directoryPath: relativePath,
      changes: [{ type: eventType, name: fileName }],
      resync: false,
    });
  }

  /**
   * 检查是否需要节流（1 秒滑动窗口内超过 100 次事件）
   * @private
   * @param {string} watchKey - 监听 key
   * @returns {boolean} true 表示应该丢弃此事件
   */
  _shouldThrottle(watchKey) {
    const now = Date.now();
    let state = this._throttleCounters.get(watchKey);

    if (!state) {
      state = { count: 0, windowStart: now, throttled: false };
      this._throttleCounters.set(watchKey, state);
    }

    // 窗口重置
    if (now - state.windowStart >= THROTTLE_WINDOW_MS) {
      state.count = 0;
      state.windowStart = now;
      state.throttled = false;
    }

    state.count++;

    // 超过限制
    if (state.count > THROTTLE_LIMIT) {
      if (!state.throttled) {
        // 首次超限：发送一次 resync 信号
        state.throttled = true;

        const entry = this._watchers.get(watchKey);
        if (entry) {
          const win = this._getDesktopWindow ? this._getDesktopWindow() : null;
          if (win && !win.isDestroyed()) {
            win.webContents.send('nativeFs:change', {
              mountId: entry.mountId,
              directoryPath: entry.relativePath,
              changes: [],
              resync: true,
            });
          }
        }
      }
      return true;
    }

    return false;
  }
}

// 导出单例
module.exports = new NativeFsWatcher();
