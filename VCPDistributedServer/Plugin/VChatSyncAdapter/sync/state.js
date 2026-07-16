const fs = require("fs-extra");
const path = require("path");

let stateWriteQueue = Promise.resolve();

async function ensureAdapterState(config, logger) {
  await fs.ensureDir(config.syncDir);
  await fs.ensureFile(config.queuePath);
  await fs.ensureFile(config.lockPath);
  if (!(await fs.pathExists(config.statePath))) {
    await writeState(
      config,
      {
        schema_version: 1,
        mode: config.mode || "uninitialized",
        enabled: config.enabled,
        last_applied_seq: 0,
        created_at: new Date().toISOString(),
      },
      logger
    );
  }
}

async function readState(config, logger) {
  try {
    return await fs.readJson(config.statePath);
  } catch (error) {
    const corruptPath = `${config.statePath}.corrupt-${Date.now()}`;
    if (await fs.pathExists(config.statePath))
      await fs.move(config.statePath, corruptPath, { overwrite: true });
    logger.error("state.json corrupt; entering recovering mode", {
      corruptPath,
      error: error.message,
    });
    const state = {
      schema_version: 1,
      mode: "recovering",
      enabled: false,
      last_applied_seq: 0,
      recovered_at: new Date().toISOString(),
    };
    await writeState(config, state, logger);
    return state;
  }
}

async function writeState(config, state) {
  const writeTask = async () => {
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
      await fs.move(tmp, config.statePath, { overwrite: true });
    } catch (error) {
      await fs.remove(tmp).catch(() => {});
      throw error;
    }
  };

  stateWriteQueue = stateWriteQueue.then(writeTask, writeTask);
  return stateWriteQueue;
}

module.exports = { ensureAdapterState, readState, writeState };
