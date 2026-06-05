// modules/renderer/desktopBuiltinParser.js

const START_MARKER = "「始」";
const END_MARKER = "「末」";
const START_ESCAPE_MARKER = "「始ESCAPE」";
const END_ESCAPE_MARKER = "「末ESCAPE」";

const TOP_LEVEL_FIELDS = new Set(["type", "title", "widgetId"]);
const CONFIG_FIELDS = new Set(["mountPath", "mode", "showHidden", "initialView", "realtime"]);
const OPTION_FIELDS = new Set(["x", "y", "width", "height"]);
const CUSTOM_UI_FIELDS = new Set(["html", "css", "js", "htmlContent", "fallbackToDefault"]);

const FIELD_ALIASES = new Map([
  ["name", "title"],
  ["id", "widgetId"],
  ["path", "mountPath"],
  ["root", "mountPath"],
  ["rootPath", "mountPath"],
  ["folder", "mountPath"],
  ["dir", "mountPath"],
  ["directory", "mountPath"],
  ["readonly", "mode"],
  ["view", "initialView"],
  ["layout", "ui.layout.view"],
  ["ui.toolbar", "ui.actions.toolbar"],
  ["toolbar", "ui.actions.toolbar"],
  ["contextMenu", "ui.actions.contextMenu"],
]);

function stripWrappedValue(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith(START_ESCAPE_MARKER) && text.endsWith(END_ESCAPE_MARKER)) {
    return text.slice(START_ESCAPE_MARKER.length, -END_ESCAPE_MARKER.length);
  }
  if (text.startsWith(START_MARKER) && text.endsWith(END_MARKER)) {
    return text.slice(START_MARKER.length, -END_MARKER.length);
  }
  return text;
}

function coerceValue(rawValue) {
  const value = stripWrappedValue(rawValue);
  const trimmed = String(value).trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^(null|none)$/i.test(trimmed)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.includes(",") && !trimmed.includes("rgba(") && !trimmed.includes("linear-gradient(")) {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}

function setDeep(target, path, value) {
  const parts = String(path || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return;
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

function normalizeFieldName(rawKey) {
  const key = String(rawKey || "").trim();
  return FIELD_ALIASES.get(key) || key;
}

function parseDesktopBuiltinFields(rawText) {
  const fields = [];
  const lines = String(rawText || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    index += 1;

    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const blockMatch = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(「始(?:ESCAPE)?」)\s*$/);
    if (blockMatch) {
      const key = normalizeFieldName(blockMatch[1]);
      const startMarker = blockMatch[2];
      const endMarker = startMarker === START_ESCAPE_MARKER ? END_ESCAPE_MARKER : END_MARKER;
      const blockLines = [];
      let closed = false;
      while (index < lines.length) {
        const blockLine = lines[index];
        index += 1;
        if (blockLine.trim() === endMarker) {
          closed = true;
          break;
        }
        blockLines.push(blockLine);
      }
      if (!closed) {
        throw new Error(`DESKTOP_BUILTIN field "${key}" block is not closed with ${endMarker}`);
      }
      fields.push([key, blockLines.join("\n")]);
      continue;
    }

    const kvMatch = rawLine.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*([\s\S]*)$/);
    if (!kvMatch) continue;
    fields.push([normalizeFieldName(kvMatch[1]), coerceValue(kvMatch[2])]);
  }

  return fields;
}

function applyField(payload, key, value) {
  if (TOP_LEVEL_FIELDS.has(key)) {
    payload[key] = value == null ? value : String(value);
    return;
  }
  if (CONFIG_FIELDS.has(key)) {
    payload.config[key] = value;
    return;
  }
  if (OPTION_FIELDS.has(key)) {
    payload.options[key] = value;
    return;
  }
  if (key.startsWith("frame.")) {
    setDeep(payload.options, key, value);
    return;
  }
  if (key.startsWith("ui.")) {
    setDeep(payload.config, key, value);
    return;
  }
  if (CUSTOM_UI_FIELDS.has(key)) {
    payload.customUI = payload.customUI || { runtime: "vcp-widget-shadow", version: 2 };
    if (key === "fallbackToDefault") payload.customUI[key] = value !== false;
    else payload.customUI[key] = value == null ? "" : String(value);
    return;
  }
  if (key.startsWith("customUI.")) {
    payload.customUI = payload.customUI || { runtime: "vcp-widget-shadow", version: 2 };
    setDeep(payload.customUI, key.slice("customUI.".length), value);
  }
}

function normalizeDesktopBuiltinPayload(payload) {
  payload.type = payload.type || "nativeFileMount";

  if (payload.config.readonly === true) payload.config.mode = "readonly";
  if (payload.config.mode !== "readwrite") payload.config.mode = "readonly";
  if (payload.config.initialView && !["list", "grid", "compact"].includes(payload.config.initialView)) {
    payload.config.initialView = "list";
  }

  if (payload.customUI) {
    payload.customUI.runtime = payload.customUI.runtime || "vcp-widget-shadow";
    payload.customUI.version = Number(payload.customUI.version) || 2;
    if (payload.customUI.fallbackToDefault == null) payload.customUI.fallbackToDefault = true;
  }

  if (payload.type === "nativeFileMount" && !payload.config.mountPath) {
    throw new Error("DESKTOP_BUILTIN nativeFileMount requires mountPath");
  }

  return payload;
}

function parseDesktopBuiltinBlock(rawText) {
  const payload = {
    type: "nativeFileMount",
    title: undefined,
    widgetId: undefined,
    config: {},
    options: {},
    customUI: null,
  };

  for (const [key, value] of parseDesktopBuiltinFields(rawText)) {
    applyField(payload, key, value);
  }

  return normalizeDesktopBuiltinPayload(payload);
}

function getDesktopBuiltinLabel(rawText, escapeHtml = (value) => String(value ?? "")) {
  try {
    const payload = parseDesktopBuiltinBlock(rawText);
    if (payload.type === "nativeFileMount") {
      return `NativeFileMount 创建请求已发送：${escapeHtml(
        payload.title || payload.config?.mountPath || "本机文件夹"
      )}`;
    }
    return `桌面内置挂件创建请求已发送：${escapeHtml(payload.type || "builtin")}`;
  } catch (error) {
    return `桌面内置挂件创建请求解析失败：${escapeHtml(error.message || error)}`;
  }
}

export { parseDesktopBuiltinBlock, getDesktopBuiltinLabel };
