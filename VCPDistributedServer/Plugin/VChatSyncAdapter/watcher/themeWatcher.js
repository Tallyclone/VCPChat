const chokidar = require("chokidar");
const { syncLocalThemes } = require("../diff/themeDiffEngine");

function createThemeWatcher(config, localIndex, centerClient, logger, context = {}) {
  let watcher = null;
  let pending = null;
  let stopped = true;
  const running = new Set();

  async function processThemeEvent(filePath) {
    if (stopped) return;
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
    if (stopped) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const task = processThemeEvent(filePath);
      running.add(task);
      task.then(() => running.delete(task), () => running.delete(task));
    }, config.watchDebounceMs || 700);
  }

  return {
    async start() {
      const watchPaths = [config.themeStylesDir, config.wallpaperDir].filter(Boolean);
      if (watchPaths.length === 0) return;
      stopped = false;
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
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        watcher.once("error", onError);
        watcher.once("ready", () => {
          watcher.removeListener("error", onError);
          resolve();
        });
      });
      if (logger && logger.info) {
        logger.info("theme watcher started", { watchPaths });
      }
    },
    async stop() {
      stopped = true;
      if (pending) clearTimeout(pending);
      pending = null;
      if (watcher) await watcher.close();
      watcher = null;
      await Promise.allSettled([...running]);
    },
  };
}

module.exports = { createThemeWatcher };
