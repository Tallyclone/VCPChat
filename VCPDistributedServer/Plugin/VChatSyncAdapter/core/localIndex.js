const fs = require("fs-extra");
const path = require("path");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveWithRetry(source, target, logger, attempts = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.move(source, target, { overwrite: true });
      return;
    } catch (error) {
      lastError = error;
      if (logger && logger.warn) {
        logger.warn("local index move retry", {
          target,
          attempt: attempt + 1,
          error: error.message,
        });
      }
      await wait(Math.min(1000, 100 * 2 ** attempt));
    }
  }
  throw lastError;
}

function createEmptyIndex() {
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    local_messages: {},
    local_files: {},
    topic_snapshots: {},
  };
}

function createLocalIndex(config, logger) {
  let data = createEmptyIndex();
  let corrupted = false;
  let batchDepth = 0;
  let dirty = false;

  async function persistIfNeeded() {
    dirty = true;
    if (batchDepth === 0) await save();
  }

  async function load() {
    await fs.ensureDir(path.dirname(config.indexPath));
    if (!(await fs.pathExists(config.indexPath))) {
      await save();
      return data;
    }
    try {
      data = {
        ...createEmptyIndex(),
        ...(await fs.readJson(config.indexPath)),
      };
      data.local_messages = data.local_messages || {};
      data.local_files = data.local_files || {};
      data.topic_snapshots = data.topic_snapshots || {};
      corrupted = false;
      return data;
    } catch (error) {
      corrupted = true;
      const corruptPath = `${config.indexPath}.corrupt-${Date.now()}`;
      await fs.move(config.indexPath, corruptPath, { overwrite: true });
      logger.error("local index corrupt; moved aside and rebuilt empty index", {
        corruptPath,
        error: error.message,
      });
      data = createEmptyIndex();
      await save();
      return data;
    }
  }

  async function save() {
    data.updated_at = new Date().toISOString();
    await fs.ensureDir(path.dirname(config.indexPath));
    const token = `${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const tmp = `${config.indexPath}.tmp-${token}`;
    try {
      await fs.writeJson(tmp, data, { spaces: 2 });
      await fs.readJson(tmp);
      await moveWithRetry(tmp, config.indexPath, logger);
      dirty = false;
    } catch (error) {
      await fs.remove(tmp).catch(() => {});
      throw error;
    }
  }

  async function batchUpdate(mutator) {
    batchDepth += 1;
    try {
      const result = await mutator(data);
      return result;
    } finally {
      batchDepth -= 1;
      if (batchDepth === 0 && dirty) await save();
    }
  }

  return {
    load,
    save,
    batchUpdate,
    isCorrupted: () => corrupted,
    getMessage: (key) => data.local_messages[key] || null,
    setMessage: async (key, row) => {
      data.local_messages[key] = row;
      await persistIfNeeded();
    },
    deleteMessage: async (key) => {
      delete data.local_messages[key];
      await persistIfNeeded();
    },
    listMessagesByTopic: (topicKey) =>
      Object.fromEntries(
        Object.entries(data.local_messages).filter(
          ([, value]) => value.topic_key === topicKey
        )
      ),
    setTopicSnapshot: async (topicKey, snapshot) => {
      data.topic_snapshots[topicKey] = snapshot;
      await persistIfNeeded();
    },
    getTopicSnapshot: (topicKey) => data.topic_snapshots[topicKey] || null,
    setFile: async (relativePath, fileRow) => {
      data.local_files[relativePath] = fileRow;
      await persistIfNeeded();
    },
    getFile: (relativePath) => data.local_files[relativePath] || null,
    stats: () => ({
      messages: Object.keys(data.local_messages).length,
      files: Object.keys(data.local_files).length,
      topics: Object.keys(data.topic_snapshots).length,
      corrupted,
    }),
    raw: () => data,
  };
}

module.exports = { createLocalIndex };
