const path = require("path");

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function relativeAppDataPath(appDataPath, filePath) {
  return normalizeSlashes(path.relative(appDataPath, filePath));
}

function isHistoryPath(relativePath) {
  return /^UserData\/[^/]+\/topics\/[^/]+\/history\.json$/i.test(
    normalizeSlashes(relativePath)
  );
}

function parseHistoryIdentity(relativePath) {
  const match = /^UserData\/([^/]+)\/topics\/([^/]+)\/history\.json$/i.exec(
    normalizeSlashes(relativePath)
  );
  if (!match) return null;
  return {
    item_type: "user",
    item_id: decodeURIComponent(match[1]),
    topic_id: decodeURIComponent(match[2]),
  };
}

function isConfigPath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return /(^Agents\/[^/]+\/(config|regex_rules)\.json$)|(^AgentGroups\/[^/]+\/config\.json$)|(^UserData\/(memo|forum)\.config\.json$)|(^settings\.json$)/i.test(
    normalized
  );
}

function isAttachmentLikePath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return (
    /^user_avatar\./i.test(normalized) ||
    /^avatarimage\//i.test(normalized) ||
    /^Agents\/[^/]+\/avatar\./i.test(normalized) ||
    /(^|\/)attachments?\//i.test(normalized) ||
    /(^|\/)fileManager\//i.test(normalized)
  );
}

module.exports = {
  normalizeSlashes,
  relativeAppDataPath,
  isHistoryPath,
  parseHistoryIdentity,
  isConfigPath,
  isAttachmentLikePath,
};
