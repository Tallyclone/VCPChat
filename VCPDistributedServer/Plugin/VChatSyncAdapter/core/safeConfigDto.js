const {
  SENSITIVE_KEY_PATTERN,
  schemaForPath,
  buildSafeConfigDto,
} = require("./configSchema");

function safeConfigDto(relativePath, parsedJson, options = {}) {
  return buildSafeConfigDto(relativePath, parsedJson, options);
}

module.exports = { safeConfigDto, schemaForPath, SENSITIVE_KEY_PATTERN };
