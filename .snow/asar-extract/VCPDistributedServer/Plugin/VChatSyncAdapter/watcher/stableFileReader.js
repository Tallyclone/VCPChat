const fs = require('fs-extra');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statSignature(filePath) {
  const stat = await fs.stat(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
}

async function readStableJson(filePath, options = {}) {
  const stableDelayMs = options.stableDelayMs || 200;
  const timeoutMs = options.timeoutMs || 5000;
  const maxParseRetries = options.maxParseRetries || 4;
  const started = Date.now();
  let previous = await statSignature(filePath);

  while (Date.now() - started < timeoutMs) {
    await wait(stableDelayMs);
    const next = await statSignature(filePath);
    if (next === previous) break;
    previous = next;
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxParseRetries; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return { ok: true, value: JSON.parse(raw), raw };
    } catch (error) {
      lastError = error;
      await wait(Math.min(1000, 100 * (2 ** attempt)));
    }
  }

  return { ok: false, error: lastError ? lastError.message : 'unknown read error' };
}

module.exports = { readStableJson };
