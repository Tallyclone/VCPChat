const chokidar = require("chokidar");
const path = require("path");
const { debounce } = require("../utils/debounce");
const { syncLocalThemes } = require("../diff/themeDiffEngine");

function createThemeWatcher(config, localIndex, centerClient, logger, context = {}) {
  let watcher = null;
  let pending = null;

  async function processThemeEvent(filePath) {
    if (logger && logger.debug) {
      logger.debug("theme source file changed", { filePath });
    }
    try {
      await syncLocalThemes(config, localIndex, centerClient, logger, context);
    } catch (error) {
      if (logger && logger.warn) {
        logger.warn("theme sync failed", { error: error.message, filePath });
      }
    }
  }

  function schedule(filePath) {
    if (!pending) pending = debounce(processThemeEvent, config.watchDebounceMs || 700);
    pending(filePath);
  }

  return {
    async start() {
      const watchPaths = [config.themeStylesDir, config.wallpaperDir].filter(Boolean);
      if (watchPaths.length === 0) return;
      watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        awaitWriteFinish: false,
        persistent: true,
      });
      watcher.on("add", schedule);
      watcher.on("change", schedule);
      watcher.on("unlink", schedule);
      watcher.on("error", (error) => {
        if (logger && logger.error) logger.error("theme watcher error", { error: error.message });
      });
      if (logger && logger.info) {
        logger.info("theme watcher started", { watchPaths });
      }
    },
    async stop() {
      if (watcher) await watcher.close();
      watcher = null;
      pending = null;
    },
  };
}

module.exports = { createThemeWatcher };
