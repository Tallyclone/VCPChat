"use strict";

/**
 * desktopBuiltinParser.js — DESKTOP_BUILTIN 协议解析器
 *
 * 解析 DESKTOP_PUSH 块中以 "type:" 开头的 key-value 格式内容，
 * 将其转换为结构化的 payload 对象，供 builtin widget 使用。
 *
 * 协议格式示例：
 * <<<[DESKTOP_PUSH]>>>
 * type: nativeFileMount
 * mountPath:「始」G:\Projects「末」
 * mode: readwrite
 * width: 880
 * height: 620
 * frame.transparent: true
 * ui.theme.background: rgba(15,23,42,.75)
 * <<<[DESKTOP_PUSH_END]>>>
 */

// 需要提升到 options 的顶层 key（控制挂件容器）
const OPTIONS_KEYS = new Set(["width", "height", "x", "y"]);

// 需要保持为字符串的 key（不做类型转换）
const STRING_KEYS = new Set([
  "type",
  "mountPath",
  "mode",
  "title",
  "widgetId",
  "action",
]);

/**
 * 检查 buffer 是否为 builtin 协议块（以 'type:' 开头）
 * @param {string} buffer - 原始 buffer 内容
 * @returns {boolean}
 */
function isBuiltinBlock(buffer) {
  if (!buffer || typeof buffer !== "string") return false;
  return buffer.trim().toLowerCase().startsWith("type:");
}

/**
 * 解析 DESKTOP_PUSH builtin 协议块
 * @param {string} rawBuffer - 完整的 buffer 内容（不包含 start/end 标签）
 * @returns {{ type: string, config: object, options: object } | null}
 */
function parseDesktopBuiltinBlock(rawBuffer) {
  if (!rawBuffer || typeof rawBuffer !== "string") return null;

  const result = {
    type: "",
    config: {},
    options: {},
  };

  const lines = rawBuffer.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
      continue;

    // 分离 key 和 value（以第一个 : 为分隔符）
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    let value = trimmed.substring(colonIdx + 1).trim();

    if (!key) continue;

    // 提取「始」...「末」分隔符包裹的值
    value = extractDelimitedValue(value);

    // 类型转换
    value = convertValue(key, value);

    // 路由到正确的位置
    routeKeyValue(key, value, result);
  }

  if (!result.type) {
    console.warn("[DesktopBuiltinParser] Missing required field: type");
    return null;
  }

  return result;
}

/**
 * 提取「始」...「末」或「始ESCAPE」...「末ESCAPE」分隔符包裹的值
 * 如果没有分隔符，返回原始值
 */
function extractDelimitedValue(value) {
  // 优先匹配「始ESCAPE」...「末ESCAPE」
  const escapeMatch = value.match(/^「始ESCAPE」([\s\S]*?)「末ESCAPE」$/);
  if (escapeMatch) return escapeMatch[1];

  // 匹配「始」...「末」
  const normalMatch = value.match(/^「始」([\s\S]*?)「末」$/);
  if (normalMatch) return normalMatch[1];

  return value;
}

/**
 * 将字符串值转换为合适的类型
 */
function convertValue(key, value) {
  if (typeof value !== "string") return value;

  // 明确需要保持字符串的 key
  if (STRING_KEYS.has(key)) return value;

  // 布尔值
  if (value === "true") return true;
  if (value === "false") return false;

  // 数字（纯数字或带小数点）
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);

  return value;
}

/**
 * 将 key-value 路由到 result 的正确位置
 * - type → result.type
 * - width/height/x/y → result.options
 * - frame.* → result.options.frame.*
 * - ui.* → result.config.ui.* (支持嵌套)
 * - 其他 → result.config
 */
function routeKeyValue(key, value, result) {
  if (key === "type") {
    result.type = value;
    return;
  }

  // 提升到 options 的 key
  if (OPTIONS_KEYS.has(key)) {
    result.options[key] = value;
    return;
  }

  // frame.* → options.frame
  if (key.startsWith("frame.")) {
    if (!result.options.frame) result.options.frame = {};
    const frameProp = key.substring(6); // 去掉 'frame.'
    result.options.frame[frameProp] = value;
    return;
  }

  // ui.* → config.ui (支持多级嵌套)
  if (key.startsWith("ui.")) {
    setNestedValue(result.config, key, value);
    return;
  }

  // action 等特殊字段 → 顶层
  if (key === "action" || key === "widgetId") {
    result[key] = value;
    return;
  }

  // 其他 → config（支持嵌套）
  if (key.includes(".")) {
    setNestedValue(result.config, key, value);
  } else {
    result.config[key] = value;
  }
}

/**
 * 设置嵌套对象的值
 * 'ui.theme.background' → obj.ui.theme.background = value
 */
function setNestedValue(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!target[parts[i]] || typeof target[parts[i]] !== "object") {
      target[parts[i]] = {};
    }
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;
}

// 导出
export { parseDesktopBuiltinBlock, isBuiltinBlock };
