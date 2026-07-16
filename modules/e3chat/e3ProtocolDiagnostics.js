"use strict";

const SENSITIVE = /(api[-_ ]?key|authorization|cookie|token|workspace[-_ ]?key|key=)[^\s&]*/gi;

class E3ProtocolDiagnostics {
  constructor(limit = 500) {
    this.limit = limit;
    this.items = [];
  }

  redact(value) {
    if (value == null) return value;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.replace(SENSITIVE, (m) => m.split(/[=:]/)[0] + "=<redacted>");
  }

  add(level, message, detail) {
    const item = {
      at: new Date().toISOString(),
      level,
      message: this.redact(message),
      detail: detail === undefined ? undefined : this.redact(detail),
    };
    this.items.push(item);
    if (this.items.length > this.limit) this.items.shift();
    return item;
  }

  list() { return this.items.slice(); }
  clear() { this.items = []; }
}

module.exports = E3ProtocolDiagnostics;
