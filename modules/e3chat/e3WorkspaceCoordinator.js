"use strict";

const EventEmitter = require("events");

class E3WorkspaceCoordinator extends EventEmitter {
  constructor() {
    super();
    this.context = {
      identity: "unknown",
      root: null,
      displayName: "未连接",
      connectionGeneration: 0,
      connectedAt: null,
    };
  }

  nextGeneration(root, metadata = {}) {
    this.context = {
      identity: metadata.identity || root || `unknown-${Date.now()}`,
      root: root || null,
      displayName:
        metadata.displayName ||
        (root ? root.split(/[\\/]/).pop() || root : "未知工作空间"),
      connectionGeneration: this.context.connectionGeneration + 1,
      connectedAt: new Date().toISOString(),
    };
    this.emit("changed", this.context);
    return this.context;
  }

  current() {
    return { ...this.context };
  }
}

module.exports = E3WorkspaceCoordinator;
