"use strict";

const path = require("path");
const fs = require("fs-extra");

class E3LocalStateStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(process.cwd(), "AppData", "E3Chat");
    this.statePath = path.join(this.baseDir, "local-state.json");
    this.cache = null;
  }

  async loadAll() {
    if (this.cache) return this.cache;
    await fs.ensureDir(this.baseDir);
    if (await fs.pathExists(this.statePath)) {
      try { this.cache = await fs.readJson(this.statePath); } catch (_) { this.cache = {}; }
    } else {
      this.cache = {};
    }
    return this.cache;
  }

  async saveAll(data) {
    this.cache = data && typeof data === "object" ? data : {};
    await fs.ensureDir(this.baseDir);
    await fs.writeJson(this.statePath, this.cache, { spaces: 2 });
    return this.cache;
  }

  async get(scope = "global") {
    const all = await this.loadAll();
    return all[scope] || {};
  }

  async patch(scope = "global", patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid local state patch");
    const all = await this.loadAll();
    all[scope] = { ...(all[scope] || {}), ...patch, updatedAt: new Date().toISOString() };
    await this.saveAll(all);
    return all[scope];
  }
}

module.exports = E3LocalStateStore;
