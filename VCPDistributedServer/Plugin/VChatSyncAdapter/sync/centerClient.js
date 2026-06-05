const axios = require("axios");
const WebSocket = require("ws");
const FormData = require("form-data");

function isConfigured(config) {
  return !!(
    config.centerUrl &&
    config.syncKey &&
    config.syncKey !== "change-me"
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCenterClient(config, logger) {
  const http = axios.create({
    baseURL: config.centerUrl,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${config.syncKey}`,
      "Content-Type": "application/json",
    },
  });

  async function withRetry(action, retries = 3) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        await wait(Math.min(30000, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  return {
    isConfigured: () => isConfigured(config),
    async registerDevice() {
      if (!isConfigured(config)) {
        return { ok: false, skipped: true, reason: "center_not_configured" };
      }
      const response = await http.post("/devices/register", {
        device_id: config.deviceId,
        name: config.deviceName,
        platform: process.platform,
      });
      return response.data;
    },
    async submitOperation(operation) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await http.post("/operations", operation);
      return response.data;
    },
    async getStatus() {
      if (!isConfigured(config)) {
        return { ok: false, skipped: true, reason: "center_not_configured" };
      }
      const response = await withRetry(() => http.get("/status"));
      return response.data;
    },
    async getChanges(afterSeq = 0, limit = 1000) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await withRetry(() =>
        http.get("/changes", {
          params: { after_seq: afterSeq, limit },
        })
      );
      return response.data;
    },
    async uploadAttachment(attachment) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      if (attachment && attachment.buffer) {
        const form = new FormData();
        form.append("file", attachment.buffer, {
          filename:
            attachment.filename ||
            `${attachment.hash || "attachment"}${attachment.ext || ""}`,
          contentType: attachment.mime_type || "application/octet-stream",
        });
        for (const [key, value] of Object.entries(attachment)) {
          if (key === "buffer" || value === undefined || value === null)
            continue;
          form.append(key, String(value));
        }
        const response = await http.post("/attachments", form, {
          headers: form.getHeaders({
            Authorization: `Bearer ${config.syncKey}`,
          }),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
        return response.data;
      }
      const response = await http.post("/attachments", attachment);
      return response.data;
    },
    async downloadAttachment(hash) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await withRetry(() =>
        http.get(`/attachments/${encodeURIComponent(hash)}`, {
          responseType: "arraybuffer",
        })
      );
      return {
        buffer: Buffer.from(response.data),
        headers: response.headers || {},
      };
    },
    async upsertThemePackage(themePackage) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await http.post("/themes", themePackage);
      return response.data;
    },
    async uploadThemeAsset(asset) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const { buffer, ...metadata } = asset || {};
      if (!buffer) {
        throw new Error("theme asset buffer is required");
      }
      const response = await http.post("/themes/assets", {
        ...metadata,
        content_base64: Buffer.from(buffer).toString("base64"),
      });
      return response.data;
    },
    async downloadThemeAsset(hash) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await withRetry(() =>
        http.get(`/themes/assets/${encodeURIComponent(hash)}`, {
          responseType: "arraybuffer",
        })
      );
      return {
        buffer: Buffer.from(response.data),
        headers: response.headers || {},
      };
    },
    async importBootstrap(manifest) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await withRetry(() =>
        http.post("/bootstrap/import", manifest)
      );
      return response.data;
    },
    async exportBootstrap(options = {}) {
      if (!isConfigured(config)) {
        throw new Error("sync center is not configured");
      }
      const response = await withRetry(() =>
        http.get("/bootstrap/export", { params: options })
      );
      return response.data;
    },
    connectLatestSeq(onLatestSeq) {
      if (!isConfigured(config) || !config.enableWebSocket || !config.wsUrl)
        return null;
      const ws = new WebSocket(config.wsUrl, {
        headers: {
          Authorization: `Bearer ${config.syncKey}`,
        },
      });
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          const latestSeq =
            message.latest_seq ||
            message.latestSeq ||
            (message.data && message.data.latest_seq);
          if (latestSeq !== undefined) onLatestSeq(Number(latestSeq));
        } catch (error) {
          if (logger && logger.warn)
            logger.warn("latest_seq websocket message ignored", {
              error: error.message,
            });
        }
      });
      ws.on("error", (error) => {
        if (logger && logger.warn)
          logger.warn("latest_seq websocket error", { error: error.message });
      });
      return ws;
    },
  };
}

module.exports = { createCenterClient };
