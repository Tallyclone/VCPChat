const fs = require("fs-extra");
const path = require("path");
const { moveWithRetry, listOrphanTmpFiles } = require("../projector/atomicWriter");

// All state file access is serialized through this queue so a read can never
// observe a half-written or momentarily replaced file.
let stateQueue = Promise.resolve();

function serialized(task) {
  const run = stateQueue.then(task, task);
  stateQueue = run.catch(() => {});
  return run;
}

function isTransientReadError(error) {
  return Boolean(
    error &&
      ["ENOENT", "EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE"].includes(
        error.code
      )
  );
}

function defaultState(config) {
  return {
    schema_version: 1,
    mode: config.mode || "uninitialized",
    enabled: config.enabled,
    last_applied_seq: 0,
    created_at: new Date().toISOString(),
  };
}

function parseStateText(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("state.json root must be an object");
  }
  return parsed;
}

function looksLikeState(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (typeof parsed.mode === "string" || parsed.last_applied_seq !== undefined)
  );
}

async function ensureAdapterState(config, logger) {
  await fs.ensureDir(config.syncDir);
  await fs.ensureFile(config.queuePath);
  await fs.ensureFile(config.lockPath);
  if (!(await fs.pathExists(config.statePath))) {
    await writeState(config, defaultState(config), logger);
  }
}

async function writeStateUnlocked(config, state) {
  await fs.ensureDir(path.dirname(config.statePath));
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tmp = `${config.statePath}.tmp-${token}`;
  try {
    await fs.writeJson(
      tmp,
      { ...state, updated_at: new Date().toISOString() },
      { spaces: 2 }
    );
    await fs.readJson(tmp);
    await moveWithRetry(tmp, config.statePath);
  } catch (error) {
    await fs.remove(tmp).catch(() => {});
    throw error;
  }
}

// An earlier adapter deleted state.json before renaming its temp file, so a
// failed rename could leave the newest state only in `state.json.tmp-*`.
// Adopt such a snapshot when it is newer than the main file, then clean up.
async function adoptNewerTmpSnapshot(config, logger, mainMtimeMs) {
  const orphans = await listOrphanTmpFiles(config.statePath);
  if (orphans.length === 0) return null;
  let adopted = null;
  let adoptedMtime = mainMtimeMs;
  for (const orphanPath of orphans) {
    const stat = await fs.stat(orphanPath).catch(() => null);
    if (!stat || stat.mtimeMs <= adoptedMtime) continue;
    const raw = await fs.readFile(orphanPath, "utf8").catch(() => null);
    if (raw === null) continue;
    try {
      const parsed = parseStateText(raw);
      if (!looksLikeState(parsed)) continue;
      adopted = parsed;
      adoptedMtime = stat.mtimeMs;
    } catch (_) {
      // ignore unparsable temp snapshots
    }
  }
  for (const orphanPath of orphans) {
    await fs.remove(orphanPath).catch(() => {});
  }
  if (adopted && logger && logger.warn) {
    logger.warn("state.json recovered from a newer temp snapshot", {
      statePath: config.statePath,
    });
  }
  return adopted;
}

async function readStateUnlocked(config, logger) {
  let raw = null;
  let mainMtimeMs = 0;
  try {
    raw = await fs.readFile(config.statePath, "utf8");
    const stat = await fs.stat(config.statePath).catch(() => null);
    mainMtimeMs = stat ? stat.mtimeMs : 0;
  } catch (error) {
    if (!isTransientReadError(error)) throw error;
    if (error.code !== "ENOENT") throw error;
    // A missing file is an I/O condition, not data corruption. Never reset
    // the sync cursor for it. Prefer a temp snapshot, else recreate defaults.
    const adopted = await adoptNewerTmpSnapshot(config, logger, 0);
    const state = adopted || defaultState(config);
    if (!adopted && logger && logger.warn) {
      logger.warn("state.json missing; recreating default state", {
        statePath: config.statePath,
      });
    }
    await writeStateUnlocked(config, state);
    return state;
  }
  let state = null;
  try {
    state = parseStateText(raw);
  } catch (error) {
    const adopted = await adoptNewerTmpSnapshot(config, logger, 0);
    if (adopted) {
      await writeStateUnlocked(config, adopted);
      return adopted;
    }
    const corruptPath = `${config.statePath}.corrupt-${Date.now()}`;
    await fs.writeFile(corruptPath, raw, "utf8").catch(() => {});
    logger.error("state.json corrupt; entering recovering mode", {
      corruptPath,
      error: error.message,
    });
    const recovering = {
      schema_version: 1,
      mode: "recovering",
      enabled: false,
      last_applied_seq: 0,
      recovering_reason: "state_json_corrupt",
      recovered_at: new Date().toISOString(),
    };
    await writeStateUnlocked(config, recovering);
    return recovering;
  }
  const adopted = await adoptNewerTmpSnapshot(config, logger, mainMtimeMs);
  if (adopted) {
    await writeStateUnlocked(config, adopted);
    return adopted;
  }
  return state;
}

async function readState(config, logger) {
  return serialized(() => readStateUnlocked(config, logger));
}

async function writeState(config, state) {
  return serialized(() => writeStateUnlocked(config, state));
}

module.exports = { ensureAdapterState, readState, writeState };
