"use strict";
const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const { fail } = require("./storage");
function powershell(script, data) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 8388608,
        env: { ...process.env, GAM_DATA: JSON.stringify(data || {}) },
        encoding: "utf8",
      },
      (error, stdout) =>
        error
          ? reject(
              Object.assign(new Error("PROCESS_QUERY_FAILED"), {
                code: "PROCESS_QUERY_FAILED",
              })
            )
          : resolve(stdout.replace(/^\uFEFF/, "").trim())
    );
  });
}
const snapshotScript = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='mshta.exe'" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;commandLine=$_.CommandLine;created=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress`;
async function snapshot() {
  if (process.platform !== "win32") fail("WINDOWS_REQUIRED");
  const s = await powershell(snapshotScript);
  const data = s ? JSON.parse(s) : [];
  return Array.isArray(data) ? data : [data];
}
function norm(p) {
  return path.win32
    .normalize(p.replace(/\//g, "\\"))
    .replace(/\\+$/, "")
    .toLowerCase();
}
function flags(command) {
  // Windows quoting/backslash rules. Never interpret arguments after -- as switches.
  const text = String(command || ""),
    args = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let word = "",
      quoted = false;
    while (i < text.length && (quoted || !/\s/.test(text[i]))) {
      let slashes = 0;
      while (text[i] === "\\") {
        slashes++;
        i++;
      }
      if (text[i] === '"') {
        word += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) word += '"';
        else if (quoted && text[i + 1] === '"') {
          word += '"';
          i++;
        } else quoted = !quoted;
        i++;
      } else {
        word += "\\".repeat(slashes);
        if (i < text.length && (quoted || !/\s/.test(text[i])))
          word += text[i++];
      }
    }
    if (quoted) fail("PROCESS_ARGUMENTS_AMBIGUOUS");
    if (word === "--") break;
    args.push(word);
  }
  return args;
}
function flag(command, key) {
  const args = flags(command),
    matches = [];
  args.forEach((x, i) => {
    if (x.toLowerCase() === key) matches.push(args[i + 1] || "");
    else if (x.toLowerCase().startsWith(key + "="))
      matches.push(x.slice(key.length + 1));
  });
  return matches.length === 1 ? matches[0] : null;
}
function exact(command, directory) {
  const d = flag(command, "--user-data-dir");
  return d !== null && path.win32.isAbsolute(d) && norm(d) === norm(directory);
}
function selected(rows, directory) {
  const chrome = rows.filter(
    (p) => String(p.name).toLowerCase() === "chrome.exe"
  );
  const result = chrome.filter((p) => exact(p.commandLine, directory));
  const ids = new Set(result.map((p) => p.pid));
  for (let i = 0; i < result.length; i++)
    for (const p of chrome) {
      if (
        !ids.has(p.pid) &&
        p.ppid === result[i].pid &&
        (!p.created || !result[i].created || p.created >= result[i].created)
      ) {
        const other = flag(p.commandLine, "--user-data-dir");
        if (other && !exact(p.commandLine, directory)) continue;
        ids.add(p.pid);
        result.push(p);
      }
    }
  return result;
}
function mode(rows, directory) {
  const roots = rows.filter(
    (p) =>
      String(p.name).toLowerCase() === "chrome.exe" &&
      exact(p.commandLine, directory) &&
      !flag(p.commandLine, "--type")
  );
  if (!roots.length) return "unknown";
  const modes = roots.map((p) => {
    if (flags(p.commandLine).includes("--no-proxy-server")) return "direct";
    const proxy = flag(p.commandLine, "--proxy-server");
    return proxy ? proxy : "unknown";
  });
  return new Set(modes).size === 1 ? modes[0] : "unknown";
}
function assertVisible(rows) {
  if (
    rows.some(
      (p) =>
        ["chrome.exe", "mshta.exe"].includes(String(p.name).toLowerCase()) &&
        !p.commandLine
    )
  )
    fail("PROCESS_VISIBILITY_INCOMPLETE");
}
function assertNoHta(rows) {
  assertVisible(rows);
  if (rows.some((p) => String(p.name).toLowerCase() === "mshta.exe"))
    fail("HTA_RUNNING");
}
async function terminate(targets, { force = false } = {}) {
  if (
    targets.some(
      (p) =>
        !Number.isInteger(p.pid) ||
        p.pid <= 0 ||
        p.pid === process.pid ||
        p.pid === 30952 ||
        p.pid === 28452 ||
        !p.created ||
        p.name.toLowerCase() !== "chrome.exe"
    )
  )
    fail("UNSAFE_PROCESS_TARGET");
  if (!targets.length) return;
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop';
$data=$env:GAM_DATA|ConvertFrom-Json; $targets=@($data.targets);
function Checked($t) {
  $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$t.pid);
  if($null -eq $p){return $null};
  if($p.Name -ne 'chrome.exe' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne $t.created -or $p.CommandLine -cne $t.commandLine){throw 'identity changed'};
  return $p;
}
foreach($t in $targets){
  $p=Checked $t; if($null -eq $p){continue};
  $native=Get-Process -Id ([int]$t.pid) -ErrorAction SilentlyContinue;
  if($native -and $native.MainWindowHandle -ne 0){[void]$native.CloseMainWindow()};
}
$until=[DateTime]::UtcNow.AddSeconds(3);
do {
  $left=@($targets|Where-Object { $null -ne (Checked $_) });
  if($left.Count -eq 0){break}; Start-Sleep -Milliseconds 100;
} while([DateTime]::UtcNow -lt $until);
if($data.force){
  [array]::Reverse($left);
  foreach($t in $left){$p=Checked $t;if($null -eq $p){continue};$result=Invoke-CimMethod -InputObject $p -MethodName Terminate;if($result.ReturnValue -ne 0){throw 'termination failed'}};
}
'ok'`;
  await powershell(script, { targets, force });
}
async function launch(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: "ignore",
    });
    child.once("error", () =>
      reject(
        Object.assign(new Error("LAUNCH_FAILED"), { code: "LAUNCH_FAILED" })
      )
    );
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}
module.exports = {
  snapshot,
  flag,
  flags,
  exact,
  selected,
  mode,
  assertVisible,
  assertNoHta,
  terminate,
  launch,
};
