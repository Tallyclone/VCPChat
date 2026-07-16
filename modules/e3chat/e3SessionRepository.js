"use strict";

class E3SessionRepository {
  constructor(signalrProvider) {
    this.signalrProvider = signalrProvider;
  }

  client() {
    const client = typeof this.signalrProvider === "function" ? this.signalrProvider() : this.signalrProvider;
    if (!client) throw new Error("E3 SignalR client is not connected");
    return client;
  }

  async listSessions() { return await this.client().invoke("ListChatSessions"); }
  async loadSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    return await this.client().invoke("LoadChatSession", sessionId);
  }
  async renameSession(sessionId, title) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
    if (typeof title !== "string" || title.length < 1 || title.length > 200) throw new Error("Invalid title");
    return await this.client().invoke("RenameChatSession", sessionId, title);
  }
}

module.exports = E3SessionRepository;
