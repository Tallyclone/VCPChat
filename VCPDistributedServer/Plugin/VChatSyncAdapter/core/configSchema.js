const SENSITIVE_KEY_PATTERN =
  /key|token|secret|password|cookie|credential|auth|apikey|bearer/i;

const AGENT_ALLOWED = new Set([
  "name",
  "systemPrompt",
  "originalSystemPrompt",
  "advancedSystemPrompt",
  "syncPrompt",
  "promptMode",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
  "topics",
  "disableCustomColors",
  "useThemeColorsInChat",
  "avatarBorderColor",
  "nameTextColor",
  "customCss",
  "cardCss",
  "chatCss",
  "ttsVoicePrimary",
  "ttsRegexPrimary",
  "ttsVoiceSecondary",
  "ttsRegexSecondary",
  "ttsSpeed",
  "stripRegexes",
  "regex_rules",
]);

const GROUP_ALLOWED = new Set([
  "name",
  "description",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics",
]);

const SETTINGS_ALLOWED = new Set([
  "displayName",
  "username",
  "theme",
  "fontSize",
  "chatFontSize",
  "messageSpacing",
  "bubbleStyle",
  "sortOrder",
  "ttsVoicePrimary",
  "ttsVoiceSecondary",
  "ttsSpeed",
  "streamOutput",
]);

const TOPIC_ALLOWED = new Set([
  "id",
  "name",
  "createdAt",
  "locked",
  "unread",
  "creatorSource",
]);

const CONFIG_SCHEMAS = {
  agent_config: {
    allowed: AGENT_ALLOWED,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
  },
  group_config: {
    allowed: GROUP_ALLOWED,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
  },
  settings: {
    allowed: SETTINGS_ALLOWED,
    nestedArrays: {},
  },
  forum_config: {
    allowed: new Set(["replyUsername"]),
    nestedArrays: {},
  },
};

function schemaForPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  if (/^Agents\/[^/]+\/regex_rules\.json$/i.test(normalized))
    return "agent_config";
  if (/^Agents\/[^/]+\/config\.json$/i.test(normalized)) return "agent_config";
  if (/^AgentGroups\/[^/]+\/config\.json$/i.test(normalized))
    return "group_config";
  if (/^settings\.json$/i.test(normalized)) return "settings";
  if (/^UserData\/forum\.config\.json$/i.test(normalized))
    return "forum_config";
  if (/^UserData\/memo\.config\.json$/i.test(normalized))
    return "unsupported_config";
  return "unsupported_config";
}

function getAllowedKeysForSchema(schema) {
  const definition = CONFIG_SCHEMAS[schema];
  return definition ? definition.allowed : null;
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cloneSafeValue(value, path = "") {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item, index) =>
      cloneSafeValue(item, `${path}[${index}]`)
    );
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    out[key] = cloneSafeValue(child, path ? `${path}.${key}` : key);
  }
  return out;
}

function pickAllowed(source, allowed) {
  const dto = {};
  for (const key of allowed) {
    if (
      Object.prototype.hasOwnProperty.call(source, key) &&
      !SENSITIVE_KEY_PATTERN.test(key)
    ) {
      dto[key] = cloneSafeValue(source[key], key);
    }
  }
  return dto;
}

function safeTopics(topics) {
  if (!Array.isArray(topics)) return undefined;
  return topics.map((topic) => pickAllowed(topic || {}, TOPIC_ALLOWED));
}

function buildSafeConfigDto(relativePath, parsedJson) {
  const schema = schemaForPath(relativePath);
  const definition = CONFIG_SCHEMAS[schema];
  let safe = {};
  if (definition) safe = pickAllowed(parsedJson || {}, definition.allowed);
  if (safe.topics) safe.topics = safeTopics(safe.topics) || [];

  return {
    dto_version: 1,
    schema,
    entity_id: relativePath,
    relative_path: relativePath,
    safe_projection_json: safe,
    checksum_source: {
      dto_version: 1,
      schema,
      entity_id: relativePath,
      safe_projection_json: safe,
    },
  };
}

function scanNoSensitiveKeys(value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`sensitive config field is not syncable: ${childPath}`);
    }
    if (child && typeof child === "object") scanNoSensitiveKeys(child, childPath);
  }
}

function validateNestedValue(schema, key, value, path) {
  const definition = CONFIG_SCHEMAS[schema];
  const nestedAllowed = definition && definition.nestedArrays[key];
  if (!nestedAllowed || !Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const childKey of Object.keys(item)) {
      if (!nestedAllowed.has(childKey)) {
        throw new Error(
          `unsupported config field for ${schema}: ${path}[${index}].${childKey}`
        );
      }
    }
  });
}

function validateSafeConfigDto(schema, dto) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) {
    throw new Error("config safe_projection_json must be an object");
  }
  scanNoSensitiveKeys(dto);
  for (const [key, value] of Object.entries(dto)) {
    if (!definition.allowed.has(key)) {
      throw new Error(`unsupported config field for ${schema}: ${key}`);
    }
    validateNestedValue(schema, key, value, key);
  }
  return dto;
}

function mergeProjectedConfig(localConfig, remoteDto, schema) {
  const allowed = getAllowedKeysForSchema(schema);
  if (!allowed) throw new Error(`unsupported config schema: ${schema}`);
  const base =
    localConfig && typeof localConfig === "object" && !Array.isArray(localConfig)
      ? cloneJsonValue(localConfig)
      : {};
  for (const key of allowed) delete base[key];
  for (const [key, value] of Object.entries(remoteDto || {})) {
    if (allowed.has(key)) base[key] = cloneJsonValue(value);
  }
  return base;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  CONFIG_SCHEMAS,
  schemaForPath,
  getAllowedKeysForSchema,
  cloneSafeValue,
  pickAllowed,
  safeTopics,
  buildSafeConfigDto,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
  mergeProjectedConfig,
};
