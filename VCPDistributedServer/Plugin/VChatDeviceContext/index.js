"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const SOURCE_HEADER = "X-VCP-Source-Server-Name";
const FETCH_PATCH_STATE = Symbol.for("VChatDeviceContext.fetchPatchState");
const CHAT_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/chatvcp/completions",
]);

let localPatchState = null;

function readServerName() {
  const configPath = path.join(__dirname, "..", "..", "config.env");
  if (!fs.existsSync(configPath)) {
    throw new Error(`VChat distributed config not found: ${configPath}`);
  }

  const config = dotenv.parse(fs.readFileSync(configPath, "utf8"));
  const serverName = String(config.ServerName || "").trim();
  if (!serverName) {
    throw new Error(`ServerName is empty in ${configPath}`);
  }
  return serverName;
}

function getRequestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return String(input);
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function isVcpChatRequest(input) {
  const rawUrl = getRequestUrl(input);
  if (!rawUrl) return false;

  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    return CHAT_PATHS.has(parsed.pathname.replace(/\/+$/, ""));
  } catch (_error) {
    return false;
  }
}

function buildHeaders(input, init) {
  const inheritedHeaders = init?.headers || input?.headers;
  const headers = new Headers(inheritedHeaders || undefined);
  // Fetch/HTTP header values must be ASCII-safe. ShadowDistributedRouter decodes this value.
  headers.set(SOURCE_HEADER, encodeURIComponent(localPatchState.serverName));
  return headers;
}

async function initialize() {
  const serverName = readServerName();
  if (typeof globalThis.fetch !== "function") {
    throw new Error("globalThis.fetch is unavailable; cannot install device context wrapper");
  }

  const existing = globalThis[FETCH_PATCH_STATE];
  if (existing?.patched && globalThis.fetch === existing.patched) {
    existing.serverName = serverName;
    localPatchState = existing;
    console.log(`[VChatDeviceContext] fetch wrapper already active; ServerName=${serverName}`);
    return;
  }

  const original = globalThis.fetch;
  localPatchState = { original, patched: null, serverName };
  const patched = function vchatDeviceContextFetch(input, init) {
    if (!isVcpChatRequest(input)) {
      return original.call(this, input, init);
    }

    const nextInit = {
      ...(init || {}),
      headers: buildHeaders(input, init),
    };
    return original.call(this, input, nextInit);
  };

  localPatchState.patched = patched;
  globalThis[FETCH_PATCH_STATE] = localPatchState;
  globalThis.fetch = patched;
  console.log(`[VChatDeviceContext] installed for ServerName=${serverName}`);
}

function shutdown() {
  const state = localPatchState || globalThis[FETCH_PATCH_STATE];
  if (state?.patched && globalThis.fetch === state.patched) {
    globalThis.fetch = state.original;
  }
  if (globalThis[FETCH_PATCH_STATE] === state) {
    delete globalThis[FETCH_PATCH_STATE];
  }
  localPatchState = null;
}

module.exports = { initialize, shutdown };
