const fs = require("fs-extra");

function createWriteIntentLock(config, logger) {
  async function append(intent) {
    await fs.ensureFile(config.lockPath);
    await fs.appendFile(
      config.lockPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ttl_ms: 10000,
        ...intent,
      })}\n`,
      "utf8"
    );
  }

  async function readActive() {
    await fs.ensureFile(config.lockPath);
    const raw = await fs.readFile(config.lockPath, "utf8");
    const now = Date.now();
    const active = [];
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        const ttl = Number(row.ttl_ms || 10000);
        if (Date.parse(row.ts) + ttl > now) active.push(row);
      } catch (error) {
        logger.warn("invalid write intent row ignored", {
          error: error.message,
        });
      }
    }
    if (active.length * 2 < raw.split(/\r?\n/).filter(Boolean).length) {
      await fs.writeFile(
        config.lockPath,
        active.map((row) => JSON.stringify(row)).join("\n") +
          (active.length ? "\n" : ""),
        "utf8"
      );
    }
    return active;
  }

  return {
    record: append,
    async isLocked(relativePath, checksum = null) {
      const active = await readActive();
      return active.some((row) => {
        const pathMatches =
          row.relative_path === relativePath || row.path === relativePath;
        if (!pathMatches) return false;
        if (!checksum || !row.expectedChecksum) return true;
        return row.expectedChecksum === checksum;
      });
    },
  };
}

module.exports = { createWriteIntentLock };
