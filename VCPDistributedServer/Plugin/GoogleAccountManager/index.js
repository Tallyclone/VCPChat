"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const S = require("./storage");
const P = require("./platform");
const X = require("./proxy");
const M = require("./manual");
const READ = [
  "list",
  "inspect",
  "proxy_status",
  "find_available_account",
  "list_outlets",
  "list_groups",
  "list_nodes",
];
const WRITE = [
  "login_with_proxy",
  "restore_auto_binding",
  "launch",
  "proxy_login",
  "close",
  "refresh_proxy_bindings",
  "set_note",
  "set_type",
  "find_and_launch",
  "close_all_managed_profiles",
];
const FIELDS = {
  list_outlets: ["keyword"],
  list_groups: ["keyword", "outletPort"],
  list_nodes: ["group", "keyword"],
  login_with_proxy: [
    "profile",
    "outletPort",
    "group",
    "node",
    "saveBinding",
    "reassignOutlet",
    "allowSharedSwitch",
    "restart",
    "force",
    "url",
  ],
  restore_auto_binding: ["profile"],
  list: ["type", "running", "emailHint", "noteContains"],
  inspect: ["profile"],
  launch: ["profile", "restart", "force", "url"],
  proxy_login: ["profile", "restart", "force", "url"],
  close: ["profile", "confirm", "force"],
  proxy_status: ["profile", "live"],
  refresh_proxy_bindings: ["force"],
  set_note: ["profile", "note"],
  set_type: ["profile", "type"],
  find_available_account: ["type", "emailHint", "noteContains", "initialized"],
  find_and_launch: [
    "type",
    "emailHint",
    "noteContains",
    "initialized",
    "mode",
    "url",
  ],
  close_all_managed_profiles: ["confirm", "force"],
};
function bool(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  S.fail("INVALID_BOOLEAN");
}
const SYSTEM_KEYS = ["MaidName", "maid", "tool_name", "valet", "ink", "archery", "timely_contact", "tool_password", "river"];
function argumentsFor(input) {
  if (!S.object(input) || !Object.hasOwn(FIELDS, input.command))
    S.fail("INVALID_COMMAND");
  const a = { ...input };
  for (const sysKey of SYSTEM_KEYS) delete a[sysKey];
  for (const k of Object.keys(a))
    if (k !== "command" && !FIELDS[a.command].includes(k))
      S.fail("UNKNOWN_ARGUMENT");
  if (Object.hasOwn(a, "profile")) a.profile = S.id(a.profile);
  if (
    [
      "inspect",
      "login_with_proxy",
      "restore_auto_binding",
      "launch",
      "proxy_login",
      "close",
      "set_note",
      "set_type",
    ].includes(a.command) &&
    !a.profile
  )
    S.fail("PROFILE_REQUIRED");
  for (const k of [
    "restart",
    "saveBinding",
    "reassignOutlet",
    "allowSharedSwitch",
    "confirm",
    "force",
    "live",
    "initialized",
    "running",
  ])
    if (Object.hasOwn(a, k)) a[k] = bool(a[k]);
  if (a.type !== undefined && !["google", "other"].includes(a.type))
    S.fail("INVALID_TYPE");
  if (a.url !== undefined) {
    if (
      typeof a.url !== "string" ||
      a.url.length > 4096 ||
      /[\x00-\x20\x7f]/.test(a.url) ||
      !/^https?:\/\//i.test(a.url)
    )
      S.fail("INVALID_URL");
    let u;
    try {
      u = new URL(a.url);
    } catch (e) {
      S.fail("INVALID_URL");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password
    )
      S.fail("INVALID_URL");
    a.url = u.href;
  }
  if (a.command === "set_type" && !a.type) S.fail("TYPE_REQUIRED");
  if (
    a.command === "set_note" &&
    (typeof a.note !== "string" ||
      a.note.length > 2000 ||
      /\u0000/.test(a.note))
  )
    S.fail("INVALID_NOTE");
  for (const k of ["emailHint", "noteContains"])
    if (a[k] !== undefined && (typeof a[k] !== "string" || a[k].length > 256))
      S.fail("INVALID_FILTER");
  if (a.command === "find_and_launch" && !["direct", "proxy"].includes(a.mode))
    S.fail("MODE_REQUIRED");
  if (
    ["close", "close_all_managed_profiles"].includes(a.command) &&
    a.confirm !== true
  )
    S.fail("CONFIRM_REQUIRED");
  if (a.outletPort !== undefined) a.outletPort = M.port(a.outletPort);
  for (const key of ["group", "node"])
    if (a[key] !== undefined && !S.name(a[key]))
      S.fail("INVALID_PROXY_SELECTION");
  if (
    a.keyword !== undefined &&
    (typeof a.keyword !== "string" || a.keyword.length > 256)
  )
    S.fail("INVALID_FILTER");
  if (a.command === "list_nodes" && !a.group) S.fail("GROUP_REQUIRED");
  if (a.command === "login_with_proxy" && (!a.outletPort || !a.node))
    S.fail("PROXY_SELECTION_REQUIRED");
  return a;
}
async function configuration(env) {
  const source = env.GAM_SOURCE_CONFIG || "G:/profiles-manage/config.json";
  if (!path.isAbsolute(source)) S.fail("INVALID_CONFIG_PATH");
  const local = await S.read(source);
  if (
    !S.object(local.paths) ||
    !path.isAbsolute(local.paths.accountsDir || "") ||
    !path.isAbsolute(local.paths.chromePath || "")
  )
    S.fail("INVALID_LOCAL_CONFIG");
  const root = path.resolve(local.paths.accountsDir);
  const allowedRoot = path.resolve(
    env.GAM_ALLOWED_ROOT || "G:/profiles-manage"
  );
  if (root.toLowerCase() !== allowedRoot.toLowerCase())
    S.fail("ROOT_NOT_ALLOWED");
  await S.safe(root);
  if (!(await fs.stat(root)).isDirectory()) S.fail("INVALID_ROOT");
  const proxyHost = local.clash?.host || "127.0.0.1",
    proxyPort = Number(local.clash?.port || 17890);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(proxyHost) ||
    !Number.isInteger(proxyPort) ||
    proxyPort < 1 ||
    proxyPort > 65535
  )
    S.fail("INVALID_PROXY_CONFIG");
  const allowed = String(env.GAM_ALLOWED_COMMANDS || READ.join(","))
    .split(",")
    .map((x) => x.trim());
  if (allowed.some((x) => !Object.hasOwn(FIELDS, x)))
    S.fail("INVALID_COMMAND_POLICY");
  const approval = env.GAM_APPROVAL || "local-policy";
  if (!["dialog", "local-policy"].includes(approval))
    S.fail("INVALID_APPROVAL_POLICY");
  return {
    root,
    chrome: path.resolve(local.paths.chromePath),
    proxyHost,
    proxyPort,
    allowed,
    approval,
    httpTimeoutMs: 5000,
    operationTimeoutMs: 90000,
  };
}
async function approve(config, args) {
  if (config.approval === "local-policy") return;
  let electron;
  try {
    electron = require("electron");
  } catch (e) {
    S.fail("LOCAL_APPROVAL_UNAVAILABLE");
  }
  if (!electron.dialog || !electron.app?.isReady())
    S.fail("LOCAL_APPROVAL_UNAVAILABLE");
  const choice = await electron.dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "GoogleAccountManager",
    message: `Allow ${args.command}${
      args.profile ? " for profile " + args.profile : ""
    }?`,
    detail:
      "This can launch/force-close Chrome, change local notes/types, or select proxy nodes. Keep the HTA closed until this operation finishes. No credentials are exported.",
  });
  if (choice.response !== 1) S.fail("USER_DENIED");
}
async function audit(root, command, phase, code) {
  const file = path.join(root, ".google_account_manager.audit.jsonl");
  await S.safe(file);
  await S.safe(file + ".1");
  try {
    if ((await fs.stat(file)).size > 1048576)
      await fs.rename(file, file + ".1");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Never write user arguments, notes, emails, node names, tokens, process command lines or raw exceptions.
  await fs.appendFile(
    file,
    JSON.stringify({
      time: new Date().toISOString(),
      command,
      phase,
      code: code || null,
    }) + "\n",
    { mode: 0o600 }
  );
}
const directory = (c, id) => path.join(c.root, "profile_" + S.id(id));
async function email(root, id) {
  try {
    const pref = await S.read(
      path.join(directory({ root }, id), "Default", "Preferences"),
      null,
      16777216
    );
    if (!pref) return { emailHint: "", preferenceStatus: "missing" };
    const candidates = [
      pref["google.services.username"],
      pref.google?.services?.username,
      pref.profile?.user_name,
    ];
    if (Array.isArray(pref.account_info))
      for (const a of pref.account_info)
        candidates.push(a.email, a.account_name);
    const hint = candidates.find(
      (x) => typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)
    );
    return { emailHint: hint || "", preferenceStatus: "read" };
  } catch (e) {
    if (e.code === "LINK_PATH_REFUSED") throw e;
    return { emailHint: "", preferenceStatus: "unreadable" };
  }
}
async function inventory(c, rows) {
  P.assertVisible(rows);
  const [notes, bindings] = await Promise.all([
      S.notes(c.root),
      M.effective(c.root),
    ]),
    result = [];
  for (let id = 1; id <= 50; id++) {
    const dir = directory(c, id);
    await S.safe(dir);
    let initialized = false;
    try {
      initialized = (await fs.stat(dir)).isDirectory();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const targets = P.selected(rows, dir);
    result.push({
      profile: id,
      type: notes.types[id] || (id <= 30 ? "google" : "other"),
      note: notes.notes[id] || "",
      initialized,
      ...(await email(c.root, id)),
      loginStatus: "unknown",
      emailHintIsLiveLogin: false,
      running: targets.length > 0,
      pids: targets.map((p) => p.pid),
      mode: targets.length ? P.mode(rows, dir) : "stopped",
      binding: bindings.bindings[id] || null,
    });
  }
  return result;
}
function matches(a, x) {
  return (
    (a.type === undefined || x.type === a.type) &&
    (a.running === undefined || x.running === a.running) &&
    (a.initialized === undefined || x.initialized === a.initialized) &&
    (a.emailHint === undefined ||
      x.emailHint.toLowerCase().includes(a.emailHint.toLowerCase())) &&
    (a.noteContains === undefined ||
      x.note.toLowerCase().includes(a.noteContains.toLowerCase()))
  );
}
async function closeProfile(c, id, platform, force = false) {
  const dir = directory(c, id);
  await S.safe(dir);
  const rows = await platform.snapshot();
  P.assertNoHta(rows);
  const targets = P.selected(rows, dir);
  if (targets.length) await platform.terminate(targets, { force });
  const current = await platform.snapshot();
  P.assertVisible(current);
  // Descendants may lose their parent after it exits. Track original identities,
  // not just the remaining tree, and never mistake a reused PID for that child.
  const remaining = P.selected(current, dir);
  const orphaned = current.some((p) =>
    targets.some((t) => t.pid === p.pid && t.created === p.created)
  );
  if (remaining.length || orphaned)
    S.fail(force ? "CLOSE_INCOMPLETE" : "CLOSE_REQUIRES_FORCE");
  return { profile: id, closedPids: targets.map((p) => p.pid), force };
}
async function refresh(c, a, deps, request) {
  const manual = await M.load(c.root);
  const old = await S.bindings(c.root);
  const next = await X.plan(request, old, a.force === true);
  P.assertNoHta(await deps.platform.snapshot());
  await S.atomic(path.join(c.root, ".google_proxy_bindings.json"), next);
  const bindings = { ...next.bindings, ...manual.bindings };
  return {
    ...next,
    bindings,
    manualProfilesPreserved: Object.keys(manual.bindings).map(Number),
    duplicateProfiles: X.duplicates(bindings),
    proxySelectionsChanged: false,
  };
}
async function launchProfile(c, a, deps, request, proxy) {
  const dir = directory(c, a.profile);
  await S.safe(dir);
  await S.safe(c.chrome);
  if (!(await fs.stat(c.chrome)).isFile()) S.fail("CHROME_NOT_FOUND");
  let rows = await deps.platform.snapshot();
  P.assertNoHta(rows);
  let binding, group, selection;
  if (proxy) {
    binding = (await M.effective(c.root)).bindings[a.profile];
    if (a.command === "login_with_proxy" || binding?.source === "manual") {
      selection = await M.resolve(
        request,
        a.command === "login_with_proxy"
          ? a
          : {
              outletPort: binding.port,
              group: binding.target,
              node: binding.node,
            }
      );
      binding = selection.binding;
      group = selection.group;
    } else group = await X.validate(request, a.profile, binding);
    await deps.reachable(c.proxyHost, binding.port);
  }
  const host = c.proxyHost === "::1" ? "[::1]" : c.proxyHost;
  const desired = proxy
    ? (binding.protocol || "http") + "://" + host + ":" + binding.port
    : "direct";
  const targets = P.selected(rows, dir);
  if (targets.length && !a.restart) {
    const mode = P.mode(rows, dir);
    if (mode !== desired) S.fail("MODE_CONFLICT_RESTART_REQUIRED");
    if (proxy && group.now !== binding.node)
      S.fail("PROXY_SELECTION_RESTART_REQUIRED");
    if (selection && a.saveBinding) await M.save(c.root, a.profile, binding);
    return {
      binding: binding || null,
      bindingSaved: !!(selection && a.saveBinding),
      profile: a.profile,
      alreadyRunning: true,
      mode,
      pids: targets.map((p) => p.pid),
    };
  }
  if (selection && group.now !== binding.node)
    await M.conflicts(
      request,
      rows,
      dir,
      binding,
      selection.outlets,
      a.allowSharedSwitch === true
    );
  if (targets.length)
    await closeProfile(c, a.profile, deps.platform, a.force === true);
  await fs.mkdir(dir, { recursive: true });
  await S.safe(dir);
  // Chrome must be able to create/write its isolated directory; do not permit default-profile fallback.
  const probe = path.join(dir, ".gam-write-test-" + process.pid);
  const h = await fs.open(probe, "wx");
  await h.close();
  await fs.unlink(probe);
  rows = await deps.platform.snapshot();
  P.assertNoHta(rows);
  if (P.selected(rows, dir).length) S.fail("PROFILE_BECAME_BUSY");
  if (selection) {
    // Recheck live routes immediately before changing the shared group.
    group = M.group(
      await request("GET", "/groups/" + encodeURIComponent(binding.target))
    );
    if (group.now !== binding.node) {
      await M.conflicts(
        request,
        rows,
        dir,
        binding,
        selection.outlets,
        a.allowSharedSwitch === true
      );
      try {
        await request(
          "PUT",
          "/groups/" + encodeURIComponent(binding.target) + "?close=0",
          { name: binding.node }
        );
        group = M.group(
          await request("GET", "/groups/" + encodeURIComponent(binding.target))
        );
        if (group.now !== binding.node) S.fail("PROXY_SELECTION_NOT_CONFIRMED");
      } catch (e) {
        S.fail("PROXY_SELECTION_UNCERTAIN_NO_LAUNCH");
      }
    }
  } else if (proxy) {
    // Refuse to switch a port/group used by another managed live profile.
    const state = await M.effective(c.root);
    for (let id = 1; id <= 50; id++)
      if (id !== a.profile && P.selected(rows, directory(c, id)).length) {
        const b = state.bindings[id];
        if (
          b &&
          (b.target === binding.target ||
            Number(b.port) === Number(binding.port))
        )
          S.fail("PROXY_IN_USE");
      }
    // Inspect actual process proxy arguments as well as possibly stale saved bindings.
    if (
      rows.some(
        (p) =>
          p.name.toLowerCase() === "chrome.exe" &&
          !P.exact(p.commandLine, dir) &&
          P.flag(p.commandLine, "--proxy-server") === desired
      )
    )
      S.fail("PROXY_IN_USE");
    // A timed-out PUT may already have been applied remotely. Never claim rollback.
    try {
      await request("PUT", "/groups/" + encodeURIComponent(binding.target), {
        name: binding.node,
      });
      const selected = await request(
        "GET",
        "/groups/" + encodeURIComponent(binding.target)
      );
      if (selected.now !== binding.node)
        S.fail("PROXY_SELECTION_NOT_CONFIRMED");
    } catch (e) {
      S.fail("PROXY_SELECTION_UNCERTAIN_NO_LAUNCH");
    }
  }
  const args = [
    "--user-data-dir=" + dir,
    proxy ? "--proxy-server=" + desired : "--no-proxy-server",
    "--disable-features=OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,OptimizationHints",
    "--disable-component-update",
    a.url || "https://accounts.google.com",
  ];
  try {
    const spawned = await deps.platform.launch(c.chrome, args);
    // Hold the lock through startup so a second find_and_launch sees the new session.
    let visible = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await deps.platform.snapshot();
      P.assertVisible(current);
      visible = P.selected(current, dir);
      if (visible.length && P.mode(current, dir) === desired) break;
      visible = [];
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!visible.length) S.fail("LAUNCH_NOT_VERIFIED");
    let bindingSaved = false,
      bindingSaveError;
    if (selection && a.saveBinding) {
      try {
        await M.save(c.root, a.profile, binding);
        bindingSaved = true;
      } catch (e) {
        bindingSaveError = safeCode(e);
      }
    }
    let selectionChain;
    if (selection) {
      try {
        selectionChain = await M.chain(request, binding.target);
      } catch (e) {
        selectionChain = { error: safeCode(e) };
      }
    }
    return {
      binding: binding || null,
      bindingSaved,
      bindingSaveError,
      selectionChain,
      sharedGroupMayAffectOtherApplications: !!selection,
      profile: a.profile,
      mode: desired,
      ...spawned,
      pids: visible.map((p) => p.pid),
      loginStatus: "unknown",
      proxySelected: proxy,
    };
  } catch (e) {
    if (proxy) S.fail("LAUNCH_FAILED_PROXY_MAY_HAVE_CHANGED");
    throw e;
  }
}
function createManager(overrides = {}) {
  const deps = {
    platform: P,
    reachable: X.reachable,
    approve,
    audit,
    ...overrides,
  };
  return async function call(input) {
    let a, c;
    try {
      a = argumentsFor(input);
      c =
        overrides.config || (await configuration(overrides.env || process.env));
      if (!c.allowed.includes(a.command)) S.fail("COMMAND_NOT_ALLOWED");
      if (WRITE.includes(a.command)) await deps.approve(c, a);
      const request = overrides.request || X.client(c);
      const work = async () => {
        const rows = await deps.platform.snapshot();
        P.assertVisible(rows);
        if (WRITE.includes(a.command)) P.assertNoHta(rows);
        if (["list_outlets", "list_groups", "list_nodes"].includes(a.command))
          return M.query(request, a);
        if (a.command === "restore_auto_binding")
          return M.restore(c.root, a.profile);
        if (a.command === "login_with_proxy")
          return launchProfile(c, a, deps, request, true);
        if (a.command === "list")
          return {
            accounts: (await inventory(c, rows)).filter((x) => matches(a, x)),
          };
        if (a.command === "inspect")
          return (await inventory(c, rows))[a.profile - 1];
        if (a.command === "proxy_status") {
          const data = await M.effective(c.root),
            result = {
              ...data,
              duplicateProfiles: X.duplicates(data.bindings),
              liveChecked: false,
            };
          if (a.profile) result.binding = data.bindings[a.profile] || null;
          if (a.live) {
            const outlets = (await M.outlets(request)).filter((o) => o.enable);
            result.liveChecked = true;
            result.usableOutlets = outlets.length;
            if (a.profile) {
              const b = data.bindings[a.profile];
              const group =
                b?.source === "manual"
                  ? (
                      await M.resolve(request, {
                        outletPort: b.port,
                        group: b.target,
                        node: b.node,
                      })
                    ).group
                  : await X.validate(request, a.profile, b);
              result.selectedNode =
                typeof group.now === "string" ? group.now : null;
            }
          }
          return result;
        }
        if (a.command === "set_note" || a.command === "set_type") {
          const n = await S.notes(c.root);
          if (a.command === "set_note") n.notes[a.profile] = a.note;
          else n.types[a.profile] = a.type;
          P.assertNoHta(await deps.platform.snapshot());
          await S.atomic(path.join(c.root, ".google_account_notes.json"), n);
          return {
            profile: a.profile,
            updated: a.command === "set_note" ? "note" : "type",
          };
        }
        if (a.command === "refresh_proxy_bindings")
          return refresh(c, a, deps, request);
        if (a.command === "launch" || a.command === "proxy_login")
          return launchProfile(
            c,
            a,
            deps,
            request,
            a.command === "proxy_login"
          );
        if (a.command === "close")
          return closeProfile(c, a.profile, deps.platform, a.force === true);
        if (a.command === "close_all_managed_profiles") {
          const result = [];
          for (let id = 1; id <= 50; id++)
            if (P.selected(rows, directory(c, id)).length) {
              try {
                result.push(
                  await closeProfile(c, id, deps.platform, a.force === true)
                );
              } catch (e) {
                result.push({ profile: id, error: safeCode(e) });
              }
            }
          return { profiles: result, complete: result.every((x) => !x.error) };
        }
        const found = (await inventory(c, rows)).find(
          (x) => !x.running && matches(a, x)
        );
        if (a.command === "find_available_account")
          return {
            account: found || null,
            reserved: false,
            availability: "not running; login/health not verified",
          };
        if (!found) S.fail("NO_AVAILABLE_ACCOUNT");
        return launchProfile(
          c,
          { ...a, profile: found.profile },
          deps,
          request,
          a.mode === "proxy"
        );
      };
      let details;
      if (WRITE.includes(a.command))
        details = await S.locked(c.root, async () => {
          await deps.audit(c.root, a.command, "attempt");
          try {
            const result = await work();
            await deps.audit(c.root, a.command, "success");
            return result;
          } catch (e) {
            await deps.audit(c.root, a.command, "error", safeCode(e));
            throw e;
          }
        });
      else details = await work();
      return envelope("success", details);
    } catch (e) {
      const code = safeCode(e);
      return envelope("error", { code, command: a?.command || null });
    }
  };
}
function safeCode(e) {
  return typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(e.code)
    ? e.code
    : "OPERATION_FAILED";
}
function envelope(status, details) {
  const content = [
    {
      type: "text",
      text: status === "success" ? JSON.stringify(details) : details.code,
    },
  ];
  return {
    status,
    ...(status === "error" ? { error: details.code } : {}),
    result: { content, details },
    details,
  };
}
let runtimeEnv;
async function initialize({ config = {} } = {}) {
  runtimeEnv = { ...process.env, ...config };
}
async function processToolCall(args) {
  return createManager({ env: runtimeEnv || process.env })(args);
}
module.exports = {
  initialize,
  processToolCall,
  createManager,
  configuration,
  argumentsFor,
};
if (require.main === module) {
  let raw = "",
    sent = false;
  process.stdin.setEncoding("utf8");
  const output = (result) => {
    if (!sent) {
      sent = true;
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  };
  process.stdin.on("data", (chunk) => {
    if (sent) return;
    raw += chunk;
    if (Buffer.byteLength(raw) > 16384) {
      raw = "";
      output(envelope("error", { code: "INPUT_TOO_LARGE" }));
    }
  });
  process.stdin.on("error", () =>
    output(envelope("error", { code: "INPUT_ERROR" }))
  );
  process.stdin.on("end", async () => {
    if (sent) return;
    let result;
    try {
      result = await processToolCall(JSON.parse(raw.replace(/^\uFEFF/, "")));
    } catch (e) {
      result = envelope("error", { code: "INVALID_JSON" });
    }
    output(result);
  });
}
