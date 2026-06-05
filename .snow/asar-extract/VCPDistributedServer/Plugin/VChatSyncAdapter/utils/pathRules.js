const path = require("path");

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function relativeAppDataPath(appDataPath, filePath) {
  return normalizeSlashes(path.relative(appDataPath, filePath));
}

function assertInsideAppData(appDataPath, filePath) {
  const relativePath = path.relative(appDataPath, filePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`path escapes appDataPath: ${filePath}`);
  }
  return normalizeSlashes(relativePath);
}

function safeJoinAppData(appDataPath, ...segments) {
  const filePath = path.join(appDataPath, ...segments);
  assertInsideAppData(appDataPath, filePath);
  return filePath;
}

function assertSafePathSegment(segment, label = "path segment") {
  const value = String(segment || "");
  const normalized = normalizeSlashes(value);
  if (
    !value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    path.isAbsolute(value)
  ) {
    throw new Error(`unsafe ${label}: ${segment}`);
  }
  return value;
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
  return /(^Agents\/[^/]+\/(config|regex_rules)\.json$)|(^AgentGroups\/[^/]+\/config\.json$)|(^global_prompt_warehouse\.json$)|(^systemPromptPresets\/.+\.json$)|(^UserData\/(memo|forum)\.config\.json$)|(^settings\.json$)/i.test(
    normalized
  );
}

function isAvatarPath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return (
    /^user_avatar\.[^/]+$/i.test(normalized) ||
    /^Agents\/[^/]+\/avatar\.[^/]+$/i.test(normalized) ||
    /^AgentGroups\/[^/]+\/avatar\.[^/]+$/i.test(normalized)
  );
}

function parseAvatarIdentity(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  let match = /^Agents\/([^/]+)\/avatar\.[^/]+$/i.exec(normalized);
  if (match) {
    return {
      owner_type: "agent",
      owner_id: decodeURIComponent(match[1]),
    };
  }
  match = /^AgentGroups\/([^/]+)\/avatar\.[^/]+$/i.exec(normalized);
  if (match) {
    return {
      owner_type: "group",
      owner_id: decodeURIComponent(match[1]),
    };
  }
  if (/^user_avatar\.[^/]+$/i.test(normalized)) {
    return {
      owner_type: "user",
      owner_id: "local_user",
    };
  }
  return null;
}

function isAttachmentLikePath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return (
    isAvatarPath(normalized) ||
    /^avatarimage\//i.test(normalized) ||
    /(^|\/)attachments?\//i.test(normalized) ||
    /(^|\/)fileManager\//i.test(normalized)
  );
}

module.exports = {
  normalizeSlashes,
  relativeAppDataPath,
  assertInsideAppData,
  safeJoinAppData,
  assertSafePathSegment,
  isHistoryPath,
  parseHistoryIdentity,
  isConfigPath,
  isAvatarPath,
  parseAvatarIdentity,
  isAttachmentLikePath,
};
