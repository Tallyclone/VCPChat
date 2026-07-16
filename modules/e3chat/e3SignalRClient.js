"use strict";

const EventEmitter = require("events");
const WebSocket = require("ws");

const RS = "\u001e";

class E3SignalRClient extends EventEmitter {
  constructor({ baseUrl, hubKey = "dev", diagnostics } = {}) {
    super();
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.hubKey = hubKey || "dev";
    this.diagnostics = diagnostics;
    this.ws = null;
    this.nextInvocationId = 1;
    this.pending = new Map();
    this.remoteHandlers = new Map();
    this.connected = false;
  }

  registerRemote(methodName, handler) {
    if (typeof methodName !== "string" || !methodName.trim())
      throw new TypeError("methodName must be a non-empty string");
    if (typeof handler !== "function")
      throw new TypeError("handler must be a function");
    this.remoteHandlers.set(methodName, handler);
    return () => this.remoteHandlers.delete(methodName);
  }

  async negotiate() {
    const url = `${
      this.baseUrl
    }/workspace-hub/negotiate?key=${encodeURIComponent(
      this.hubKey
    )}&negotiateVersion=1`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok)
      throw new Error(`SignalR negotiate failed: HTTP ${res.status}`);
    return await res.json();
  }

  async connect() {
    if (this.connected) return;
    const n = await this.negotiate();
    const token = n.connectionToken || n.connectionId;
    if (!token) throw new Error("SignalR negotiate missing connectionToken");
    const wsBase = this.baseUrl
      .replace(/^http:/i, "ws:")
      .replace(/^https:/i, "wss:");
    const wsUrl = `${wsBase}/workspace-hub?key=${encodeURIComponent(
      this.hubKey
    )}&id=${encodeURIComponent(token)}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const fail = (err) => reject(err);
      ws.once("error", fail);
      ws.once("open", () => {
        ws.off("error", fail);
        ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
        this.connected = true;
        this.emit("connection", "connected");
        resolve();
      });
      ws.on("message", (data) => this.handleMessage(String(data)));
      ws.on("close", (code, reason) => {
        this.connected = false;
        for (const [, pending] of this.pending)
          pending.reject(new Error(`SignalR closed ${code} ${reason || ""}`));
        this.pending.clear();
        this.emit("connection", "disconnected");
      });
      ws.on("error", (err) => this.emit("error", err));
    });
  }

  handleMessage(data) {
    for (const part of data.split(RS)) {
      if (!part) continue;
      let msg;
      try {
        msg = JSON.parse(part);
      } catch (_) {
        continue;
      }
      if (msg.type === 1) {
        const handler = this.remoteHandlers.get(String(msg.target || ""));
        if (handler) {
          Promise.resolve()
            .then(() => handler(...(msg.arguments || [])))
            .then((result) => {
              if (msg.invocationId != null)
                this.sendCompletion(msg.invocationId, result);
            })
            .catch((error) => {
              this.diagnostics?.add(
                "error",
                `SignalR remote RPC ${msg.target} failed`,
                error.message
              );
              if (msg.invocationId != null)
                this.sendCompletion(msg.invocationId, null, error);
            });
        } else {
          this.emit("hub-event", msg.target, ...(msg.arguments || []));
          if (msg.invocationId != null)
            this.sendCompletion(
              msg.invocationId,
              null,
              new Error(`No client method registered: ${msg.target}`)
            );
        }
      } else if (msg.type === 3) {
        const pending = this.pending.get(String(msg.invocationId));
        if (pending) {
          this.pending.delete(String(msg.invocationId));
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result ?? null);
        }
      } else if (msg.type === 6) {
        this.emit("ping");
      }
    }
  }

  sendCompletion(invocationId, result, error = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      type: 3,
      invocationId: String(invocationId),
      ...(error
        ? { error: error.message || String(error) }
        : { result: result ?? null }),
    };
    this.ws.send(JSON.stringify(message) + RS);
  }

  invoke(target, ...args) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("SignalR is not connected"));
    const invocationId = String(this.nextInvocationId++);
    const message = { type: 1, invocationId, target, arguments: args };
    return new Promise((resolve, reject) => {
      this.pending.set(invocationId, { resolve, reject, target });
      this.ws.send(JSON.stringify(message) + RS, (err) => {
        if (err) {
          this.pending.delete(invocationId);
          reject(err);
        }
      });
    });
  }

  send(target, ...args) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("SignalR is not connected"));
    const message = { type: 1, target, arguments: args };
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(message) + RS, (error) => {
        if (error) reject(error);
        else resolve(null);
      });
    });
  }

  async disconnect() {
    if (this.ws) {
      try {
        this.ws.close(1000, "client disconnect");
      } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = E3SignalRClient;
