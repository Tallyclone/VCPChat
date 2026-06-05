"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { app, dialog, shell, nativeImage, clipboard } = require("electron");
const { spawn, execFileSync } = require("child_process");
const NativeFsWatcher = require("./NativeFsWatcher");
const { NativeFsJobs, copyPathRecursive, movePath } = require("./NativeFsJobs");

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1000;
const STAT_CONCURRENCY = 16;
const FS_OPERATION_TIMEOUT_MS = 5000;
const NATIVE_FS_STATE_FILE = "native-file-mount-state.json";
const MAX_OPEN_WITH_RECENT = 8;
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/;

class NativeFsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class NativeFsService {
  constructor({ getDesktopWindow, sendToDesktop }) {
    this.getDesktopWindow = getDesktopWindow;
    this.sendToDesktopChannel = sendToDesktop;
    this.mountRegistry = new Map();
    this.globalClipboard = null;
    this.globalClipboardSystemSignature = null;
    this.clipboardPreviewCache = null;
    this.stateFile = path.join(app.getPath("userData"), NATIVE_FS_STATE_FILE);
    this.persistedState = { allowlist: [], openWithRecent: [] };
    this._stateLoaded = false;
    this.watcher = new NativeFsWatcher({
      sendToDesktop: (channel, data) => this._sendToDesktop(channel, data),
      service: this,
    });
    this.jobs = new NativeFsJobs({
      sendToDesktop: (channel, data) => this._sendToDesktop(channel, data),
    });
  }

  _sendToDesktop(channel, data) {
    const desktopWin = this.getDesktopWindow?.();
    if (desktopWin && !desktopWin.isDestroyed()) {
      desktopWin.webContents.send(channel, data);
    } else if (this.sendToDesktopChannel) {
      this.sendToDesktopChannel(channel, data);
    }
  }

  getMount(mountId) {
    return this.mountRegistry.get(mountId);
  }

  async registerMount(config = {}) {
    const mountPath = config.mountPath;
    if (
      !mountPath ||
      typeof mountPath !== "string" ||
      !path.isAbsolute(mountPath)
    ) {
      throw new NativeFsError(
        "ERR_INVALID_MOUNT_PATH",
        "mountPath must be an absolute path."
      );
    }

    const rootRealPath = await withNativeFsTimeout(
      fs.realpath(mountPath),
      "ERR_FS_TIMEOUT",
      `Timed out resolving mountPath: ${mountPath}`
    );
    const stat = await withNativeFsTimeout(
      fs.stat(rootRealPath),
      "ERR_FS_TIMEOUT",
      `Timed out reading mountPath metadata: ${rootRealPath}`
    );
    if (!stat.isDirectory()) {
      throw new NativeFsError(
        "ERR_NOT_DIRECTORY",
        "mountPath must be a directory."
      );
    }
    this._assertNotDenied(rootRealPath);

    const mode = config.mode === "readwrite" ? "readwrite" : "readonly";
    const showHidden = config.showHidden === true;
    const realtime = config.realtime !== false;
    const title = typeof config.title === "string" ? config.title.trim() : "";
    const ownerWidgetId =
      config.ownerWidgetId || `nfm-${crypto.randomBytes(4).toString("hex")}`;
    const mountId = `mount-${crypto.randomBytes(4).toString("hex")}`;
    const capabilityToken = crypto.randomBytes(32).toString("hex");

    await this._ensureStateLoaded();
    const authorized = await this._requestAuthorization(rootRealPath, mode);
    if (!authorized) {
      throw new NativeFsError(
        "ERR_USER_DENIED",
        "User denied NativeFileMount authorization."
      );
    }

    const mount = {
      mountId,
      rootRealPath,
      mode,
      showHidden,
      realtime,
      authorized: true,
      ownerWidgetId,
      capabilityToken,
      watcher: null,
      currentWatchDir: null,
      title: title || path.basename(rootRealPath) || rootRealPath,
      label: path.basename(rootRealPath) || rootRealPath,
      createdAt: Date.now(),
    };
    this.mountRegistry.set(mountId, mount);

    if (realtime) {
      await this.watcher.watch(mountId, rootRealPath).catch((error) => {
        console.warn("[NativeFsService] initial watch failed:", error.message);
      });
    }

    return {
      mountId,
      ownerWidgetId,
      capabilityToken,
      rootPath: rootRealPath,
      label: mount.label,
      capabilities: {
        mode,
        canWrite: mode === "readwrite",
        realtime,
        showHidden,
      },
      authorized: true,
    };
  }

