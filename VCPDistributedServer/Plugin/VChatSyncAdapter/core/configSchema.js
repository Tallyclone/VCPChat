const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(key|token|secret|password|cookie|credential|auth|apikey|bearer)([_-]|$)/i;

const TOPIC_ALLOWED = new Set([
  "id",
  "name",
  "createdAt",
  "locked",
  "unread",
  "creatorSource",
]);

const AGENT_BOOTSTRAP_ALLOWED = new Set([
  "name",
  "systemPrompt",
  "originalSystemPrompt",
  "advancedSystemPrompt",
  "advancedSystemPrompt.hiddenBlocks",
  "advancedSystemPrompt.warehouseOrder",
  "advancedSystemPrompt.viewMode",
  "advancedSystemPrompt.blocks",
  "syncPrompt",
  "promptMode",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
  "topics",
  "presetSystemPrompt",
  "selectedPreset",
  "uiCollapseStates",
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

const AGENT_RUNTIME_DEFAULT_ALLOWED = new Set([
  "name",
  "advancedSystemPrompt.hiddenBlocks",
  "advancedSystemPrompt.warehouseOrder",
  "advancedSystemPrompt.viewMode",
  "presetSystemPrompt",
  "selectedPreset",
]);

const AGENT_RUNTIME_CONFIGURABLE_ALLOWED = new Set([
  ...AGENT_BOOTSTRAP_ALLOWED,
]);

const AGENT_RUNTIME_DENYLIST = new Set([
  "advancedSystemPrompt",
  "advancedSystemPrompt.blocks",
  "syncPrompt",
  "regex_rules",
]);

const GROUP_BOOTSTRAP_ALLOWED = new Set([
  "id",
  "name",
  "description",
  "avatar",
  "createdAt",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics",
  "groupPrompt",
  "invitePrompt",
  "mode",
  "tagMatchMode",
  "memberTags",
  "useUnifiedModel",
  "unifiedModel",
]);

const GROUP_RUNTIME_DEFAULT_ALLOWED = new Set([
  "name",
  "avatar",
  "members",
  "invitePrompt",
  "mode",
  "memberTags",
]);

const GROUP_RUNTIME_CONFIGURABLE_ALLOWED = new Set([
  ...GROUP_RUNTIME_DEFAULT_ALLOWED,
]);

const GROUP_RUNTIME_DENYLIST = new Set([
  "groupPrompt",
  "useUnifiedModel",
  "unifiedModel",
  "tagMatchMode",
]);

const WHOLE_DOCUMENT_ALLOWED = new Set(["$"]);

const SETTINGS_BOOTSTRAP_ALLOWED = new Set([
  "userName",
  "userAvatarUrl",
  "enableAgentBubbleTheme",
  "assistantAgent",
  "voiceMode",
  "speechRecognizerBrowserPath",
  "speechRecognizerPagePath",
  "voiceLocalSettings.sovitsUrl",
  "voiceLocalSettings.sovitsKey",
  "voiceNetworkSettings.providerUrl",
  "voiceNetworkSettings.providerKey",
  "enableDistributedServer",
  "enableVcpToolInjection",
  "enableThoughtChainInjection",
  "enableAiMessageButtons",
  "enableContextSanitizer",
  "contextSanitizerDepth",
  "agentMusicControl",
  "topicSummaryModel",
  "enableDistributedServerLogs",
  "continueWritingPrompt",
  "flowlockContinueDelay",
  "enableMiddleClickQuickAction",
  "middleClickQuickAction",
  "enableRegenerateConfirmation",
  "enableMiddleClickAdvanced",
  "middleClickAdvancedDelay",
]);

const SETTINGS_RUNTIME_DEFAULT_ALLOWED = new Set(["userName", "userAvatarUrl"]);

const CONFIG_SCHEMAS = {
  agent_config: {
    bootstrapAllowed: AGENT_BOOTSTRAP_ALLOWED,
    runtimeDefaultAllowed: AGENT_RUNTIME_DEFAULT_ALLOWED,
    runtimeConfigurableAllowed: AGENT_RUNTIME_CONFIGURABLE_ALLOWED,
    runtimeDenylist: AGENT_RUNTIME_DENYLIST,
    nestedArrays: {},
  },
  group_config: {
    bootstrapAllowed: GROUP_BOOTSTRAP_ALLOWED,
    runtimeDefaultAllowed: GROUP_RUNTIME_DEFAULT_ALLOWED,
    runtimeConfigurableAllowed: GROUP_RUNTIME_CONFIGURABLE_ALLOWED,
    runtimeDenylist: GROUP_RUNTIME_DENYLIST,
    nestedArrays: {},
  },
  global_prompt_warehouse: {
    bootstrapAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeDefaultAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeConfigurableAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeDenylist: new Set(),
    wholeDocument: true,
    nestedArrays: {},
  },
  system_prompt_preset: {
    bootstrapAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeDefaultAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeConfigurableAllowed: WHOLE_DOCUMENT_ALLOWED,
    runtimeDenylist: new Set(),
    wholeDocument: true,
    nestedArrays: {},
  },
  settings: {
    bootstrapAllowed: SETTINGS_BOOTSTRAP_ALLOWED,
    runtimeDefaultAllowed: SETTINGS_RUNTIME_DEFAULT_ALLOWED,
    runtimeConfigurableAllowed: SETTINGS_BOOTSTRAP_ALLOWED,
    runtimeDenylist: new Set(),
    allowSensitiveFields: SETTINGS_BOOTSTRAP_ALLOWED,
    nestedArrays: {},
  },
  forum_config: {
    bootstrapAllowed: new Set(["replyUsername"]),
    runtimeDefaultAllowed: new Set(),
    runtimeConfigurableAllowed: new Set(),
    runtimeDenylist: new Set(),
    nestedArrays: {},
  },
};

function normalizeProfile(profile) {
  return profile === "runtime" || profile === "manual" ? profile : "bootstrap";
}

function normalizePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/");
}

function schemaForPath(relativePath, profile = "bootstrap") {
  const normalized = normalizePath(relativePath);
  const effectiveProfile = normalizeProfile(profile);
  if (/^Agents\/[^/]+\/config\.json$/i.test(normalized)) return "agent_config";
  if (/^AgentGroups\/[^/]+\/config\.json$/i.test(normalized))
    return "group_config";
  if (/^global_prompt_warehouse\.json$/i.test(normalized))
    return "global_prompt_warehouse";
  if (/^systemPromptPresets\/.+\.json$/i.test(normalized))
    return "system_prompt_preset";
  if (/^settings\.json$/i.test(normalized)) return "settings";
  if (effectiveProfile === "runtime") return "skip";
  if (/^UserData\/forum\.config\.json$/i.test(normalized))
    return "forum_config";
  return "unsupported_config";
}

function getAllowedKeysForSchema(schema) {
  const definition = CONFIG_SCHEMAS[schema];
  return definition ? definition.bootstrapAllowed : null;
}

function normalizeFieldList(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => String(field || "").trim()).filter(Boolean);
}

