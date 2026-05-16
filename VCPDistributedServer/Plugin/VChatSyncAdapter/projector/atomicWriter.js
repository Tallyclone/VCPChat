const fs = require("fs-extra");
const path = require("path");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonFile(filePath) {
  const value = await fs.readJson(filePath);
  return value;
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

async function atomicWriteJson(filePath, value, options = {}) {
  const logger = options.logger || null;
  await fs.ensureDir(path.dirname(filePath));

  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tmp = `${filePath}.tmp-${token}`;
  const backup = `${filePath}.backup-${token}`;
  const hadOriginal = await fs.pathExists(filePath);

  await fs.writeJson(tmp, value, { spaces: 2 });
  await parseJsonFile(tmp);

  if (hadOriginal) {
    await fs.copy(filePath, backup, { overwrite: true });
    await parseJsonFile(backup);
  }

  try {
    await moveWithRetry(tmp, filePath, logger);
    await parseJsonFile(filePath);
    await fs.remove(backup).catch(() => {});
    return { ok: true, filePath };
  } catch (error) {
    if (logger && logger.error) {
      logger.error("atomic json write failed; restoring this-write backup", {
        filePath,
        error: error.message,
      });
    }
    await fs.remove(tmp).catch(() => {});
    if (hadOriginal && (await fs.pathExists(backup))) {
      await moveWithRetry(backup, filePath, logger).catch(async () => {
        await fs.copy(backup, filePath, { overwrite: true });
      });
      await parseJsonFile(filePath);
    }
    throw error;
  }
}

module.exports = { atomicWriteJson };
