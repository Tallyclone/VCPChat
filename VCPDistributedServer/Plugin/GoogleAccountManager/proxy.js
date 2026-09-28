"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const S = require("./storage");
async function token(root) {
  for (const relative of [
    "scripts/clash_party.token",
    "scripts/.clash_party_token",
    "clash_party.token",
  ]) {
    const file = path.join(root, relative);
    await S.safe(file);
    try {
      if ((await fs.stat(file)).size > 8192) S.fail("INVALID_TOKEN");
      const value = (await fs.readFile(file, "utf8"))
        .replace(/^\uFEFF/, "")
        .trim();
      if (value && !/[\r\n]/.test(value)) return value;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  S.fail("PROXY_TOKEN_MISSING");
}
function client(config) {
  let deadline = Date.now() + config.operationTimeoutMs;
  return async function request(method, route, body) {
    if (
      !["GET", "PUT"].includes(method) ||
      !(
        (method === "GET" && ["/outlets", "/groups"].includes(route)) ||
        /^\/groups\/[^/?]+(?:\?close=0)?$/.test(route)
      )
    )
      S.fail("INVALID_PROXY_REQUEST");
    const timeout = Math.min(config.httpTimeoutMs, deadline - Date.now());
    if (timeout <= 0) S.fail("PROXY_DEADLINE");
    const secret = await token(config.root);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(data);
      };
      const error = (code) => Object.assign(new Error(code), { code });
      const req = http.request(
        {
          host: config.proxyHost,
          port: config.proxyPort,
          method,
          path: route,
          headers: {
            Authorization: "Bearer " + secret,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 2097152) {
              req.destroy();
              finish(error("PROXY_RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          res.on("error", () => finish(error("PROXY_NETWORK_ERROR")));
          res.on("aborted", () => finish(error("PROXY_NETWORK_ERROR")));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300)
              return finish(
                error(
                  res.statusCode === 404
                    ? "PROXY_HTTP_NOT_FOUND"
                    : "PROXY_HTTP_ERROR"
                )
              );
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!S.object(data) || data.ok !== true)
                return finish(error("PROXY_RESPONSE_INVALID"));
              finish(null, data);
            } catch (e) {
              finish(error("PROXY_RESPONSE_INVALID"));
            }
          });
        }
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(error("PROXY_TIMEOUT"));
      }, timeout);
      req.on("error", () => finish(error("PROXY_NETWORK_ERROR")));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };
}
function outlets(data) {
  if (!Array.isArray(data.outlets)) S.fail("INVALID_OUTLETS");
  const list = data.outlets.filter(
    (o) =>
      S.object(o) &&
      o.enable !== false &&
      o.mode === "direct" &&
      String(o.remark || "").startsWith("octopus-top")
  );
  for (const o of list)
    if (
      !S.name(o.target) ||
      !S.name(o.remark) ||
      !/^\d+$/.test(String(o.port)) ||
      Number(o.port) < 1 ||
      Number(o.port) > 65535
    )
      S.fail("INVALID_OUTLET");
  list.sort((a, b) => Number(a.port) - Number(b.port));
  if (list.length < 50) S.fail("INSUFFICIENT_OUTLETS");
  // Shared ports/groups could silently change another profile's route.
  if (
    new Set(list.map((o) => Number(o.port))).size !== list.length ||
    new Set(list.map((o) => o.target)).size !== list.length
  )
    S.fail("DUPLICATE_OUTLET");
  return list.slice(0, 50);
}
function nodes(data) {
  if (!Array.isArray(data.proxies) || data.proxies.some((x) => !S.name(x)))
    S.fail("INVALID_GROUP");
  const list = [...new Set(data.proxies)].filter(
    (x) => !["octopus_top-自动", "DIRECT", "REJECT", "PASS"].includes(x)
  );
  if (!list.length) S.fail("EMPTY_GROUP");
  return list;
}
function duplicates(bindings) {
  const seen = new Map();
  for (const [id, b] of Object.entries(bindings)) {
    const ids = seen.get(b.node) || [];
    ids.push(Number(id));
    seen.set(b.node, ids);
  }
  return [...seen.values()].filter((ids) => ids.length > 1);
}
async function plan(request, old, force) {
  const list = outlets(await request("GET", "/outlets"));
  const pools = [];
  // Fetch everything before publishing any local state. A failure leaves bindings intact.
  for (const o of list)
    pools.push(
      nodes(await request("GET", "/groups/" + encodeURIComponent(o.target)))
    );
  const selected = new Array(50),
    used = new Set();
  // Reserve all valid old unique assignments first, including later slots.
  if (!force)
    for (let i = 0; i < 50; i++) {
      const previous = old.bindings[i + 1];
      if (
        previous &&
        previous.target === list[i].target &&
        pools[i].includes(previous.node) &&
        !used.has(previous.node)
      ) {
        selected[i] = previous.node;
        used.add(previous.node);
      }
    }
  // Augmenting paths avoid greedy duplicates when pools differ. Prefer keeping old
  // assignments, but move one if that is necessary to give another slot a unique node.
  const owner = new Map();
  selected.forEach((node, i) => {
    if (node) owner.set(node, i);
  });
  function assign(i, seen) {
    for (const node of pools[i])
      if (!seen.has(node) && !owner.has(node)) {
        seen.add(node);
        owner.set(node, i);
        selected[i] = node;
        return true;
      }
    for (const node of pools[i])
      if (!seen.has(node)) {
        seen.add(node);
        const previous = owner.get(node);
        if (assign(previous, seen)) {
          owner.set(node, i);
          selected[i] = node;
          return true;
        }
      }
    return false;
  }
  for (let i = 0; i < 50; i++) if (!selected[i]) assign(i, new Set());
  for (let i = 0; i < 50; i++)
    if (!selected[i]) selected[i] = pools[i][i % pools[i].length];
  const bindings = {};
  for (let i = 0; i < 50; i++)
    bindings[i + 1] = {
      port: Number(list[i].port),
      target: list[i].target,
      node: selected[i],
      remark: list[i].remark,
    };
  const d = new Date();
  return {
    version: 1,
    rebindStamp: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
    bindings,
  };
}
async function validate(request, id, binding) {
  if (!binding) S.fail("NO_PROXY_BINDING");
  const o = outlets(await request("GET", "/outlets"))[id - 1];
  if (o.target !== binding.target || Number(o.port) !== Number(binding.port))
    S.fail("STALE_PROXY_BINDING");
  const group = await request(
    "GET",
    "/groups/" + encodeURIComponent(binding.target)
  );
  if (!nodes(group).includes(binding.node)) S.fail("STALE_PROXY_NODE");
  return group;
}
async function reachable(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      ok
        ? resolve()
        : reject(
            Object.assign(new Error("PROXY_PORT_UNAVAILABLE"), {
              code: "PROXY_PORT_UNAVAILABLE",
            })
          );
    };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}
module.exports = {
  client,
  outlets,
  nodes,
  plan,
  validate,
  duplicates,
  reachable,
};
