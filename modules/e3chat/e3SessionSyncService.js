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
    const roots = [
      ...new Set(
        this.sessions.map((s) => s && s.workspaceRoot).filter(Boolean)
      ),
    ];
    // An empty result is meaningful: it can be a newly selected workspace with
    // no chat sessions yet. Never retain the previous workspace identity here.
    this.workspaceIdentity = roots[0] || "unknown";
    if (roots.length > 1)
      this.diagnostics?.add(
        "warn",
        "ListChatSessions returned multiple workspace roots",
        roots
      );
    return {
      sessions: this.sessions,
      workspaceIdentity: this.workspaceIdentity,
      roots,
    };
  }
}

module.exports = E3SessionSyncService;
