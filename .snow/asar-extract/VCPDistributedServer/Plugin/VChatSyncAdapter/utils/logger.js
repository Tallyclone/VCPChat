const fs = require('fs-extra');

function createLogger(scope, debug = false) {
  function write(level, message, meta) {
    const line = `[${new Date().toISOString()}] [${scope}] [${level}] ${message}`;
    if (level === 'error') console.error(line, meta || '');
    else if (level === 'warn') console.warn(line, meta || '');
    else if (debug || level !== 'debug') console.log(line, meta || '');
  }
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    async file(filePath, record) {
      await fs.ensureDir(require('path').dirname(filePath));
      await fs.appendFile(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
    },
  };
}

module.exports = { createLogger };
