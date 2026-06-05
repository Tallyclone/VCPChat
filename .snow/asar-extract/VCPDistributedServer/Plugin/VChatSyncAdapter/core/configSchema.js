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
  "topics",
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
  "description",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics",
]);

const GROUP_RUNTIME_CONFIGURABLE_ALLOWED = new Set([
  ...GROUP_RUNTIME_DEFAULT_ALLOWED,
  "mode",
  "tagMatchMode",
  "memberTags",
]);

const GROUP_RUNTIME_DENYLIST = new Set([
  "groupPrompt",
  "invitePrompt",
  "useUnifiedModel",
  "unifiedModel",
]);

const WHOLE_DOCUMENT_ALLOWED = new Set(["$"]);

const CONFIG_SCHEMAS = {
  agent_config: {
    bootstrapAllowed: AGENT_BOOTSTRAP_ALLOWED,
    runtimeDefaultAllowed: AGENT_RUNTIME_DEFAULT_ALLOWED,
    runtimeConfigurableAllowed: AGENT_RUNTIME_CONFIGURABLE_ALLOWED,
    runtimeDenylist: AGENT_RUNTIME_DENYLIST,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
  },
  group_config: {
    bootstrapAllowed: GROUP_BOOTSTRAP_ALLOWED,
    runtimeDefaultAllowed: GROUP_RUNTIME_DEFAULT_ALLOWED,
    runtimeConfigurableAllowed: GROUP_RUNTIME_CONFIGURABLE_ALLOWED,
    runtimeDenylist: GROUP_RUNTIME_DENYLIST,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
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
    bootstrapAllowed: new Set([
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
    ]),
    runtimeDefaultAllowed: new Set(),
    runtimeConfigurableAllowed: new Set(),
    runtimeDenylist: new Set(),
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
  if (effectiveProfile === "runtime") return "skip";
  if (/^settings\.json$/i.test(normalized)) return "settings";
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
  if (definition.bootstrapAllowed.has(field)) return true;
  return [...definition.bootstrapAllowed].some(
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

function pickAllowed(source, allowed) {
  const dto = {};
  for (const fieldPath of allowed) {
    if (fieldPath === "$") return cloneSafeValue(source || {}, "$") || {};
    const leaf = pathParts(fieldPath).slice(-1)[0];
    if (SENSITIVE_KEY_PATTERN.test(leaf)) continue;
    if (hasByPath(source || {}, fieldPath)) {
      setByPath(
        dto,
        fieldPath,
        cloneSafeValue(getByPath(source, fieldPath), fieldPath)
      );
    }
  }
  return dto;
}

function safeTopics(topics) {
  if (!Array.isArray(topics)) return undefined;
  return topics.map((topic) => pickAllowed(topic || {}, TOPIC_ALLOWED));
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
      profile,
      checksum_source: {
        dto_version: 1,
        schema,
        entity_id: relativePath,
        safe_projection_json: {},
        projection_fields: [],
        profile,
      },
    };
  }

  const projectionFields = [
    ...getEffectiveAllowed(
      schema,
      profile,
      options.syncProfileConfig,
      parsedJson || {}
    ),
  ];
  const safe = definition.wholeDocument
    ? cloneSafeValue(parsedJson || {}, "$") || {}
    : pickAllowed(parsedJson || {}, projectionFields);
  if (safe.topics) safe.topics = safeTopics(safe.topics) || [];

  return {
    dto_version: 1,
    schema,
    syncable: true,
    entity_id: relativePath,
    relative_path: relativePath,
    safe_projection_json: safe,
    projection_fields: projectionFields,
    profile,
    checksum_source: {
      dto_version: 1,
      schema,
      entity_id: relativePath,
      safe_projection_json: safe,
      projection_fields: projectionFields,
      profile,
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
    if (child && typeof child === "object")
      scanNoSensitiveKeys(child, childPath);
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
  scanNoSensitiveKeys(dto);
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
  const profile = normalizeProfile(options.profile);
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);

  if (definition.wholeDocument) return cloneJsonValue(remoteDto || {});
  if (!projectionFields) {
    if (profile === "runtime")
      throw new Error("runtime config operation requires projection_fields");
    return mergeBySchemaAllowedForLegacy(localConfig, remoteDto, schema);
  }

  const base =
    localConfig &&
    typeof localConfig === "object" &&
    !Array.isArray(localConfig)
      ? cloneJsonValue(localConfig)
      : {};
  for (const fieldPath of projectionFields) {
    if (hasByPath(remoteDto || {}, fieldPath)) {
      setByPath(
        base,
        fieldPath,
        cloneJsonValue(getByPath(remoteDto, fieldPath))
      );
    } else {
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
  getByPath,
  hasByPath,
  setByPath,
  deleteByPath,
  buildSafeConfigDto,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
  mergeProjectedConfig,
};