  async list(params = {}) {
    const mount = this._requireMount(params.mountId);
    const dirPath = params.dirPath || mount.rootRealPath;
    const dirReal = await this.validateExistingPath(params.mountId, dirPath);
    const dirStat = await withNativeFsTimeout(
      fs.stat(dirReal),
      "ERR_FS_TIMEOUT",
      `Timed out reading directory metadata: ${dirReal}`
    );
    if (!dirStat.isDirectory()) {
      throw new NativeFsError(
        "ERR_NOT_DIRECTORY",
        "dirPath must be a directory."
      );
    }

    const limit = Math.min(
      Math.max(Number(params.limit) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const cursor = Math.max(Number(params.cursor) || 0, 0);
    const sort = params.sort || { by: "name", direction: "asc" };
    const largeDirectoryThreshold = 3000;
    const allDirents = [];
    let visibleCount = 0;
    let pageEntries = [];
    let hasMore = false;
    let nextCursor = null;
    let largeDirectory = false;

    const probeDir = await withNativeFsTimeout(
      fs.opendir(dirReal),
      "ERR_FS_TIMEOUT",
      `Timed out opening directory: ${dirReal}`
    );
    try {
      for await (const dirent of probeDir) {
        if (!mount.showHidden && this._isHiddenName(dirent.name)) continue;
        visibleCount += 1;
        if (visibleCount > largeDirectoryThreshold) {
          largeDirectory = true;
          break;
        }
        allDirents.push({ dirent, fullPath: path.join(dirReal, dirent.name) });
      }
    } finally {
      await probeDir.close().catch(() => {});
    }

    if (largeDirectory) {
      let skipped = 0;
      const pageDirents = [];
      const pageDir = await withNativeFsTimeout(
        fs.opendir(dirReal),
        "ERR_FS_TIMEOUT",
        `Timed out opening large directory page: ${dirReal}`
      );
      try {
        for await (const dirent of pageDir) {
          if (!mount.showHidden && this._isHiddenName(dirent.name)) continue;
          if (skipped < cursor) {
            skipped += 1;
            continue;
          }
          if (pageDirents.length >= limit) {
            hasMore = true;
            break;
          }
          pageDirents.push({
            dirent,
            fullPath: path.join(dirReal, dirent.name),
          });
        }
      } finally {
        await pageDir.close().catch(() => {});
      }
      pageEntries = await this._entriesFromDirentsConcurrent(
        params.mountId,
        dirReal,
        pageDirents,
        "list page entry skipped"
      );
      nextCursor = hasMore ? cursor + pageDirents.length : null;
    } else {
      const allEntries = await this._entriesFromDirentsConcurrent(
        params.mountId,
        dirReal,
        allDirents,
        "list entry skipped"
      );
      this._sortEntries(allEntries, sort);
      pageEntries = allEntries.slice(cursor, cursor + limit);
      hasMore = cursor + limit < allEntries.length;
      nextCursor = hasMore ? cursor + limit : null;
    }

    if (mount.realtime) {
      await this.watcher.watch(params.mountId, dirReal).catch((error) => {
        console.warn("[NativeFsService] watch switch failed:", error.message);
      });
    }

    return {
      dirPath: dirReal,
      parentDir: this._getParentDir(mount.rootRealPath, dirReal),
      canGoUp:
        normalizeForCompare(dirReal) !==
        normalizeForCompare(mount.rootRealPath),
      entries: pageEntries,
      hasMore,
      nextCursor,
      largeDirectory,
    };
  }

  async action(params = {}) {
    const action = params.action;
    const mount = this._requirePrivileged(params, {
      allowReadonlyActions: [
        "open",
        "openWith",
        "copy",
        "reveal",
        "clipboardPreview",
      ],
    });
    const targetPaths = Array.isArray(params.targetPaths)
      ? params.targetPaths
      : [];

    switch (action) {
      case "open":
        return this._open(params.mountId, targetPaths[0]);
      case "reveal":
        return this._reveal(params.mountId, targetPaths[0]);
      case "openWith":
        return this._openWith(params.mountId, targetPaths[0]);
      case "copy":
        return this._copy(params.mountId, targetPaths, "copy");
      case "copyTo":
        this._assertWritable(mount);
        return this._copyTo(params);
      case "cut":
        this._assertWritable(mount);
        return this._copy(params.mountId, targetPaths, "cut");
      case "paste":
        this._assertWritable(mount);
        return this._paste(params);
      case "clipboardPreview":
        return this._clipboardPreview(params);
      case "rename":
        this._assertWritable(mount);
        return this._rename(params);
      case "trash":
        this._assertWritable(mount);
        return this._trash(params);
      case "newFolder":
        this._assertWritable(mount);
        return this._newFolder(params);
      case "move":
        this._assertWritable(mount);
        return this._moveSingle(params);
      default:
        throw new NativeFsError(
          "ERR_UNKNOWN_ACTION",
          `Unknown nativeFs action: ${action}`
        );
    }
  }

  async startDrag(params = {}, event) {
    this._requirePrivileged(params);
    const paths = await this._validateTargetPaths(
      params.mountId,
      params.paths || []
    );
    if (event?.sender?.startDrag && paths.length > 0) {
      const icon = nativeImage.createEmpty();
      event.sender.startDrag({ files: paths, icon });
    }
    return { success: true, paths };
  }

  async importFiles(params = {}) {
    const mount = this._requirePrivileged(params);
    this._assertWritable(mount);
    if (params.source !== "user") {
      throw new NativeFsError(
        "ERR_USER_SOURCE_REQUIRED",
        "External file import requires a user drag/drop source."
      );
    }
    const destDir = await this.validateExistingPath(
      params.mountId,
      params.destDir || mount.rootRealPath
    );
    const externalPaths = Array.isArray(params.externalPaths)
      ? params.externalPaths
      : [];
    if (externalPaths.length === 0) return { success: true, imported: [] };
    const conflictStrategy = params.conflictStrategy || "ask";
    if (conflictStrategy === "overwrite" && params.confirmed !== true) {
      throw new NativeFsError(
        "ERR_CONFIRM_REQUIRED",
        "Overwrite import requires explicit confirmation."
      );
    }

    const jobId = this.jobs.createJob({
      type: "importFiles",
      task: async ({ signal, progress }) => {
        const imported = [];
        for (let i = 0; i < externalPaths.length; i += 1) {
          if (signal.aborted) throw new NativeFsError("ERR_CANCELLED");
          const srcReal = await fs.realpath(externalPaths[i]);
          const dest = await this._resolveConflict(
            path.join(destDir, path.basename(srcReal)),
            conflictStrategy,
            params.confirmed === true
          );
          await copyPathRecursive(srcReal, dest, {
            signal,
            overwrite: conflictStrategy === "overwrite",
          });
          imported.push({ name: path.basename(dest), path: dest });
          progress({ completed: i + 1, total: externalPaths.length });
        }
        return { imported };
      },
    });
    return { success: true, jobId };
  }

  async watchDir(params = {}) {
    const dirPath =
      params.dirPath || this._requireMount(params.mountId).rootRealPath;
    const dirReal = await this.validateExistingPath(params.mountId, dirPath);
    return this.watcher.watch(params.mountId, dirReal);
  }

  async unwatchDir(params = {}) {
    this._requireMount(params.mountId);
    return this.watcher.unwatch(params.mountId);
  }

  async unmount(params = {}) {
    const mount = this._requirePrivileged(params);
    await this.watcher.unwatch(params.mountId);
    if (this.globalClipboard?.sourceMountId === params.mountId) {
      this.globalClipboard = null;
    }
    this.mountRegistry.delete(params.mountId);
    return { success: true, rootPath: mount.rootRealPath };
  }

  async cancelJob(params = {}) {
    const jobId = typeof params === "string" ? params : params.jobId;
    if (!jobId)
      throw new NativeFsError("ERR_INVALID_JOB_ID", "jobId is required.");
    return this.jobs.cancel(jobId);
  }

  async closeAll() {
    await this.watcher.closeAll();
    this.mountRegistry.clear();
    this.globalClipboard = null;
    this.globalClipboardSystemSignature = null;
    this.clipboardPreviewCache = null;
  }

  async buildEntry(mountId, targetPath) {
    const real = await this.validateExistingPath(mountId, targetPath);
    const stat = await fs.lstat(real);
    return this._entryFromStat(mountId, real, stat);
  }

  async validateExistingPath(mountId, targetPath) {
    const mount = this._requireMount(mountId);
    if (!targetPath || typeof targetPath !== "string") {
      throw new NativeFsError("ERR_INVALID_PATH", "targetPath is required.");
    }
    const targetReal = await fs.realpath(targetPath);
    this._assertInside(mount.rootRealPath, targetReal);
    return targetReal;
  }

  async validateNewChildPath(mountId, parentDir, basename) {
    const mount = this._requireMount(mountId);
    this._assertValidBasename(basename);
    const parentReal = await fs.realpath(parentDir);
    this._assertInside(mount.rootRealPath, parentReal);
    return path.join(parentReal, basename.normalize("NFC").trim());
  }

  listActiveMounts() {
    return Array.from(this.mountRegistry.values()).map((mount) => ({
      widgetId: mount.ownerWidgetId,
      mountId: mount.mountId,
      title: mount.title || mount.label,
      rootPath: mount.rootRealPath,
      mode: mount.mode,
    }));
  }

  _requireMount(mountId) {
    const mount = this.mountRegistry.get(mountId);
    if (!mount)
      throw new NativeFsError("ERR_MOUNT_NOT_FOUND", "Mount does not exist.");
    return mount;
  }

  _requirePrivileged(params, options = {}) {
    const mount = this._requireMount(params.mountId);
    if (params.ownerWidgetId !== mount.ownerWidgetId)
      throw new NativeFsError("ERR_OWNER_MISMATCH");
    if (params.capabilityToken !== mount.capabilityToken)
      throw new NativeFsError("ERR_BAD_TOKEN");
    const allow = options.allowReadonlyActions || [];
    if (mount.mode !== "readwrite" && !allow.includes(params.action)) {
      throw new NativeFsError("ERR_READONLY", "Mount is readonly.");
    }
    return mount;
  }

  _assertWritable(mount) {
    if (mount.mode !== "readwrite")
      throw new NativeFsError("ERR_READONLY", "Mount is readonly.");
  }

  async _requestAuthorization(rootRealPath, mode) {
    await this._ensureStateLoaded();
    if (this._isPathAllowlisted(rootRealPath, mode)) return true;

    const desktopWin = this.getDesktopWindow?.();
    if (!desktopWin || desktopWin.isDestroyed()) return true;
    const result = await dialog.showMessageBox(desktopWin, {
      type: "question",
      buttons: ["允许本次", "允许并记住", "拒绝"],
      defaultId: 0,
      cancelId: 2,
      title: "NativeFileMount 授权确认",
      message: "允许 VCPdesktop 挂载本机文件夹？",
      detail: `路径：${rootRealPath}\n模式：${
        mode === "readwrite" ? "可读写" : "只读"
      }\n\n卡片将只能在该目录范围内操作。选择“允许并记住”后，同一路径后续将自动授权；系统敏感目录仍会被拒绝。`,
    });
    if (result.response === 1) {
      await this._rememberAllowedPath(rootRealPath, mode);
      return true;
    }
    return result.response === 0;
  }

  _assertNotDenied(realPath) {
    const denied = [];
    if (process.platform === "win32") {
      const systemDrive = process.env.SystemDrive || "C:";
      denied.push(path.join(systemDrive, "Windows"));
      denied.push(path.join(systemDrive, "Program Files"));
      denied.push(path.join(systemDrive, "Program Files (x86)"));
      denied.push(path.join(systemDrive, "System Volume Information"));
    } else {
      denied.push("/System", "/bin", "/sbin", "/usr/bin", "/usr/sbin");
    }
    const target = normalizeForCompare(realPath);
    for (const item of denied) {
      const cmp = normalizeForCompare(item);
      const rel = path.relative(cmp, target);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        throw new NativeFsError(
          "ERR_DENYLIST",
          `Denied sensitive path: ${realPath}`
        );
      }
    }
  }

  async _ensureStateLoaded() {
    if (this._stateLoaded) return;
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw);
      this.persistedState = {
        allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
        openWithRecent: Array.isArray(parsed.openWithRecent)
          ? parsed.openWithRecent
          : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("[NativeFsService] load state failed:", error.message);
      }
    }
    this._stateLoaded = true;
  }

  async _saveState() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const payload = JSON.stringify(this.persistedState, null, 2);
    await fs.writeFile(this.stateFile, payload, "utf8");
  }

  _isPathAllowlisted(rootRealPath, mode) {
    const target = normalizeForCompare(rootRealPath);
    return this.persistedState.allowlist.some((item) => {
      if (!item || typeof item.path !== "string") return false;
      if (normalizeForCompare(item.path) !== target) return false;
      return item.mode === "readwrite" || mode !== "readwrite";
    });
  }

  async _rememberAllowedPath(rootRealPath, mode) {
    const target = normalizeForCompare(rootRealPath);
    const filtered = this.persistedState.allowlist.filter(
      (item) => item?.path && normalizeForCompare(item.path) !== target
    );
    filtered.push({
      path: rootRealPath,
      mode,
      trustedAt: Date.now(),
    });
    this.persistedState.allowlist = filtered;
    await this._saveState();
  }

  async _chooseOpenWithApp() {
    const choices = await this._validOpenWithRecent();
    const desktopWin = this.getDesktopWindow?.();
    const buttons = [
      ...choices.map((item) => `最近：${path.basename(item.path)}`),
      "选择其他 .exe",
      "取消",
    ];
    const chooseOtherIndex = buttons.length - 2;
    const cancelIndex = buttons.length - 1;
    const result = await dialog.showMessageBox(desktopWin, {
      type: "question",
      buttons,
      defaultId: choices.length > 0 ? 0 : chooseOtherIndex,
      cancelId: cancelIndex,
      title: "选择打开方式",
      message: "选择用于打开该文件的应用",
      detail:
        choices.length > 0
          ? "最近使用的应用会在启动前重新校验路径、mtime 与 size。"
          : "请选择一个 .exe 应用。",
    });
    if (result.response === cancelIndex) return null;
    if (result.response < choices.length) return choices[result.response];
    return this._pickOpenWithAppFromDialog(desktopWin);
  }

  async _validOpenWithRecent() {
    const valid = [];
    for (const item of this.persistedState.openWithRecent) {
      if (!item?.path) continue;
      try {
        const appPath = await withNativeFsTimeout(
          fs.realpath(item.path),
          "ERR_FS_TIMEOUT",
          `Timed out resolving recent app: ${item.path}`
        );
        const stat = await withNativeFsTimeout(
          fs.stat(appPath),
          "ERR_FS_TIMEOUT",
          `Timed out reading recent app metadata: ${appPath}`
        );
        if (
          normalizeForCompare(appPath) === normalizeForCompare(item.path) &&
          stat.mtimeMs === item.mtimeMs &&
          stat.size === item.size &&
          path.extname(appPath).toLowerCase() === ".exe"
        ) {
          valid.push({ path: appPath, stat });
        }
      } catch (error) {
        console.warn(
          "[NativeFsService] stale openWith recent skipped:",
          error.message
        );
      }
    }
    return valid.slice(0, MAX_OPEN_WITH_RECENT);
  }

  async _pickOpenWithAppFromDialog(desktopWin) {
    const result = await dialog.showOpenDialog(desktopWin, {
      title: "选择打开方式（仅 .exe）",
      properties: ["openFile"],
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const appPath = await withNativeFsTimeout(
      fs.realpath(result.filePaths[0]),
      "ERR_FS_TIMEOUT",
      `Timed out resolving selected app: ${result.filePaths[0]}`
    );
    const stat = await withNativeFsTimeout(
      fs.stat(appPath),
      "ERR_FS_TIMEOUT",
      `Timed out reading selected app metadata: ${appPath}`
    );
    if (path.extname(appPath).toLowerCase() !== ".exe") {
      throw new NativeFsError("ERR_INVALID_APP");
    }
    return { path: appPath, stat };
  }

  async _rememberOpenWithApp(appPath, stat) {
    const target = normalizeForCompare(appPath);
    const filtered = this.persistedState.openWithRecent.filter(
      (item) => item?.path && normalizeForCompare(item.path) !== target
    );
    filtered.unshift({
      path: appPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      usedAt: Date.now(),
    });
    this.persistedState.openWithRecent = filtered.slice(
      0,
      MAX_OPEN_WITH_RECENT
    );
    await this._saveState();
  }

  _assertInside(root, target) {
    const rootCmp = normalizeForCompare(root);
    const targetCmp = normalizeForCompare(target);
    const rel = path.relative(rootCmp, targetCmp);
    const inside =
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!inside)
      throw new NativeFsError("ERR_PATH_ESCAPE", "Path escapes mount root.");
  }

  _assertValidBasename(basename) {
    if (typeof basename !== "string")
      throw new NativeFsError("ERR_INVALID_NAME");
    const name = basename.normalize("NFC").trim();
    if (!name || name.endsWith("."))
      throw new NativeFsError("ERR_INVALID_NAME");
    if (ILLEGAL_NAME_CHARS.test(name))
      throw new NativeFsError("ERR_INVALID_NAME");
    if (WINDOWS_RESERVED_NAMES.test(name))
      throw new NativeFsError("ERR_RESERVED_NAME");
  }

  _getParentDir(rootRealPath, dirReal) {
    if (normalizeForCompare(rootRealPath) === normalizeForCompare(dirReal))
      return null;
    const parent = path.dirname(dirReal);
    return normalizeForCompare(parent) === normalizeForCompare(dirReal)
      ? null
      : parent;
  }

  _isHiddenName(name) {
    const normalized = String(name || "")
      .trim()
      .toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith(".")) return true;

    if (process.platform === "win32") {
      return (
        normalized === "$recycle.bin" ||
        normalized === "system volume information" ||
        normalized === "recovery" ||
        normalized === "config.msi"
      );
    }

    return false;
  }

  async _entryFromDirent(mountId, parentReal, dirent, fullPath) {
    const stat = await withNativeFsTimeout(
      dirent.isSymbolicLink() ? fs.lstat(fullPath) : fs.stat(fullPath),
      "ERR_FS_TIMEOUT",
      `Timed out reading entry metadata: ${fullPath}`
    );
    return this._entryFromStat(mountId, fullPath, stat, dirent.name);
  }

  async _entriesFromDirentsConcurrent(
    mountId,
    parentReal,
    direntItems,
    warningLabel
  ) {
    const entries = [];
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < direntItems.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const item = direntItems[currentIndex];
        try {
          entries.push(
            await this._entryFromDirent(
              mountId,
              parentReal,
              item.dirent,
              item.fullPath
            )
          );
        } catch (error) {
          console.warn(
            `[NativeFsService] ${warningLabel}:`,
            item.fullPath,
            error.message
          );
        }
      }
    };

    const workerCount = Math.min(STAT_CONCURRENCY, direntItems.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return entries;
  }

  _entryFromStat(mountId, fullPath, stat, nameOverride) {
    const mount = this._requireMount(mountId);
    const name = nameOverride || path.basename(fullPath);
    const relativePath = path.relative(mount.rootRealPath, fullPath);
    let type = "file";
    if (stat.isSymbolicLink()) type = "symlink";
    else if (stat.isDirectory()) type = "directory";
    return {
      name,
      path: fullPath,
      relativePath,
      type,
      ext: type === "file" ? path.extname(name).toLowerCase() : "",
      size: stat.size,
      mtime: stat.mtimeMs,
      hidden: this._isHiddenName(name),
      readonly: mount.mode !== "readwrite",
    };
  }

  _sortEntries(entries, sort) {
    const by = sort.by || "name";
    const direction = sort.direction === "desc" ? -1 : 1;
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      if (by === "size" || by === "mtime")
        return ((a[by] || 0) - (b[by] || 0)) * direction;
      return String(a.name).localeCompare(String(b.name), "zh-CN") * direction;
    });
  }

  async _validateTargetPaths(mountId, paths) {
    const result = [];
    for (const item of paths) {
      result.push(await this.validateExistingPath(mountId, item));
    }
    return result;
  }

  async _open(mountId, targetPath) {
    const targetReal = await this.validateExistingPath(mountId, targetPath);
    const error = await shell.openPath(targetReal);
    if (error) throw new NativeFsError("ERR_OPEN_FAILED", error);
    return { success: true, affectedPaths: [targetReal] };
  }

  async _reveal(mountId, targetPath) {
    const targetReal = await this.validateExistingPath(mountId, targetPath);
    shell.showItemInFolder(targetReal);
    return { success: true, affectedPaths: [targetReal] };
  }

  async _openWith(mountId, targetPath) {
    const targetReal = await this.validateExistingPath(mountId, targetPath);
    await this._ensureStateLoaded();

    const recentApp = await this._chooseOpenWithApp();
    if (!recentApp) return { success: false, error: "ERR_USER_CANCELLED" };

    const child = spawn(recentApp.path, [targetReal], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.unref();
    await this._rememberOpenWithApp(recentApp.path, recentApp.stat);
    return {
      success: true,
      affectedPaths: [targetReal],
      appPath: recentApp.path,
    };
  }

  _clipboardSignature(paths) {
    return paths
      .map((item) => normalizeForCompare(item))
      .sort()
      .join("\n");
  }

  _runStaPowerShell(script, options = {}) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
      { timeout: 5000, windowsHide: true, ...options }
    );
  }

  _existingClipboardPaths(paths) {
    const seen = new Set();
    const list =
      typeof paths === "string" ? [paths] : Array.isArray(paths) ? paths : [];
    return list
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim())
      .filter((item) => {
        try {
          if (!fsSync.existsSync(item)) return false;
          const key = normalizeForCompare(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        } catch (_) {
          return false;
        }
      });
  }

  _buildClipboardPreview(source, mode, paths) {
    const validPaths = this._existingClipboardPaths(paths);
    const signature = this._clipboardSignature(validPaths);
    return {
      success: true,
      source,
      mode: mode === "cut" ? "cut" : "copy",
      items: validPaths.map((item) => ({
        path: item,
        name: path.basename(item),
      })),
      signature,
      createdAt: Date.now(),
    };
  }

  _emptyClipboardPreview() {
    return {
      success: true,
      source: null,
      mode: "copy",
      items: [],
      signature: "",
      createdAt: Date.now(),
    };
  }

  _getClipboardForPaste() {
    const systemClip = this._readSystemFileClipboard();
    const systemSignature = systemClip?.paths
      ? this._clipboardSignature(systemClip.paths)
      : null;
    const clip =
      systemClip && systemSignature !== this.globalClipboardSystemSignature
        ? systemClip
        : this.globalClipboard || systemClip;
    return { clip, systemClip, systemSignature };
  }

  _clipboardPreview() {
    const { clip, systemClip, systemSignature } = this._getClipboardForPaste();
    if (!clip || !Array.isArray(clip.paths) || clip.paths.length === 0) {
      this.clipboardPreviewCache = null;
      return this._emptyClipboardPreview();
    }
    const source =
      systemClip &&
      clip === systemClip &&
      systemSignature !== this.globalClipboardSystemSignature
        ? "system"
        : "internal";
    const preview = this._buildClipboardPreview(source, clip.mode, clip.paths);
    this.clipboardPreviewCache = preview;
    return preview;
  }

  _writeSystemFileClipboard(paths, mode) {
    if (process.platform !== "win32") return;
    const validPaths = this._existingClipboardPaths(paths);
    if (validPaths.length === 0) return;
    try {
      const psList = JSON.stringify(validPaths);
      const dropEffect = mode === "cut" ? 2 : 1;
      const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Collections.Specialized
$paths = ConvertFrom-Json -InputObject @'
${psList}
'@
if ($paths -is [string]) { $paths = @($paths) }
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  [void]$files.Add([string]$p)
}
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$bytes = [BitConverter]::GetBytes([UInt32]${dropEffect})
$stream = New-Object System.IO.MemoryStream -ArgumentList (, $bytes)
$data.SetData("Preferred DropEffect", $stream)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)`;
      this._runStaPowerShell(script);
      return;
    } catch (error) {
      console.warn(
        "[NativeFsService] WinForms file clipboard write failed:",
        error.message
      );
    }
    if (!clipboard?.writeBuffer) return;
    try {
      const fileList = `${validPaths.join("\0")}\0\0`;
      clipboard.writeBuffer("FileNameW", Buffer.from(fileList, "ucs2"));
      const dropEffect = Buffer.alloc(4);
      dropEffect.writeUInt32LE(mode === "cut" ? 2 : 1, 0);
      clipboard.writeBuffer("Preferred DropEffect", dropEffect);
    } catch (error) {
      console.warn(
        "[NativeFsService] Electron file clipboard write failed:",
        error.message
      );
    }
  }

  _readSystemFileClipboard() {
    if (process.platform !== "win32") return null;
    try {
      const script = `Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$paths = @()
