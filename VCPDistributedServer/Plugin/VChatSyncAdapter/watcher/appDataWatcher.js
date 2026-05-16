const chokidar = require('chokidar');
const path = require('path');
const { debounce } = require('../utils/debounce');
const { relativeAppDataPath, isHistoryPath, isConfigPath, isAttachmentLikePath } = require('../utils/pathRules');
const { handleFile } = require('../scanner/appDataScanner');

function createWatcher(config, localIndex, offlineQueue, writeIntentLock, logger, context = {}) {
  let watcher = null;
  const pendingHandlers = new Map();

  async function processFile(filePath) {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith('sync/')) return;
    if (!isHistoryPath(relativePath) && !isConfigPath(relativePath) && !isAttachmentLikePath(relativePath)) return;
    const mode = context.modeProvider ? context.modeProvider() : context.mode;
    try {
      await handleFile(config.appDataPath, filePath, localIndex, offlineQueue, writeIntentLock, logger, {
        mode,
        deviceId: context.deviceId,
      });
    } catch (error) {
      logger.warn('watch event handling failed', { relativePath, error: error.message });
    }
  }

  return {
    async start() {
      watcher = chokidar.watch(config.appDataPath, {
        ignored: [path.join(config.syncDir, '**')],
        ignoreInitial: true,
        awaitWriteFinish: false,
        persistent: true,
      });
      watcher.on('add', (filePath) => {
        if (!pendingHandlers.has(filePath)) pendingHandlers.set(filePath, debounce(processFile, config.watchDebounceMs));
        pendingHandlers.get(filePath)(filePath);
      });
      watcher.on('change', (filePath) => {
        if (!pendingHandlers.has(filePath)) pendingHandlers.set(filePath, debounce(processFile, config.watchDebounceMs));
        pendingHandlers.get(filePath)(filePath);
      });
      watcher.on('error', (error) => logger.error('watcher error', { error: error.message }));
      logger.info('watcher started', { appDataPath: config.appDataPath });
    },
    async stop() {
      if (watcher) await watcher.close();
      watcher = null;
      pendingHandlers.clear();
    },
  };
}

module.exports = { createWatcher };
