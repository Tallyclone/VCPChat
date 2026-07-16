"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BrowserWindow } = require("electron");

const RPC_TIMEOUT_MS = 30000;

class E3ViewportBridge {
  constructor({ diagnostics } = {}) {
    this.diagnostics = diagnostics;
    this.window = null;
    this.ready = null;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  viewportPath() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
    const filePath = path.join(
      localAppData,
      "Programs",
      "E3",
      "unpacked_app",
      "dist",
      "viewport",
      "index.html"
    );
    if (!fs.existsSync(filePath))
      throw new Error(`E3 native viewport was not found: ${filePath}`);
    return filePath;
  }

  async ensureWindow(baseUrl) {
    if (this.window && !this.window.isDestroyed()) {
      if (!this.window.isVisible()) this.window.show();
      return await this.ready;
    }

    const appRoot = require("electron").app.getAppPath();
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: "E3 Model View",
      backgroundColor: "#101319",
      show: false,
      webPreferences: {
        preload: path.join(appRoot, "preloads", "e3ViewportBridge.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.window = win;
    const port = (() => {
      try {
        return new URL(baseUrl).port;
      } catch (_) {
        return "";
      }
    })();

    this.ready = new Promise((resolve, reject) => {
      const fail = (_event, code, description) =>
        reject(new Error(`E3 viewport failed to load (${code}): ${description}`));
      win.webContents.once("did-fail-load", fail);
      win.webContents.once("did-finish-load", () => {
        win.webContents.removeListener("did-fail-load", fail);
        win.show();
        resolve(win);
      });
    });

    win.webContents.on("ipc-message", (_event, channel, payload) => {
      if (channel !== "e3-viewport-rpc-response") return;
      const pending = this.pending.get(String(payload?.requestId || ""));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(payload.requestId));
      pending.resolve(payload.result);
    });
    win.on("closed", () => {
      const error = new Error("E3 model view was closed");
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.window = null;
      this.ready = null;
    });

    await win.loadFile(this.viewportPath(), {
      query: { mode: "iframe", port: port || "5000" },
    });
    return await this.ready;
  }

  async forward(methodName, body, baseUrl) {
    const win = await this.ensureWindow(baseUrl);
    const requestId = String(this.nextRequestId++);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Viewport RPC "${methodName}" timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      win.webContents.send("e3-viewport-rpc-invoke", {
        methodName,
        body: Array.from(bytes),
        requestId,
      });
    });
  }

  async remoteCall(methodName, bodyBase64, baseUrl) {
    const mappedName =
      methodName === "draw_objects_agent" ? "draw_objects" : methodName;
    try {
      const bytes =
        typeof bodyBase64 === "string"
          ? Buffer.from(bodyBase64, "base64")
          : Buffer.from(bodyBase64 || []);
      const result = await this.forward(mappedName, bytes, baseUrl);
      if (result && typeof result === "object") return result;
      const output = Buffer.from(String(result ?? ""), "utf8");
      return {
        result: output.length ? output.toString("base64") : "",
        hash: output.length
          ? crypto.createHash("sha256").update(output).digest("hex")
          : "",
        error: "",
      };
    } catch (error) {
      this.diagnostics?.add("error", `Viewport RPC ${methodName} failed`, error.message);
      return { result: "", hash: "", error: error.message };
    }
  }
}

module.exports = E3ViewportBridge;