function getProfileSection(schemaName, syncProfileConfig = {}) {
  const runtimeSync = syncProfileConfig && syncProfileConfig.runtimeSync;
  if (!runtimeSync || typeof runtimeSync !== "object") return {};
  return runtimeSync[schemaName] || {};
}

function collapseCoveredPaths(fields) {
  const sorted = normalizeFieldList(fields).sort((a, b) => a.length - b.length);
  const out = [];
  for (const field of sorted) {
    if (
      out.some((parent) => field !== parent && field.startsWith(`${parent}.`))
    )
      continue;
    out.push(field);
  }
  return out;
}

function isAllowedRuntimeField(definition, field) {
  if (definition.runtimeDenylist.has(field)) return false;
  const configurable =
    definition.runtimeConfigurableAllowed || definition.bootstrapAllowed;
  if (configurable.has(field)) return true;
  return [...configurable].some(
    (parent) => field !== parent && field.startsWith(`${parent}.`)
  );
}

function isExistingPath(field, source) {
  return hasByPath(source || {}, field);
}

function getEffectiveAllowed(
  schemaName,
  profile = "bootstrap",
  syncProfileConfig = {},
  source = null
) {
  const definition = CONFIG_SCHEMAS[schemaName];
  if (!definition) return null;
  const effectiveProfile = normalizeProfile(profile);
  if (effectiveProfile !== "runtime")
    return new Set(collapseCoveredPaths([...definition.bootstrapAllowed]));

  const section = getProfileSection(schemaName, syncProfileConfig);
  const include = normalizeFieldList(section.include);
  const exclude = normalizeFieldList(section.exclude);
  const allowed = new Set(definition.runtimeDefaultAllowed);

  for (const field of include) {
    if (isAllowedRuntimeField(definition, field)) {
      allowed.add(field);
    }
  }
  for (const field of exclude) allowed.delete(field);
  for (const field of [...allowed]) {
    if (!isAllowedRuntimeField(definition, field)) {
      allowed.delete(field);
    }
  }
  if (source && section.deleteMissing !== true) {
    for (const field of [...allowed]) {
      if (!isExistingPath(field, source)) allowed.delete(field);
    }
  }
  return allowed;
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isSensitiveFieldAllowed(definition, fieldPath) {
  return Boolean(
    definition &&
      definition.allowSensitiveFields &&
      definition.allowSensitiveFields.has(fieldPath)
  );
}

function cloneSafeValue(value, path = "", definition = null) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item, index) =>
      cloneSafeValue(item, `${path}[${index}]`, definition)
    );
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      !isSensitiveFieldAllowed(definition, childPath)
    )
      continue;
    out[key] = cloneSafeValue(child, childPath, definition);
  }
  return out;
}

