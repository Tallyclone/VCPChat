"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");

function parseStoredValue(value, fallback = null) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeRoot(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

class E3WorkspaceState {
  constructor(options = {}) {
    this.statePath = options.statePath || path.join(os.homedir(), ".e3", "storage.json");
  }

  readWorkspaceList() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      const encoded = raw?.["e3.global.workspace_list"];
      const list = parseStoredValue(encoded, []);
      return Array.isArray(list)
        ? list.filter((item) => item && typeof item.source === "string" && item.source.trim())
        : [];
    } catch (_) {
      return [];
    }
  }

  current() {
    const list = this.readWorkspaceList();
    if (!list.length) return null;
    const sorted = [...list].sort((left, right) => {
      const leftTime = Date.parse(left.lastOpenedAt || left.updatedAt || left.createdAt || "") || 0;
      const rightTime = Date.parse(right.lastOpenedAt || right.updatedAt || right.createdAt || "") || 0;
      return rightTime - leftTime;
    });
    const item = sorted[0];
    return {
      identity: item.id || item.source,
      root: item.source,
      displayName: item.name || item.source.split(/[\\/]/).pop() || item.source,
      lastOpenedAt: item.lastOpenedAt || null,
      source: "e3-workspace-list",
    };
  }

  matchesRoot(left, right) {
    const normalizedLeft = normalizeRoot(left);
    const normalizedRight = normalizeRoot(right);
    return !!normalizedLeft && normalizedLeft === normalizedRight;
  }
}

module.exports = E3WorkspaceState;