$effect = 1
if ($data -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
  $drop = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
  foreach ($p in $drop) {
    if ($p) { $paths += [string]$p }
  }
}
if ($data -and $data.GetDataPresent("Preferred DropEffect")) {
  $raw = $data.GetData("Preferred DropEffect")
  try {
    if ($raw -is [System.IO.Stream]) {
      $bytes = New-Object byte[] 4
      $raw.Position = 0
      [void]$raw.Read($bytes, 0, 4)
      $effect = [BitConverter]::ToUInt32($bytes, 0)
    } elseif ($raw -is [byte[]] -and $raw.Length -ge 4) {
      $effect = [BitConverter]::ToUInt32($raw, 0)
    }
  } catch { $effect = 1 }
}
[pscustomobject]@{ paths = $paths; effect = $effect } | ConvertTo-Json -Compress`;
      const output = this._runStaPowerShell(script, {
        encoding: "utf8",
      }).trim();
      if (output) {
        const parsed = JSON.parse(output);
        const paths = this._existingClipboardPaths(parsed?.paths);
        if (paths.length > 0) {
          return {
            mode: Number(parsed?.effect) === 2 ? "cut" : "copy",
            sourceMountId: null,
            paths,
          };
        }
      }
    } catch (error) {
      console.warn(
        "[NativeFsService] WinForms file clipboard read failed:",
        error.message
      );
    }
    if (!clipboard?.readBuffer) return null;
    try {
      const buffer = clipboard.readBuffer("FileNameW");
      if (!buffer || buffer.length === 0) return null;
      const text = buffer.toString("ucs2").replace(/\0+$/, "");
      const paths = this._existingClipboardPaths(text.split("\0"));
      if (paths.length === 0) return null;
      return { mode: "copy", sourceMountId: null, paths };
    } catch (error) {
      console.warn(
        "[NativeFsService] Electron file clipboard read failed:",
        error.message
      );
      return null;
    }
  }

  async _copy(mountId, targetPaths, mode) {
    const paths = await this._validateTargetPaths(mountId, targetPaths);
    if (paths.length === 0) {
      throw new NativeFsError(
        "ERR_EMPTY_SELECTION",
        "No files or folders selected for clipboard operation."
      );
    }
    this.globalClipboard = { mode, sourceMountId: mountId, paths };
    this._writeSystemFileClipboard(paths, mode);
    this.globalClipboardSystemSignature = this._clipboardSignature(paths);
    this.clipboardPreviewCache = this._buildClipboardPreview(
      "internal",
      mode,
      paths
    );
    return { success: true, affectedPaths: paths };
  }

  async _paste(params) {
    const mount = this._requireMount(params.mountId);
    const destDir = await this.validateExistingPath(
      params.mountId,
      typeof params.payload?.destDir === "string" && params.payload.destDir
        ? params.payload.destDir
        : mount.rootRealPath
    );
    const { clip } = this._getClipboardForPaste();
    if (!clip || !Array.isArray(clip.paths) || clip.paths.length === 0) {
      throw new NativeFsError("ERR_CLIPBOARD_EMPTY");
    }
    const sourceMount = clip.sourceMountId
      ? this._requireMount(clip.sourceMountId)
      : null;
    if (clip.mode === "cut" && sourceMount && sourceMount.mode !== "readwrite")
      throw new NativeFsError("ERR_READONLY");
    const conflictStrategy = params.payload?.conflictStrategy || "ask";
    const confirmed = params.payload?.confirmed === true;
    const confirmedCrossDevice = params.payload?.confirmedCrossDevice === true;
    if (conflictStrategy === "overwrite" && !confirmed) {
      throw new NativeFsError(
        "ERR_CONFIRM_REQUIRED",
        "Overwrite paste requires explicit confirmation."
      );
    }
    if (
      clip.mode === "cut" &&
      !confirmedCrossDevice &&
      (await this._hasCrossDeviceMove(clip.paths, destDir))
    ) {
      throw new NativeFsError(
        "ERR_CROSS_DEVICE_CONFIRM_REQUIRED",
        "Cross-device cut will be downgraded to copy + trash."
      );
    }

    const destinations = [];
    for (const src of clip.paths) {
      if (!fsSync.existsSync(src))
        throw new NativeFsError("ERR_SOURCE_NOT_FOUND");
      const requestedDest = path.join(destDir, path.basename(src));
      if (conflictStrategy === "ask" && fsSync.existsSync(requestedDest)) {
        throw new NativeFsError(
          "ERR_CONFLICT_NEEDS_CONFIRM",
          "Target already exists."
        );
      }
      const dest = await this._resolveConflict(
        requestedDest,
        conflictStrategy,
        confirmed
      );
      if (normalizeForCompare(src) === normalizeForCompare(dest)) {
        throw new NativeFsError(
          "ERR_SOURCE_EQUALS_DEST",
          "Cannot paste an item onto itself."
        );
      }
      destinations.push(dest);
    }

    const jobId = this.jobs.createJob({
      type: "paste",
      task: async ({ signal, progress }) => {
        for (let i = 0; i < clip.paths.length; i += 1) {
          if (signal.aborted) throw new NativeFsError("ERR_CANCELLED");
          const src = clip.paths[i];
          const dest = destinations[i];
          if (clip.mode === "cut")
            await movePath(src, dest, {
              signal,
              overwrite: conflictStrategy === "overwrite",
            });
          else
            await copyPathRecursive(src, dest, {
              signal,
              overwrite: conflictStrategy === "overwrite",
            });
          progress({ completed: i + 1, total: clip.paths.length });
        }
        if (clip.mode === "cut" && this.globalClipboard === clip)
          this.globalClipboard = null;
        return { affectedPaths: clip.paths.concat(destinations) };
      },
    });
    return { success: true, jobId, affectedPaths: destinations };
  }

  async _copyTo(params) {
    if (params.source !== "agent") {
      throw new NativeFsError(
        "ERR_AGENT_SOURCE_REQUIRED",
        "copyTo is reserved for Agent Action Queue operations."
      );
    }
    const mount = this._requireMount(params.mountId);
    const source = await this.validateExistingPath(
      params.mountId,
      params.payload?.from || params.targetPaths?.[0]
    );
    const toPath = params.payload?.to;
    const toDir = params.payload?.toDir;
    const destParent = toPath
      ? path.dirname(toPath)
      : toDir || params.payload?.destDir || mount.rootRealPath;
    const destName = toPath ? path.basename(toPath) : path.basename(source);
    const dest = await this.validateNewChildPath(
      params.mountId,
      destParent,
      destName
    );
    const conflictStrategy = params.payload?.conflictStrategy || "ask";
    const confirmed = params.payload?.confirmed === true;
    if (conflictStrategy === "overwrite" && !confirmed) {
      throw new NativeFsError(
        "ERR_CONFIRM_REQUIRED",
        "Overwrite copy requires explicit confirmation."
      );
    }
    const finalDest = await this._resolveConflict(
      dest,
      conflictStrategy,
      confirmed
    );
    const jobId = this.jobs.createJob({
      type: "copyTo",
      task: async ({ signal, progress }) => {
        if (signal.aborted) throw new NativeFsError("ERR_CANCELLED");
        await copyPathRecursive(source, finalDest, {
          signal,
          overwrite: conflictStrategy === "overwrite",
        });
        progress({ completed: 1, total: 1 });
        return { affectedPaths: [source, finalDest] };
      },
    });
    return { success: true, jobId, affectedPaths: [source, finalDest] };
  }

  async _rename(params) {
    const source = await this.validateExistingPath(
      params.mountId,
      params.targetPaths?.[0]
    );
    const target = await this.validateNewChildPath(
      params.mountId,
      path.dirname(source),
      params.payload?.newName
    );
    const sourceCmp = normalizeForCompare(source);
    const targetCmp = normalizeForCompare(target);
    if (sourceCmp === targetCmp && source === target) {
      return { success: true, affectedPaths: [source, target] };
    }
    if (fsSync.existsSync(target) && sourceCmp !== targetCmp) {
      throw new NativeFsError("ERR_TARGET_EXISTS", "Target already exists.");
    }
    if (
      sourceCmp === targetCmp &&
      source !== target &&
      process.platform === "win32"
    ) {
      const parsed = path.parse(source);
      const temp = path.join(
        parsed.dir,
        `.${parsed.name}.nfm-rename-${Date.now()}-${crypto
          .randomBytes(4)
          .toString("hex")}${parsed.ext}`
      );
      await fs.rename(source, temp);
      await fs.rename(temp, target);
    } else {
      await fs.rename(source, target);
    }
    return { success: true, affectedPaths: [source, target] };
  }

  async _trash(params) {
    if (params.source === "agent" && params.payload?.confirmed !== true) {
      throw new NativeFsError(
        "ERR_CONFIRM_REQUIRED",
        "Agent trash requires explicit confirmation."
      );
    }
    const paths = await this._validateTargetPaths(
      params.mountId,
      params.targetPaths || []
    );
    for (const item of paths) {
      await shell.trashItem(item);
    }
    return { success: true, affectedPaths: paths };
  }

  async _newFolder(params) {
    const mount = this._requireMount(params.mountId);
    const parentDir = params.payload?.parentDir || mount.rootRealPath;
    const target = await this.validateNewChildPath(
      params.mountId,
      parentDir,
      params.payload?.name || "新建文件夹"
    );
    await fs.mkdir(target, { recursive: false });
    return { success: true, affectedPaths: [target] };
  }

  async _moveSingle(params) {
    const source = await this.validateExistingPath(
      params.mountId,
      params.payload?.from || params.targetPaths?.[0]
    );
    const toPath = params.payload?.to;
    if (!toPath) throw new NativeFsError("ERR_INVALID_PATH");
    const conflictStrategy = params.payload?.conflictStrategy || "ask";
    const confirmed = params.payload?.confirmed === true;
    if (conflictStrategy === "overwrite" && !confirmed) {
      throw new NativeFsError(
        "ERR_CONFIRM_REQUIRED",
        "Overwrite move requires explicit confirmation."
      );
    }
    const target = await this.validateNewChildPath(
      params.mountId,
      path.dirname(toPath),
      path.basename(toPath)
    );
    await this._resolveConflict(target, conflictStrategy, confirmed);
    if (
      !params.payload?.confirmedCrossDevice &&
      (await this._isCrossDeviceMove(source, path.dirname(target)))
    ) {
      throw new NativeFsError(
        "ERR_CROSS_DEVICE_CONFIRM_REQUIRED",
        "Cross-device move will be downgraded to copy + trash."
      );
    }
    await movePath(source, target, {
      overwrite: conflictStrategy === "overwrite",
    });
    return { success: true, affectedPaths: [source, target] };
  }

  async _resolveConflict(dest, strategy, confirmed = false) {
    if (!fsSync.existsSync(dest)) return dest;
    if (strategy === "overwrite") {
      if (!confirmed)
        throw new NativeFsError(
          "ERR_CONFIRM_REQUIRED",
          "Overwrite requires explicit confirmation."
        );
      return dest;
    }
    if (strategy === "skip") throw new NativeFsError("ERR_TARGET_EXISTS");
    if (strategy === "ask")
      throw new NativeFsError("ERR_CONFLICT_NEEDS_CONFIRM");
    const parsed = path.parse(dest);
    for (let i = 1; i < 1000; i += 1) {
      const next = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
      if (!fsSync.existsSync(next)) return next;
    }
    throw new NativeFsError("ERR_TARGET_EXISTS");
  }

  async _hasCrossDeviceMove(sourcePaths, destDir) {
    for (const sourcePath of sourcePaths) {
      if (await this._isCrossDeviceMove(sourcePath, destDir)) return true;
    }
    return false;
  }

  async _isCrossDeviceMove(sourcePath, destDir) {
    try {
      const [sourceStat, destStat] = await Promise.all([
        fs.stat(sourcePath),
        fs.stat(destDir),
      ]);
      if (
        Number.isInteger(sourceStat.dev) &&
        Number.isInteger(destStat.dev) &&
        sourceStat.dev !== destStat.dev
      ) {
        return true;
      }
    } catch (error) {
      console.warn(
        "[NativeFsService] cross-device stat check failed:",
        sourcePath,
        destDir,
        error.message
      );
    }

    if (process.platform === "win32") {
      return (
        path.parse(sourcePath).root.toLowerCase() !==
        path.parse(destDir).root.toLowerCase()
      );
    }
    return false;
  }
}
function normalizeForCompare(p) {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function withNativeFsTimeout(promise, code, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new NativeFsError(code, message)),
      FS_OPERATION_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = {
  NativeFsService,
  NativeFsError,
  normalizeForCompare,
};
