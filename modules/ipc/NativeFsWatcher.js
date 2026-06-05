'use strict';

const path = require('path');

const MAX_WATCHERS = 8;
const EVENT_BATCH_MS = 300;
const HIGH_FREQ_WINDOW_MS = 1000;
const HIGH_FREQ_LIMIT = 100;
const RECOVER_AFTER_MS = 2000;

class NativeFsWatcher {
    constructor({ sendToDesktop, service }) {
        this.sendToDesktop = sendToDesktop;
        this.service = service;
        this.watchers = new Map();
        this.chokidar = null;
    }

    _loadChokidar() {
        if (!this.chokidar) {
            this.chokidar = require('chokidar');
        }
        return this.chokidar;
    }

    async watch(mountId, dirPath) {
        const mount = this.service.getMount(mountId);
        if (!mount || !mount.realtime) {
            return { success: true, paused: true };
        }

        await this.unwatch(mountId, { keepRegistry: true });
        await this._enforceLimit(mountId);

        const chokidar = this._loadChokidar();
        const entry = {
            mountId,
            dirPath,
            watcher: null,
            pending: new Map(),
            batchTimer: null,
            recentEvents: [],
            degraded: false,
            recoverTimer: null,
            lastActive: Date.now(),
        };

        const watcher = chokidar.watch(dirPath, {
            depth: 0,
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        });
        entry.watcher = watcher;
        this.watchers.set(mountId, entry);
        mount.currentWatchDir = dirPath;
        mount.watcher = watcher;

        const onChange = (type) => async (changedPath) => {
            await this._handleFsEvent(entry, type, changedPath);
        };

        watcher.on('add', onChange('add'));
        watcher.on('addDir', onChange('add'));
        watcher.on('change', onChange('change'));
        watcher.on('unlink', onChange('unlink'));
        watcher.on('unlinkDir', onChange('unlink'));
        watcher.on('error', (error) => {
            this._sendResync(mountId, error?.message || 'watcher_error');
        });

        return { success: true, dirPath };
    }

    async unwatch(mountId, options = {}) {
        const entry = this.watchers.get(mountId);
        if (!entry) return { success: true };

        if (entry.batchTimer) clearTimeout(entry.batchTimer);
        if (entry.recoverTimer) clearTimeout(entry.recoverTimer);
        this.watchers.delete(mountId);

        const mount = this.service.getMount(mountId);
        if (mount) {
            mount.watcher = null;
            mount.currentWatchDir = null;
        }

        try {
            await entry.watcher.close();
        } catch (error) {
            console.warn('[NativeFsWatcher] close watcher failed:', error.message);
        }

        return { success: true, keepRegistry: !!options.keepRegistry };
    }

    async closeAll() {
        const ids = Array.from(this.watchers.keys());
        await Promise.all(ids.map((id) => this.unwatch(id)));
    }

    async _enforceLimit(incomingMountId) {
        if (this.watchers.size < MAX_WATCHERS) return;

        let lru = null;
        for (const entry of this.watchers.values()) {
            if (entry.mountId === incomingMountId) continue;
            if (!lru || entry.lastActive < lru.lastActive) {
                lru = entry;
            }
        }

        if (lru) {
            await this.unwatch(lru.mountId);
            this._sendResync(lru.mountId, 'watcher_lru_paused');
        }
    }

    async _handleFsEvent(entry, type, changedPath) {
        entry.lastActive = Date.now();
        const now = Date.now();
        entry.recentEvents = entry.recentEvents.filter((time) => now - time <= HIGH_FREQ_WINDOW_MS);
        entry.recentEvents.push(now);

        if (entry.recentEvents.length > HIGH_FREQ_LIMIT) {
            if (!entry.degraded) {
                entry.degraded = true;
                entry.pending.clear();
                if (entry.batchTimer) {
                    clearTimeout(entry.batchTimer);
                    entry.batchTimer = null;
                }
                this._sendResync(entry.mountId, 'high_frequency_changes');
            }
            if (entry.recoverTimer) clearTimeout(entry.recoverTimer);
            entry.recoverTimer = setTimeout(() => {
                entry.degraded = false;
                entry.recentEvents = [];
            }, RECOVER_AFTER_MS);
            return;
        }

        if (entry.degraded) return;

        let item = { type, entry: null, path: changedPath };
        try {
            if (type !== 'unlink') {
                item.entry = await this.service.buildEntry(entry.mountId, changedPath);
            }
        } catch (error) {
            item.error = error.code || error.message;
        }

        entry.pending.set(path.normalize(changedPath), item);
        if (entry.batchTimer) clearTimeout(entry.batchTimer);
        entry.batchTimer = setTimeout(() => this._flush(entry), EVENT_BATCH_MS);
    }

    _flush(entry) {
        entry.batchTimer = null;
        const changes = Array.from(entry.pending.values());
        entry.pending.clear();
        if (changes.length === 0) return;
        this.sendToDesktop('desktop:nfs:changed', {
            mountId: entry.mountId,
            changes,
        });
    }

    _sendResync(mountId, reason) {
        this.sendToDesktop('desktop:nfs:resyncRequired', { mountId, reason });
    }
}

module.exports = NativeFsWatcher;
