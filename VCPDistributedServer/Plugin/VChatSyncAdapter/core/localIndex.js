const fs = require("fs-extra");
const path = require("path");
const {
  moveWithRetry,
  listOrphanTmpFiles,
} = require("../projector/atomicWriter");

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
  let mutationVersion = 0;
  let saveQueue = Promise.resolve();

  async function persistIfNeeded() {
    dirty = true;
    mutationVersion += 1;
    if (batchDepth === 0) await save();
  }

  function normalizeLoaded(parsed) {
    const next = { ...createEmptyIndex(), ...parsed };
    next.local_messages = next.local_messages || {};
    next.local_files = next.local_files || {};
    next.topic_snapshots = next.topic_snapshots || {};
    return next;
  }

  // Earlier adapters deleted local_index.json before renaming their temp
  // file, so a failed rename could leave the newest index only in
  // `local_index.json.tmp-*`. Adopt the newest parsable snapshot when it is
  // newer than the main file, then remove all temp leftovers.
  async function adoptNewerTmpSnapshot(mainMtimeMs) {
    const orphans = await listOrphanTmpFiles(config.indexPath);
    if (orphans.length === 0) return null;
    let adopted = null;
    let adoptedMtime = mainMtimeMs;
    for (const orphanPath of orphans) {
      const stat = await fs.stat(orphanPath).catch(() => null);
      if (!stat || stat.mtimeMs <= adoptedMtime) continue;
      const raw = await fs.readFile(orphanPath, "utf8").catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw);
        const looksLikeIndex =
          parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          ["local_messages", "local_files", "topic_snapshots"].some((field) =>
            parsed[field] && typeof parsed[field] === "object"
          );
        if (looksLikeIndex) {
          adopted = parsed;
          adoptedMtime = stat.mtimeMs;
        }
      } catch (_) {
        // ignore unparsable temp snapshots
      }
    }
    for (const orphanPath of orphans) {
      await fs.remove(orphanPath).catch(() => {});
    }
    if (logger && logger.warn) {
      logger.warn("local index temp files cleaned up", {
        indexPath: config.indexPath,
        orphan_files: orphans.length,
        adopted_newer_snapshot: Boolean(adopted),
      });
    }
    return adopted;
  }

  async function load() {
    await fs.ensureDir(path.dirname(config.indexPath));
    if (!(await fs.pathExists(config.indexPath))) {
      const adopted = await adoptNewerTmpSnapshot(0);
      if (adopted) data = normalizeLoaded(adopted);
      await save();
      return data;
    }
    // A transient I/O failure here propagates to the caller: it must retry
    // rather than silently rebuild an empty baseline.
    const raw = await fs.readFile(config.indexPath, "utf8");
    const stat = await fs.stat(config.indexPath).catch(() => null);
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("local_index.json root must be an object");
      }
    } catch (error) {
      const adopted = await adoptNewerTmpSnapshot(0);
      if (adopted) {
        data = normalizeLoaded(adopted);
        corrupted = false;
        await save();
        return data;
      }
      corrupted = true;
      const corruptPath = `${config.indexPath}.corrupt-${Date.now()}`;
      await fs.writeFile(corruptPath, raw, "utf8").catch(() => {});
      logger.error("local index corrupt; moved aside and rebuilt empty index", {
        corruptPath,
        error: error.message,
      });
      data = createEmptyIndex();
      await save();
      return data;
    }
    const adopted = await adoptNewerTmpSnapshot(stat ? stat.mtimeMs : 0);
    data = normalizeLoaded(adopted || parsed);
    corrupted = false;
    if (adopted) await save();
    return data;
  }

  async function saveSnapshot() {
    data.updated_at = new Date().toISOString();
    await fs.ensureDir(path.dirname(config.indexPath));
    const savedVersion = mutationVersion;
    const snapshot = JSON.parse(JSON.stringify(data));
    const token = `${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const tmp = `${config.indexPath}.tmp-${token}`;
    try {
      await fs.writeJson(tmp, snapshot, { spaces: 2 });
      await fs.readJson(tmp);
      await moveWithRetry(tmp, config.indexPath, logger);
      dirty = mutationVersion !== savedVersion;
    } catch (error) {
      await fs.remove(tmp).catch(() => {});
      throw error;
    }
  }

  function save() {
    const task = saveQueue.then(saveSnapshot, saveSnapshot);
    saveQueue = task.catch(() => {});
    return task;
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
    deleteMessagesByTopic: async (topicKey) => {
      for (const [key, value] of Object.entries(data.local_messages)) {
        if (value && value.topic_key === topicKey)
          delete data.local_messages[key];
      }
      await persistIfNeeded();
    },
    deleteMessagesByItem: async (itemType, itemId) => {
      for (const [key, value] of Object.entries(data.local_messages)) {
        const identity = (value && value.identity) || {};
        if (identity.item_type === itemType && identity.item_id === itemId) {
          delete data.local_messages[key];
        }
      }
      await persistIfNeeded();
    },
    setTopicSnapshot: async (topicKey, snapshot) => {
      data.topic_snapshots[topicKey] = snapshot;
      await persistIfNeeded();
    },
    getTopicSnapshot: (topicKey) => data.topic_snapshots[topicKey] || null,
    deleteTopicSnapshot: async (topicKey) => {
      delete data.topic_snapshots[topicKey];
      await persistIfNeeded();
    },
    deleteTopicSnapshotsByItem: async (itemType, itemId) => {
      const prefix = `${itemType}:${itemId}:`;
      for (const key of Object.keys(data.topic_snapshots)) {
        if (key.startsWith(prefix)) delete data.topic_snapshots[key];
      }
      await persistIfNeeded();
    },
    setFile: async (relativePath, fileRow) => {
      data.local_files[relativePath] = fileRow;
      await persistIfNeeded();
    },
    getFile: (relativePath) => data.local_files[relativePath] || null,
    deleteFile: async (relativePath) => {
      delete data.local_files[relativePath];
      await persistIfNeeded();
    },
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
