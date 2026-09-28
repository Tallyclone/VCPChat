"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
function fail(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}
function id(value) {
  if (!["number", "string"].includes(typeof value)) fail("INVALID_PROFILE");
  const number = Number(value);
  if (
    !Number.isInteger(number) ||
    number < 1 ||
    number > 50 ||
    String(number) !== String(value)
  )
    fail("INVALID_PROFILE");
  return number;
}
function object(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
async function safe(file) {
  const abs = path.resolve(file),
    root = path.parse(abs).root;
  let current = root;
  for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) fail("LINK_PATH_REFUSED");
    } catch (e) {
      if (e.code === "ENOENT") break;
      throw e;
    }
  }
  return abs;
}
async function read(file, fallback, max = 2097152) {
  await safe(file);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > max) fail("INVALID_STATE_SIZE");
    const b = await fs.readFile(file);
    if (b.length > max) fail("INVALID_STATE_SIZE");
    try {
      return JSON.parse(
        b
          .toString(b[0] === 255 && b[1] === 254 ? "utf16le" : "utf8")
          .replace(/^\uFEFF/, "")
      );
    } catch (e) {
      fail("INVALID_STATE_JSON");
    }
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
}
async function atomic(file, data) {
  await safe(file);
  await safe(file + ".bak");
  // Never replace corrupt JSON, including corruption after the caller's first read.
  await read(file, null);
  const serialized = JSON.stringify(data, null, 2);
  if (serialized === undefined) fail("INVALID_STATE_SCHEMA");
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  const backupTemp = temp + ".bak";
  const owned = new Set();
  async function writeTemp(destination, bytes) {
    const handle = await fs.open(destination, "wx", 0o600);
    owned.add(destination);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  try {
    await writeTemp(temp, serialized + "\n");
    let previous;
    try {
      previous = await fs.readFile(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (previous) {
      try {
        JSON.parse(
          previous
            .toString(
              previous[0] === 255 && previous[1] === 254 ? "utf16le" : "utf8"
            )
            .replace(/^\uFEFF/, "")
        );
      } catch (e) {
        fail("INVALID_STATE_JSON");
      }
      await writeTemp(backupTemp, previous);
      await fs.rename(backupTemp, file + ".bak");
      owned.delete(backupTemp);
    }
    await fs.rename(temp, file);
    owned.delete(temp);
  } finally {
    for (const destination of owned)
      await fs.unlink(destination).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  }
}
async function locked(root, fn) {
  await safe(root);
  const file = path.join(root, ".google_account_manager.lock");
  await safe(file);
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") fail("BUSY_LOCK");
    throw e;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, since: new Date().toISOString() })
    );
    return await fn();
  } finally {
    await handle.close();
    await fs.unlink(file);
  }
}
function validateMap(map) {
  if (!object(map)) fail("INVALID_STATE_SCHEMA");
  for (const k of Object.keys(map)) id(k);
}
async function notes(root) {
  const data = await read(path.join(root, ".google_account_notes.json"), {
    version: 1,
    notes: {},
    types: {},
  });
  if (!object(data) || data.version !== 1) fail("INVALID_STATE_SCHEMA");
  validateMap(data.notes);
  validateMap(data.types);
  if (
    Object.values(data.notes).some(
      (x) => typeof x !== "string" || x.length > 10000
    ) ||
    Object.values(data.types).some((x) => !["google", "other"].includes(x))
  )
    fail("INVALID_STATE_SCHEMA");
  return data;
}
async function bindings(root) {
  const data = await read(path.join(root, ".google_proxy_bindings.json"), {
    version: 1,
    rebindStamp: "",
    bindings: {},
  });
  if (
    !object(data) ||
    data.version !== 1 ||
    typeof data.rebindStamp !== "string"
  )
    fail("INVALID_STATE_SCHEMA");
  validateMap(data.bindings);
  for (const b of Object.values(data.bindings)) {
    if (
      !object(b) ||
      !Number.isInteger(Number(b.port)) ||
      Number(b.port) < 1 ||
      Number(b.port) > 65535 ||
      !name(b.target) ||
      !name(b.node) ||
      typeof b.remark !== "string"
    )
      fail("INVALID_BINDING");
  }
  return data;
}
function name(x) {
  return (
    typeof x === "string" &&
    x.length > 0 &&
    x.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(x)
  );
}
module.exports = {
  fail,
  id,
  object,
  safe,
  read,
  atomic,
  locked,
  notes,
  bindings,
  name,
};
