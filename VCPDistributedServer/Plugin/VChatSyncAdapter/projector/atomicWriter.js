const fs = require("fs-extra");
const path = require("path");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonFile(filePath) {
  const value = await fs.readJson(filePath);
  return value;
}

// Atomic in-place replace. fs.rename replaces the destination in one step
// (POSIX rename / Windows MoveFileEx with MOVEFILE_REPLACE_EXISTING). Unlike
// fs-extra's move({overwrite:true}), which deletes the target first, the
// destination can never be observed missing, and a failure leaves the previous
// file intact.
async function moveWithRetry(source, target, logger, attempts = 6) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (error && error.code === "EXDEV") {
        await fs.copy(source, target, { overwrite: true });
        await fs.remove(source).catch(() => {});
        return;
      }
      lastError = error;
      if (logger && logger.warn) {
        logger.warn("atomic move retry", {
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

// Temp files this module (and the queue/index/state writers) may have left
// behind after a failed rename: `<file>.tmp-<pid>-<time>-<random>`.
async function listOrphanTmpFiles(filePath) {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.tmp-`;
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name))
    .sort();
}

async function readRawIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function staleFileError(filePath) {
  const error = new Error(
    `file changed on disk between read and write: ${filePath}`
  );
  error.code = "STALE_FILE";
  error.filePath = filePath;
  return error;
}

// options.expectedRaw: the exact text the caller read before computing
// `value`. If the file no longer matches (another writer such as the host app
// saved in between), the write is refused with code STALE_FILE so the caller
// can re-read and merge instead of overwriting foreign changes. `null` means
// the caller expects the file not to exist yet.
async function atomicWriteJson(filePath, value, options = {}) {
  const logger = options.logger || null;
  await fs.ensureDir(path.dirname(filePath));

  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tmp = `${filePath}.tmp-${token}`;
  const backup = `${filePath}.backup-${token}`;
  const hadOriginal = await fs.pathExists(filePath);

  if (options.expectedRaw !== undefined) {
    const currentRaw = await readRawIfExists(filePath);
    if (currentRaw !== options.expectedRaw) throw staleFileError(filePath);
  }

  await fs.writeJson(tmp, value, { spaces: 2 });
  await parseJsonFile(tmp);

  if (hadOriginal) {
    await fs.copy(filePath, backup, { overwrite: true });
    await parseJsonFile(backup);
  }

  try {
    if (options.expectedRaw !== undefined) {
      // Re-check right before the rename to shrink the race window as far as
      // the filesystem allows.
      const currentRaw = await readRawIfExists(filePath);
      if (currentRaw !== options.expectedRaw) throw staleFileError(filePath);
    }
    await moveWithRetry(tmp, filePath, logger);
    await parseJsonFile(filePath);
    await fs.remove(backup).catch(() => {});
    return { ok: true, filePath };
  } catch (error) {
    await fs.remove(tmp).catch(() => {});
    if (error && error.code === "STALE_FILE") {
      await fs.remove(backup).catch(() => {});
      throw error;
    }
    if (logger && logger.error) {
      logger.error("atomic json write failed; restoring this-write backup", {
        filePath,
        error: error.message,
      });
    }
    if (hadOriginal && (await fs.pathExists(backup))) {
      await moveWithRetry(backup, filePath, logger).catch(async () => {
        await fs.copy(backup, filePath, { overwrite: true });
      });
      await parseJsonFile(filePath);
      await fs.remove(backup).catch(() => {});
    }
    throw error;
  }
}

const STALE_RETRY_ATTEMPTS = 6;

// Run a read-modify-write task. When the write reports STALE_FILE (another
// writer, typically the host app, changed the file in between), re-run the
// task so it re-reads and merges on top of the newest content.
async function withStaleRetry(task, describe = "projection") {
  let lastError = null;
  for (let attempt = 0; attempt < STALE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      if (!error || error.code !== "STALE_FILE") throw error;
      lastError = error;
      await wait(25 * (attempt + 1));
    }
  }
  const error = new Error(
    `${describe} lost the write race ${STALE_RETRY_ATTEMPTS} times: ${
      lastError && lastError.filePath
    }`
  );
  error.code = "STALE_FILE";
  error.filePath = lastError && lastError.filePath;
  throw error;
}

module.exports = {
  atomicWriteJson,
  moveWithRetry,
  listOrphanTmpFiles,
  readRawIfExists,
  withStaleRetry,
};
