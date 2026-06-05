const fs = require("fs");
const path = require("path");

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
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

function parseItemTypeFromId(itemId) {
  if (!itemId) return "user";
  return String(itemId).startsWith("group_") ? "group" : "agent";
}

function resolveItemTypeFromAppData(itemId, options = {}) {
  if (!itemId) return "user";
  const appDataPath = options.appDataPath || options.app_data_path;
  if (appDataPath) {
    const groupConfigPath = path.join(
      appDataPath,
      "AgentGroups",
      String(itemId),
      "config.json"
    );
    const agentConfigPath = path.join(
      appDataPath,
      "Agents",
      String(itemId),
      "config.json"
    );
    const hasGroupConfig = fileExists(groupConfigPath);
    const hasAgentConfig = fileExists(agentConfigPath);
    if (hasGroupConfig && !hasAgentConfig) return "group";
    if (hasAgentConfig && !hasGroupConfig) return "agent";
    if (
      hasGroupConfig &&
      hasAgentConfig &&
      options.preferExistingConfig !== false
    ) {
      return String(itemId).startsWith("group_") ? "group" : "agent";
    }
  }
  return parseItemTypeFromId(itemId);
}

function parseHistoryIdentity(relativePath, options = {}) {
  const match = /^UserData\/([^/]+)\/topics\/([^/]+)\/history\.json$/i.exec(
    normalizeSlashes(relativePath)
  );
  if (!match) return null;
  const itemId = decodeURIComponent(match[1]);
  return {
    item_type: resolveItemTypeFromAppData(itemId, options),
    item_id: itemId,
    topic_id: decodeURIComponent(match[2]),
  };
}

function parseTopicDirIdentity(relativePath, options = {}) {
  const match = /^UserData\/([^/]+)\/topics\/([^/]+)$/i.exec(
    normalizeSlashes(relativePath).replace(/\/$/, "")
  );
  if (!match) return null;
  const itemId = decodeURIComponent(match[1]);
  return {
    item_type: resolveItemTypeFromAppData(itemId, options),
    item_id: itemId,
    topic_id: decodeURIComponent(match[2]),
  };
}

function parseItemDirIdentity(relativePath) {
  const normalized = normalizeSlashes(relativePath).replace(/\/$/, "");
  let match = /^Agents\/([^/]+)$/i.exec(normalized);
  if (match)
    return { item_type: "agent", item_id: decodeURIComponent(match[1]) };
  match = /^AgentGroups\/([^/]+)$/i.exec(normalized);
  if (match)
    return { item_type: "group", item_id: decodeURIComponent(match[1]) };
  return null;
}

function parseConfigIdentity(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  let match = /^Agents\/([^/]+)\/config\.json$/i.exec(normalized);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    return {
      schema: "agent_config",
      entity_id: normalized,
      item_type: "agent",
      item_id: itemId,
    };
  }
  match = /^AgentGroups\/([^/]+)\/config\.json$/i.exec(normalized);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    return {
      schema: "group_config",
      entity_id: normalized,
      item_type: "group",
      item_id: itemId,
    };
  }
  return null;
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

function isSafeUserAvatarUrlPath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return (
    normalized &&
    !normalized.startsWith("/") &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    /\.(?:png|jpe?g|webp|gif)$/i.test(normalized)
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
  if (/^avatarimage\/[^/]+\.(?:png|jpe?g|webp|gif)$/i.test(normalized)) {
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

function isThemeStylePath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return /^styles\/themes\/[^/]+\.css$/i.test(normalized);
}

function isWallpaperPath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  return /^assets\/wallpaper\/[^/]+\.(?:png|jpe?g|webp)$/i.test(normalized);
}

module.exports = {
  normalizeSlashes,
  relativeAppDataPath,
  assertInsideAppData,
  safeJoinAppData,
  assertSafePathSegment,
  isHistoryPath,
  parseItemTypeFromId,
  resolveItemTypeFromAppData,
  parseHistoryIdentity,
  parseTopicDirIdentity,
  parseItemDirIdentity,
  parseConfigIdentity,
  isConfigPath,
  isAvatarPath,
  isSafeUserAvatarUrlPath,
  parseAvatarIdentity,
  isAttachmentLikePath,
  isThemeStylePath,
  isWallpaperPath,
};
