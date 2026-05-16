const {
  SENSITIVE_KEY_PATTERN,
  schemaForPath,
  buildSafeConfigDto,
} = require("./configSchema");

function safeConfigDto(relativePath, parsedJson) {
  return buildSafeConfigDto(relativePath, parsedJson);
}

module.exports = { safeConfigDto, schemaForPath, SENSITIVE_KEY_PATTERN };