function pathParts(fieldPath) {
  return String(fieldPath || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getByPath(obj, fieldPath) {
  if (fieldPath === "$") return obj;
  const parts = pathParts(fieldPath);
  let cur = obj;
  for (const part of parts) {
    if (
      !cur ||
      typeof cur !== "object" ||
      !Object.prototype.hasOwnProperty.call(cur, part)
    ) {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function hasByPath(obj, fieldPath) {
  if (fieldPath === "$") return obj !== undefined;
  const parts = pathParts(fieldPath);
  let cur = obj;
  for (const part of parts) {
    if (
      !cur ||
      typeof cur !== "object" ||
      !Object.prototype.hasOwnProperty.call(cur, part)
    ) {
      return false;
    }
    cur = cur[part];
  }
  return true;
}

function setByPath(obj, fieldPath, value) {
  if (fieldPath === "$") return cloneJsonValue(value);
  const parts = pathParts(fieldPath);
  if (parts.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (
      !cur[part] ||
      typeof cur[part] !== "object" ||
      Array.isArray(cur[part])
    ) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function deleteByPath(obj, fieldPath) {
  if (fieldPath === "$") return {};
  const parts = pathParts(fieldPath);
  if (parts.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (
      !cur ||
      typeof cur !== "object" ||
      !Object.prototype.hasOwnProperty.call(cur, part)
    ) {
      return obj;
    }
    cur = cur[part];
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
  return obj;
}

function pickAllowed(source, allowed, definition = null) {
  const dto = {};
  for (const fieldPath of allowed) {
    if (fieldPath === "$")
      return cloneSafeValue(source || {}, "$", definition) || {};
    const leaf = pathParts(fieldPath).slice(-1)[0];
    if (
      SENSITIVE_KEY_PATTERN.test(leaf) &&
      !isSensitiveFieldAllowed(definition, fieldPath)
    )
      continue;
    if (hasByPath(source || {}, fieldPath)) {
      setByPath(
        dto,
        fieldPath,
        cloneSafeValue(getByPath(source, fieldPath), fieldPath, definition)
      );
    }
  }
  return dto;
}
function safeTopics(topics) {
  if (!Array.isArray(topics)) return undefined;
  return topics
    .filter(
      (topic) => topic && typeof topic === "object" && !Array.isArray(topic)
    )
    .map((topic) => cloneSafeValue(topic, "topics") || {});
}

function buildSafeConfigDto(relativePath, parsedJson, options = {}) {
  const profile = normalizeProfile(options.profile);
  const schema = schemaForPath(relativePath, profile);
  const definition = CONFIG_SCHEMAS[schema];
  if (schema === "skip" || !definition) {
    return {
      dto_version: 1,
      schema,
      syncable: false,
      entity_id: relativePath,
      relative_path: relativePath,
      safe_projection_json: {},
      projection_fields: [],
      deleted_fields: [],
      profile,
      checksum_source: {
        dto_version: 1,
        schema,
        entity_id: relativePath,
        safe_projection_json: {},
        projection_fields: [],
        deleted_fields: [],
        profile,
      },
    };
  }

  const source = parsedJson || {};
  const section = getProfileSection(schema, options.syncProfileConfig);
  const projectionFields = [
    ...getEffectiveAllowed(schema, profile, options.syncProfileConfig, source),
  ];
  const safe = definition.wholeDocument
    ? cloneSafeValue(source, "$", definition) || {}
    : pickAllowed(source, projectionFields, definition);
  if (safe.topics) safe.topics = safeTopics(safe.topics) || [];
  const deletedFields =
    profile === "runtime" && section.deleteMissing === true
      ? projectionFields.filter((field) => !hasByPath(source, field))
      : [];

  return {
    dto_version: 1,
    schema,
    syncable: true,
    entity_id: relativePath,
    relative_path: relativePath,
    safe_projection_json: safe,
    projection_fields: projectionFields,
    deleted_fields: deletedFields,
    profile,
    checksum_source: {
      dto_version: 1,
      schema,
      entity_id: relativePath,
      safe_projection_json: safe,
      projection_fields: projectionFields,
      deleted_fields: deletedFields,
      profile,
    },
  };
}

function scanNoSensitiveKeys(value, path = "", definition = null) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      !isSensitiveFieldAllowed(definition, childPath)
    ) {
      throw new Error(`sensitive config field is not syncable: ${childPath}`);
    }
    if (child && typeof child === "object")
      scanNoSensitiveKeys(child, childPath, definition);
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

function flattenDtoLeafPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix] : [];
  const paths = [];
  for (const [key, child] of entries) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      paths.push(...flattenDtoLeafPaths(child, childPath));
    } else {
      paths.push(childPath);
    }
  }
  return paths;
}

function validateDtoPaths(
  schema,
  dto,
  projectionFields = null,
  profile = "bootstrap"
) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (definition.wholeDocument) return;
  const fields = Array.isArray(projectionFields)
    ? projectionFields
    : collapseCoveredPaths([...definition.bootstrapAllowed]);
  const allowed = new Set(fields);
  for (const fieldPath of fields) {
    if (!definition.bootstrapAllowed.has(fieldPath)) {
      throw new Error(
        `unsupported projection field for ${schema}: ${fieldPath}`
      );
    }
    if (
      normalizeProfile(profile) === "runtime" &&
      definition.runtimeDenylist.has(fieldPath)
    ) {
      throw new Error(
        `runtime projection field is denied for ${schema}: ${fieldPath}`
      );
    }
  }
  for (const leafPath of flattenDtoLeafPaths(dto || {})) {
    const matched = [...allowed].some(
      (fieldPath) =>
        fieldPath === leafPath || leafPath.startsWith(`${fieldPath}.`)
    );
    if (!matched)
      throw new Error(`unsupported config field for ${schema}: ${leafPath}`);
  }
}

function validateSafeConfigDto(schema, dto, options = {}) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (!dto || typeof dto !== "object") {
    throw new Error("config safe_projection_json must be an object");
  }
  if (Array.isArray(dto) && !definition.wholeDocument) {
    throw new Error("config safe_projection_json must be an object");
  }
  scanNoSensitiveKeys(dto, "", definition);
  validateDtoPaths(schema, dto, options.projection_fields, options.profile);
  if (!definition.wholeDocument) {
    for (const [key, value] of Object.entries(dto))
      validateNestedValue(schema, key, value, key);
  }
  return dto;
}

function mergeBySchemaAllowedForLegacy(localConfig, remoteDto, schema) {
  const allowed = getAllowedKeysForSchema(schema);
  if (!allowed) throw new Error(`unsupported config schema: ${schema}`);
  const base =
    localConfig &&
    typeof localConfig === "object" &&
    !Array.isArray(localConfig)
      ? cloneJsonValue(localConfig)
      : {};
  for (const key of allowed) {
    if (!String(key).includes(".")) delete base[key];
  }
  for (const [key, value] of Object.entries(remoteDto || {})) {
    if (allowed.has(key)) base[key] = cloneJsonValue(value);
  }
  return base;
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function topicCreatedAt(topic) {
  const raw =
    topic && (topic.createdAt || topic.created_at || topic.timestamp || 0);
  const value = Number(raw || 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeTopicForConfig(topic) {
  const safe = cloneSafeValue(topic || {}, "topics") || {};
  if (!safe.id && topicIdOf(topic)) safe.id = String(topicIdOf(topic));
  if (!safe.name && (topic.title || topic.topic_title || topic.topicTitle)) {
    safe.name = topic.title || topic.topic_title || topic.topicTitle;
  }
  if (!safe.createdAt && (topic.created_at || topic.timestamp)) {
    safe.createdAt = topic.created_at || topic.timestamp;
  }
  return safe;
}

function mergeTopicsPreservingLocalOrder(localTopics, remoteTopics) {
  const existing = Array.isArray(localTopics)
    ? localTopics.map((topic) => normalizeTopicForConfig(topic))
    : [];
  const incoming = Array.isArray(remoteTopics)
    ? remoteTopics.map((topic) => normalizeTopicForConfig(topic))
    : [];
  const incomingById = new Map();
  for (const topic of incoming) {
    const id = topicIdOf(topic);
    if (id) incomingById.set(String(id), topic);
  }

  const seen = new Set();
  const kept = existing.map((topic) => {
    const id = topicIdOf(topic);
    if (!id) return topic;
    const key = String(id);
    seen.add(key);
    return incomingById.has(key)
      ? {
          ...topic,
          ...incomingById.get(key),
          id: topic.id || incomingById.get(key).id,
        }
      : topic;
  });

  const added = [];
  for (const topic of incoming) {
    const id = topicIdOf(topic);
    if (!id || seen.has(String(id))) continue;
    added.push(topic);
    seen.add(String(id));
  }
  added.sort((a, b) => topicCreatedAt(b) - topicCreatedAt(a));
  return [...added, ...kept];
}

function mergeProjectedConfig(
  localConfig,
  remoteDto,
  schemaOrOptions,
  maybeOptions = {}
) {
  const options =
    typeof schemaOrOptions === "object" && schemaOrOptions !== null
      ? schemaOrOptions
      : { ...maybeOptions, schema: schemaOrOptions };
  const schema = options.schema;
  const projectionFields = Array.isArray(options.projection_fields)
    ? options.projection_fields
    : null;
  const deletedFields = Array.isArray(options.deleted_fields)
    ? options.deleted_fields
    : [];
  const profile = normalizeProfile(options.profile);
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);

  if (definition.wholeDocument) {
    const base = cloneJsonValue(remoteDto || {});
    for (const fieldPath of deletedFields) deleteByPath(base, fieldPath);
    return base;
  }
  if (!projectionFields) {
    if (profile === "runtime") {
      throw new Error("runtime config operation requires projection_fields");
    }
    return mergeBySchemaAllowedForLegacy(localConfig, remoteDto, schema);
  }

  const base =
    localConfig &&
    typeof localConfig === "object" &&
    !Array.isArray(localConfig)
      ? cloneJsonValue(localConfig)
      : {};
  for (const fieldPath of projectionFields) {
    if (deletedFields.includes(fieldPath)) {
      deleteByPath(base, fieldPath);
      continue;
    }
    if (hasByPath(remoteDto || {}, fieldPath)) {
      if (
        fieldPath === "topics" &&
        (schema === "agent_config" || schema === "group_config")
      ) {
        base.topics = mergeTopicsPreservingLocalOrder(
          base.topics,
          remoteDto.topics
        );
      } else {
        setByPath(
          base,
          fieldPath,
          cloneJsonValue(getByPath(remoteDto, fieldPath))
        );
      }
    } else if (profile !== "runtime") {
      deleteByPath(base, fieldPath);
    }
  }
  return base;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  CONFIG_SCHEMAS,
  schemaForPath,
  getAllowedKeysForSchema,
  getEffectiveAllowed,
  normalizeProfile,
  cloneSafeValue,
  cloneJsonValue,
  pickAllowed,
  safeTopics,
  mergeTopicsPreservingLocalOrder,
  getByPath,
  hasByPath,
  setByPath,
  deleteByPath,
  buildSafeConfigDto,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
  mergeProjectedConfig,
};
