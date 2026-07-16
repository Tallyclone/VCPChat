"use strict";

class E3SessionSyncService {
  constructor({ repository, diagnostics } = {}) {
    this.repository = repository;
    this.diagnostics = diagnostics;
    this.sessions = [];
    this.workspaceIdentity = null;
  }

  async refresh() {
    const sessions = await this.repository.listSessions();
    this.sessions = Array.isArray(sessions) ? sessions : [];
    const roots = [...new Set(this.sessions.map((s) => s && s.workspaceRoot).filter(Boolean))];
    this.workspaceIdentity = roots[0] || this.workspaceIdentity || "unknown";
    if (roots.length > 1) this.diagnostics?.add("warn", "ListChatSessions returned multiple workspace roots", roots);
    return { sessions: this.sessions, workspaceIdentity: this.workspaceIdentity, roots };
  }
}

module.exports = E3SessionSyncService;
