"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BrowserWindow, ipcMain } = require("electron");
const e3ChatWindow = require("./e3ChatWindow");

const RPC_TIMEOUT_MS = 30000;

class E3ViewportBridge {
  constructor({ diagnostics } = {}) {
    this.diagnostics = diagnostics;
    this.window = null;
    this.ready = null;
    this.nextRequestId = 1;
    this.pending = new Map();

    // Register global listener for viewport response
    ipcMain.on("e3-viewport-rpc-response", (event, payload) => {
      const pending = this.pending.get(String(payload?.requestId || ""));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(payload.requestId));
      pending.resolve(payload.result);
    });
  }

  viewportPath() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
    const sourcePath = path.join(
      localAppData,
      "Programs",
      "E3",
      "unpacked_app",
      "dist",
      "viewport",
      "index.html"
    );
    if (!fs.existsSync(sourcePath))
      throw new Error(`E3 native viewport was not found: ${sourcePath}`);

    const patchedPath = path.join(
      path.dirname(sourcePath),
      "e3chat-viewport.html"
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    const transparentOverride = `
    <style id="e3chat-viewport-background-override">
      html, body, #root, #root > div, canvas {
        background: transparent !important;
        background-color: transparent !important;
      }
    </style>
    <script id="e3chat-webgl-alpha-override">
      (() => {
        const forceTransparentClear = (Context) => {
          if (!Context || Context.prototype.__e3chatClearColorPatched) return;
          const originalClearColor = Context.prototype.clearColor;
          Object.defineProperty(Context.prototype, "__e3chatClearColorPatched", {
            value: true,
          });
          Context.prototype.clearColor = function (red, green, blue) {
            return originalClearColor.call(this, red, green, blue, 0);
          };
        };
        const applyHostBackground = (payload) => {
          if (!payload || payload.type !== "e3chat:set-background") return;
          const transparent = payload.mode === "transparent";
          const bodyStyle = document.body.style;
          document.documentElement.style.setProperty(
            "background",
            "transparent",
            "important"
          );
          bodyStyle.setProperty(
            "background-color",
            transparent ? "transparent" : payload.color || "#000000",
            "important"
          );
          if (transparent && payload.wallpaperUrl) {
            bodyStyle.setProperty(
              "background-image",
              'url("' + payload.wallpaperUrl + '")',
              "important"
            );
            bodyStyle.setProperty("background-repeat", "no-repeat", "important");
            bodyStyle.setProperty(
              "background-size",
              payload.hostWidth + "px " + payload.hostHeight + "px",
              "important"
            );
            bodyStyle.setProperty(
              "background-position",
              -payload.offsetX + "px " + -payload.offsetY + "px",
              "important"
            );
          } else {
            bodyStyle.setProperty("background-image", "none", "important");
          }
        };
        forceTransparentClear(window.WebGLRenderingContext);
        forceTransparentClear(window.WebGL2RenderingContext);
        window.addEventListener("message", (event) => applyHostBackground(event.data));
        window.parent.postMessage({ type: "e3chat:viewport-ready" }, "*");
      })();
    </script>`;
    if (!source.includes("</head>"))
      throw new Error("E3 native viewport does not contain a closing head tag");
    const existingOverride =
      /\s*<style id="e3chat-viewport-background-override">[\s\S]*?<\/style>(?:\s*<script id="e3chat-webgl-alpha-override">[\s\S]*?<\/script>)?/;
    const patched = existingOverride.test(source)
      ? source.replace(existingOverride, transparentOverride)
      : source.replace("</head>", `${transparentOverride}\n  </head>`);

    if (
      !fs.existsSync(patchedPath) ||
      fs.readFileSync(patchedPath, "utf8") !== patched
    ) {
      fs.writeFileSync(patchedPath, patched, "utf8");
    }
    return patchedPath;
  }

  async ensureWindow(baseUrl) {
    const win = e3ChatWindow.getE3ChatWindow();
    if (!win || win.isDestroyed()) {
      throw new Error("E3 Chat window is not available for 3D viewport");
    }
    this.window = win;
    return win;
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
      this.diagnostics?.add(
        "error",
        `Viewport RPC ${methodName} failed`,
        error.message
      );
      return { result: "", hash: "", error: error.message };
    }
  }
}

module.exports = E3ViewportBridge;
