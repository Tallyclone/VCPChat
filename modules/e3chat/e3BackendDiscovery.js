"use strict";

const { execFile } = require("child_process");

function execPowerShell(command, timeout = 5000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 3000);
  try {
    const res = await fetch(url, { method: options.method || "GET", signal: controller.signal, headers: options.headers });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text), text }; } catch (_) { return { ok: res.ok, status: res.status, text }; }
  } finally {
    clearTimeout(timer);
  }
}

class E3BackendDiscovery {
  constructor({ stateStore, diagnostics } = {}) {
    this.stateStore = stateStore;
    this.diagnostics = diagnostics;
  }

  normalizeBaseUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)) return null;
    return trimmed.replace("localhost", "127.0.0.1");
  }

  async discover(manualBaseUrl) {
    const manual = this.normalizeBaseUrl(manualBaseUrl);
    if (manual && await this.validateBaseUrl(manual)) return { baseUrl: manual, source: "manual" };

    const fromProcess = await this.discoverFromProcess();
    for (const baseUrl of fromProcess) {
      if (await this.validateBaseUrl(baseUrl)) {
        await this.remember(baseUrl);
        return { baseUrl, source: "process" };
      }
    }

    const last = await this.getLastKnownGood();
    if (last && await this.validateBaseUrl(last)) return { baseUrl: last, source: "last-known-good" };
    throw new Error("未发现可用的 E3 后端。请确认 E3 正在运行，或手动输入 http://127.0.0.1:<port>");
  }

  async discoverFromProcess() {
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='esws.exe'\" | Select-Object -ExpandProperty CommandLine";
    const { stdout } = await execPowerShell(cmd);
    const urls = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/--urls\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
      if (match) urls.push(`http://127.0.0.1:${match[1]}`);
    }
    return [...new Set(urls)];
  }

  async validateBaseUrl(baseUrl) {
    try {
      const url = `${baseUrl}/workspace-hub/negotiate?key=dev&negotiateVersion=1`;
      const result = await fetchJson(url, { method: "POST", timeout: 2500 });
      const ok = result.status >= 200 && result.status < 500 && (result.data?.connectionToken || result.data?.connectionId || result.text);
      if (ok) return true;
    } catch (error) {
      this.diagnostics?.add("debug", "E3 negotiate validate failed", error.message);
    }
    return false;
  }

  async remember(baseUrl) {
    if (!this.stateStore) return;
    await this.stateStore.patch("global", { lastKnownGoodBaseUrl: baseUrl });
  }

  async getLastKnownGood() {
    try {
      const state = await this.stateStore?.get("global");
      return this.normalizeBaseUrl(state?.lastKnownGoodBaseUrl);
    } catch (_) {
      return null;
    }
  }
}

module.exports = E3BackendDiscovery;
