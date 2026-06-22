"use strict";

/**
 * NativeFsService.js — 原生文件系统服务
 *
 * 职责：
 * - Mount 管理（注册/卸载）
 * - 文件浏览（list/stat）
 * - 文件操作（open/reveal/copy/cut/rename/trash/newFolder/newFile）
 * - 剪贴板互通（Windows Explorer ↔ 挂件）
 * - 安全校验（capabilityToken 验证、路径逃逸检测、mode 权限检查）
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { shell } = require("electron");
const fse = require("fs-extra");

class NativeFsService {
  constructor() {
    /** @type {Map<string, MountInfo>} mountId -> MountInfo */
    this.mounts = new Map();
    this._idCounter = 0;
    /** @type {string[]|null} 剪切模式暂存的绝对路径列表（粘贴后清除） */
    this._cutPaths = null;
  }

  // ============================================================
  // Mount 管理
  // ============================================================

  /**
   * 注册文件系统 mount
   * @param {object} args
   * @param {string} args.mountPath - 要挂载的路径
   * @param {string} [args.mode='readonly'] - 访问模式
   * @param {string} [args.ownerWidgetId] - 所属挂件 ID
   * @returns {{ mountId: string, capabilityToken: string, rootRealPath: string }}
   */
  registerMount({ mountPath, mode = "readonly", ownerWidgetId = "" }) {
    if (!mountPath || typeof mountPath !== "string") {
      throw new Error("mountPath is required");
    }

    // 规范化路径
    const rootRealPath = path.resolve(mountPath);

    // 验证路径存在且为目录
    if (!fsSync.existsSync(rootRealPath)) {
      throw new Error(`Path does not exist: ${rootRealPath}`);
    }
    const stat = fsSync.statSync(rootRealPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${rootRealPath}`);
    }

    // 验证 mode
    if (mode !== "readonly" && mode !== "readwrite") {
      throw new Error(
        `Invalid mode: ${mode}. Must be 'readonly' or 'readwrite'`
      );
    }

    // 生成 mountId 和 capabilityToken
    const mountId = `mount-${Date.now()}_${crypto
      .randomBytes(6)
      .toString("hex")}`;
    const capabilityToken = crypto.randomBytes(32).toString("hex");

    const mountInfo = {
      mountId,
      capabilityToken,
      rootRealPath,
      mode,
      ownerWidgetId,
      createdAt: Date.now(),
    };

    this.mounts.set(mountId, mountInfo);
    console.log(
      `[NativeFsService] Mount registered: ${mountId}, path=${rootRealPath}, mode=${mode}`
    );

    return {
      mountId,
      capabilityToken,
      rootRealPath,
    };
  }

  /**
   * 卸载 mount
   */
  unmount({ mountId, capabilityToken }) {
    this._validateToken(mountId, capabilityToken);
    this.mounts.delete(mountId);

    // Phase 2: 清理该 mount 下的所有 watcher
    const NativeFsWatcher = require("./NativeFsWatcher");
    NativeFsWatcher.unwatchMount(mountId);

    console.log(`[NativeFsService] Mount unregistered: ${mountId}`);
    return { success: true };
  }

  /**
   * 获取 mount 信息
   */
  getInfo({ mountId, capabilityToken }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);
    return {
      mountId: mount.mountId,
      rootRealPath: mount.rootRealPath,
      mode: mount.mode,
      ownerWidgetId: mount.ownerWidgetId,
      createdAt: mount.createdAt,
    };
  }

  // ============================================================
  // Phase 2: 文件操作（copy/cut/rename/trash/newFolder/newFile）
  // ============================================================

  /**
   * 复制文件/文件夹
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string[]} args.sourcePaths - 源相对路径数组
   * @param {string} args.destDir - 目标目录相对路径
   * @param {string} [args.strategy='rename'] - 冲突策略: skip|overwrite|rename
   */
  async copy({
    mountId,
    capabilityToken,
    sourcePaths,
    destDir,
    strategy = "rename",
  }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    const destDirFull = this._resolvePath(mount, destDir);
    this._validatePathContainment(mount.rootRealPath, destDirFull);

    const results = [];
    for (const srcRel of sourcePaths) {
      const srcFull = this._resolvePath(mount, srcRel);
      this._validatePathContainment(mount.rootRealPath, srcFull);

      const baseName = path.basename(srcFull);
      let destFull = path.join(destDirFull, baseName);
      this._validatePathContainment(mount.rootRealPath, destFull);

      destFull = await this._resolveConflict(destFull, strategy);
      if (destFull === null) {
        results.push({ source: srcRel, skipped: true });
        continue;
      }

      await fse.copy(srcFull, destFull, {
        overwrite: strategy === "overwrite",
      });
      results.push({
        source: srcRel,
        dest: path.relative(mount.rootRealPath, destFull),
      });
    }

    return { results };
  }

  /**
   * 剪切（移动）文件/文件夹
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string[]} args.sourcePaths - 源相对路径数组
   * @param {string} args.destDir - 目标目录相对路径
   * @param {string} [args.strategy='rename'] - 冲突策略: skip|overwrite|rename
   */
  async cut({
    mountId,
    capabilityToken,
    sourcePaths,
    destDir,
    strategy = "rename",
  }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    const destDirFull = this._resolvePath(mount, destDir);
    this._validatePathContainment(mount.rootRealPath, destDirFull);

    const results = [];
    for (const srcRel of sourcePaths) {
      const srcFull = this._resolvePath(mount, srcRel);
      this._validatePathContainment(mount.rootRealPath, srcFull);

      const baseName = path.basename(srcFull);
      let destFull = path.join(destDirFull, baseName);
      this._validatePathContainment(mount.rootRealPath, destFull);

      destFull = await this._resolveConflict(destFull, strategy);
      if (destFull === null) {
        results.push({ source: srcRel, skipped: true });
        continue;
      }

      await fse.move(srcFull, destFull, {
        overwrite: strategy === "overwrite",
      });
      results.push({
        source: srcRel,
        dest: path.relative(mount.rootRealPath, destFull),
      });
    }

    return { results };
  }

  /**
   * 重命名文件/文件夹
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string} args.oldPath - 原相对路径
   * @param {string} args.newName - 新文件名（不含路径）
   */
  async rename({ mountId, capabilityToken, oldPath, newName }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    if (!newName || newName.includes("/") || newName.includes("\\")) {
      throw new Error("Invalid new name");
    }

    const oldFull = this._resolvePath(mount, oldPath);
    this._validatePathContainment(mount.rootRealPath, oldFull);

    const parentDir = path.dirname(oldFull);
    const newFull = path.join(parentDir, newName);
    this._validatePathContainment(mount.rootRealPath, newFull);

    // 检查目标是否已存在
    if (fsSync.existsSync(newFull)) {
      throw new Error(`Name already exists: ${newName}`);
    }

    await fs.rename(oldFull, newFull);
    return { newPath: path.relative(mount.rootRealPath, newFull) };
  }

  /**
   * 删除到回收站
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string[]} args.paths - 相对路径数组
   */
  async trash({ mountId, capabilityToken, paths }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    // trash v9 is ESM-only, must use dynamic import
    const { default: trashFn } = await import("trash");

    const fullPaths = [];
    for (const relPath of paths) {
      const fullPath = this._resolvePath(mount, relPath);
      this._validatePathContainment(mount.rootRealPath, fullPath);
      fullPaths.push(fullPath);
    }

    await trashFn(fullPaths);
    return { trashed: paths };
  }

  /**
   * 新建文件夹
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string} args.parentPath - 父目录相对路径
   * @param {string} args.folderName - 新文件夹名
   */
  async newFolder({ mountId, capabilityToken, parentPath, folderName }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    if (!folderName || folderName.includes("/") || folderName.includes("\\")) {
      throw new Error("Invalid folder name");
    }

    const parentFull = this._resolvePath(mount, parentPath);
    this._validatePathContainment(mount.rootRealPath, parentFull);

    const newFolderFull = path.join(parentFull, folderName);
    this._validatePathContainment(mount.rootRealPath, newFolderFull);

    if (fsSync.existsSync(newFolderFull)) {
      throw new Error(`Folder already exists: ${folderName}`);
    }

    await fs.mkdir(newFolderFull, { recursive: true });
    return { createdPath: path.relative(mount.rootRealPath, newFolderFull) };
  }

  /**
   * 新建文件
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string} args.parentPath - 父目录相对路径
   * @param {string} args.fileName - 新文件名
   * @param {string} [args.content=''] - 文件内容
   */
  async newFile({
    mountId,
    capabilityToken,
    parentPath,
    fileName,
    content = "",
  }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
      throw new Error("Invalid file name");
    }

    const parentFull = this._resolvePath(mount, parentPath);
    this._validatePathContainment(mount.rootRealPath, parentFull);

    const newFileFull = path.join(parentFull, fileName);
    this._validatePathContainment(mount.rootRealPath, newFileFull);

    if (fsSync.existsSync(newFileFull)) {
      throw new Error(`File already exists: ${fileName}`);
    }

    await fs.writeFile(newFileFull, content, "utf-8");
    return { createdPath: path.relative(mount.rootRealPath, newFileFull) };
  }

  // ============================================================
  // Phase 2: 剪贴板互通（Windows Explorer ↔ 挂件）
  // ============================================================

  /**
   * 将文件路径写入 Windows 系统剪贴板（CF_HDROP 格式）
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string[]} args.paths - 相对路径数组
   */
  async copyToClipboard({ mountId, capabilityToken, paths }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);

    const fullPaths = [];
    for (const relPath of paths) {
      const fullPath = this._resolvePath(mount, relPath);
      this._validatePathContainment(mount.rootRealPath, fullPath);
      fullPaths.push(fullPath);
    }

    // 使用 PowerShell 设置 CF_HDROP 剪贴板
    const { execSync } = require("child_process");
    const addLines = fullPaths
      .map((p) => `$col.Add('${p.replace(/'/g, "''")}')`)
      .join("; ");
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; ${addLines}; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;

    execSync(
      `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
      {
        windowsHide: true,
        timeout: 5000,
      }
    );

    this._cutPaths = null; // copy 操作清除剪切状态
    return { copied: paths };
  }

  /**
   * 剪切文件到 Windows 系统剪贴板（写入 CF_HDROP + Preferred DropEffect=MOVE）
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string[]} args.paths - 相对路径数组
   */
  async cutToClipboard({ mountId, capabilityToken, paths }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);

    const fullPaths = [];
    for (const relPath of paths) {
      const fullPath = this._resolvePath(mount, relPath);
      this._validatePathContainment(mount.rootRealPath, fullPath);
      fullPaths.push(fullPath);
    }

    // 使用 PowerShell 设置 CF_HDROP + Preferred DropEffect = MOVE (2)
    // 这使 Windows Explorer 在粘贴时执行移动而非复制
    const { execSync } = require("child_process");
    const addLines = fullPaths
      .map((p) => `$col.Add('${p.replace(/'/g, "''")}')`)
      .join("; ");
    const psScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dataObj = New-Object System.Windows.Forms.DataObject",
      "$col = New-Object System.Collections.Specialized.StringCollection",
      addLines,
      "$dataObj.SetFileDropList($col)",
      "$moveEffect = [byte[]](2,0,0,0)",
      "$ms = New-Object System.IO.MemoryStream(,$moveEffect)",
      "$dataObj.SetData('Preferred DropEffect', $ms)",
      "[System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true)",
    ].join("; ");

    execSync(
      `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
      {
        windowsHide: true,
        timeout: 5000,
      }
    );

    // 记录剪切状态，供 widget 内部粘贴时快速判断
    this._cutPaths = fullPaths;

    return { cut: paths };
  }

  /**
   * 从 Windows 系统剪贴板读取文件列表并粘贴到目标目录
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string} args.destDir - 目标目录相对路径
   * @param {string} [args.strategy='rename'] - 冲突策略: skip|overwrite|rename
   */
  async pasteFromClipboard({
    mountId,
    capabilityToken,
    destDir,
    strategy = "rename",
  }) {
    this._validateToken(mountId, capabilityToken);
    this._validateWriteAccess(mountId);
    const mount = this.mounts.get(mountId);

    const destDirFull = this._resolvePath(mount, destDir);
    this._validatePathContainment(mount.rootRealPath, destDirFull);

    // 从 Windows 剪贴板读取文件列表 + Preferred DropEffect
    const { execSync } = require("child_process");
    const psRead = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$data = [System.Windows.Forms.Clipboard]::GetDataObject()",
      "$dropEffect = 0",
      "if ($data.GetDataPresent('Preferred DropEffect')) {",
      "  $s = $data.GetData('Preferred DropEffect')",
      "  $b = New-Object byte[] 4",
      "  $null = $s.Read($b, 0, 4)",
      "  $dropEffect = [BitConverter]::ToInt32($b, 0)",
      "}",
      'Write-Output "DROPEFFECT:$dropEffect"',
      "$files = [System.Windows.Forms.Clipboard]::GetFileDropList()",
      "foreach ($f in $files) { Write-Output $f }",
    ].join("; ");

    let output;
    try {
      output = execSync(
        `powershell -NoProfile -Command "${psRead.replace(/"/g, '\\"')}"`,
        {
          windowsHide: true,
          timeout: 5000,
          encoding: "utf-8",
        }
      );
    } catch (err) {
      throw new Error("Failed to read clipboard: " + err.message);
    }

    // 解析输出：第一行为 DROPEFFECT:N，其余为文件路径
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    let clipboardDropEffect = 0;
    const clipPaths = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("DROPEFFECT:")) {
        clipboardDropEffect = parseInt(trimmed.slice(11), 10) || 0;
      } else if (trimmed) {
        clipPaths.push(trimmed);
      }
    }
    if (clipPaths.length === 0) {
      throw new Error("No files in clipboard");
    }

    // 判断是否为剪切模式：
    // 1. 剪贴板携带 Preferred DropEffect = DROPEFFECT_MOVE (2)（来自本应用或 Explorer 的剪切）
    // 2. 或内存 _cutPaths 匹配（向后兼容）
    const DROPEFFECT_MOVE = 2;
    const isCutMode =
      clipboardDropEffect === DROPEFFECT_MOVE ||
      (this._cutPaths &&
        this._cutPaths.length === clipPaths.length &&
        this._cutPaths.every((p) => clipPaths.includes(p)));

    const results = [];
    for (const srcFull of clipPaths) {
      if (!fsSync.existsSync(srcFull)) {
        results.push({ source: srcFull, error: "File not found" });
        continue;
      }

      const baseName = path.basename(srcFull);
      let destFull = path.join(destDirFull, baseName);
      this._validatePathContainment(mount.rootRealPath, destFull);

      destFull = await this._resolveConflict(destFull, strategy);
      if (destFull === null) {
        results.push({ source: srcFull, skipped: true });
        continue;
      }

      if (isCutMode) {
        await fse.move(srcFull, destFull, {
          overwrite: strategy === "overwrite",
        });
      } else {
        await fse.copy(srcFull, destFull, {
          overwrite: strategy === "overwrite",
        });
      }
      results.push({
        source: srcFull,
        dest: path.relative(mount.rootRealPath, destFull),
        moved: isCutMode,
      });
    }

    // 剪切完成后清除状态
    if (isCutMode) {
      this._cutPaths = null;
    }

    return { results };
  }

  // ============================================================
  // Phase 2: 辅助功能
  // ============================================================

  /**
   * 预览批量操作计划（dry-run）
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {object} args.plan - 操作计划描述
   */
  async requestOperations({ mountId, capabilityToken, plan }) {
    this._validateToken(mountId, capabilityToken);
    // 当前直接返回计划概要，未来可扩展为冲突检测
    return { plan, approved: false, message: "Review the operations above" };
  }

  /**
   * 显示原生确认对话框
   * @param {object} args
   * @param {string} [args.type='question'] - 对话框类型
   * @param {string} [args.title='确认'] - 标题
   * @param {string} args.message - 消息
   * @param {string} [args.detail] - 详细信息
   * @param {string[]} [args.buttons=['确定', '取消']] - 按钮文本
   */
  async confirm({
    type = "question",
    title = "确认",
    message,
    detail,
    buttons = ["确定", "取消"],
  }) {
    const { dialog } = require("electron");
    const desktopHandlers = require("./desktopHandlers");
    const desktopWin = desktopHandlers.getDesktopWindow();

    const result = await dialog.showMessageBox(desktopWin || null, {
      type,
      title,
      message,
      detail: detail || undefined,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });

    return { response: result.response, buttonLabel: buttons[result.response] };
  }

  // ============================================================
  // 文件浏览
  // ============================================================

  /**
   * 列出目录内容
   * @param {object} args
   * @param {string} args.mountId
   * @param {string} args.capabilityToken
   * @param {string} [args.path='.'] - 相对路径
   * @returns {{ entries: Array, currentPath: string }}
   */
  async list({ mountId, capabilityToken, path: relativePath = "." }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);
    const fullPath = this._resolvePath(mount, relativePath);
    this._validatePathContainment(mount.rootRealPath, fullPath);

    // 验证目标是目录
    const targetStat = await fs.stat(fullPath);
    if (!targetStat.isDirectory()) {
      throw new Error(`Not a directory: ${relativePath}`);
    }

    const dirEntries = await fs.readdir(fullPath, { withFileTypes: true });
    const entries = [];

    for (const entry of dirEntries) {
      try {
        const entryPath = path.join(fullPath, entry.name);
        const entryStat = await fs.stat(entryPath);
        const isDir = entry.isDirectory();

        entries.push({
          name: entry.name,
          type: isDir ? "directory" : "file",
          size: isDir ? 0 : entryStat.size,
          mtime: entryStat.mtimeMs,
          ext: isDir ? "" : path.extname(entry.name).toLowerCase(),
        });
      } catch (err) {
        // 跳过无法访问的条目（权限问题等）
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size: 0,
          mtime: 0,
          ext: "",
          error: err.message,
        });
      }
    }

    // 排序：目录在前，然后按名称排序
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    // Phase 2: 触发 NativeFsWatcher 监听当前目录
    const NativeFsWatcher = require("./NativeFsWatcher");
    const watchRelPath = relativePath === "." ? "" : relativePath;
    NativeFsWatcher.watch(mountId, watchRelPath, fullPath);

    return {
      entries,
      currentPath: watchRelPath,
    };
  }

  /**
   * 获取单个文件/文件夹的详细信息
   */
  async stat({ mountId, capabilityToken, path: relativePath }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);
    const fullPath = this._resolvePath(mount, relativePath);
    this._validatePathContainment(mount.rootRealPath, fullPath);

    const entryStat = await fs.stat(fullPath);
    const name = path.basename(fullPath);
    const isDir = entryStat.isDirectory();

    return {
      name,
      type: isDir ? "directory" : "file",
      size: entryStat.size,
      mtime: entryStat.mtimeMs,
      ctime: entryStat.ctimeMs,
      atime: entryStat.atimeMs,
      ext: isDir ? "" : path.extname(name).toLowerCase(),
      isReadOnly: false, // TODO: 检查实际权限
      isHidden: name.startsWith("."),
    };
  }

  // ============================================================
  // 文件操作
  // ============================================================

  /**
   * 使用系统默认应用打开文件
   */
  async open({ mountId, capabilityToken, path: relativePath }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);
    const fullPath = this._resolvePath(mount, relativePath);
    this._validatePathContainment(mount.rootRealPath, fullPath);

    // 验证文件存在
    await fs.access(fullPath);

    const result = await shell.openPath(fullPath);
    if (result) {
      // shell.openPath 返回空字符串表示成功，返回错误信息表示失败
      throw new Error(`Failed to open: ${result}`);
    }

    return { success: true };
  }

  /**
   * 在资源管理器中显示文件/文件夹
   */
  async reveal({ mountId, capabilityToken, path: relativePath }) {
    this._validateToken(mountId, capabilityToken);
    const mount = this.mounts.get(mountId);
    const fullPath = this._resolvePath(mount, relativePath);
    this._validatePathContainment(mount.rootRealPath, fullPath);

    // 验证路径存在
    await fs.access(fullPath);

    shell.showItemInFolder(fullPath);
    return { success: true };
  }

  // ============================================================
  // 安全校验
  // ============================================================

  /**
   * 验证 capabilityToken
   */
  _validateToken(mountId, capabilityToken) {
    if (!mountId || !capabilityToken) {
      throw new Error("mountId and capabilityToken are required");
    }

    const mount = this.mounts.get(mountId);
    if (!mount) {
      throw new Error(`Mount not found: ${mountId}`);
    }

    if (mount.capabilityToken !== capabilityToken) {
      throw new Error("Invalid capability token");
    }
  }

  /**
   * 验证路径不会逃逸出 mount 根目录
   * @param {string} mountPath - mount 根路径（已规范化）
   * @param {string} targetPath - 目标路径（已规范化）
   */
  _validatePathContainment(mountPath, targetPath) {
    const normalizedMount = path.resolve(mountPath);
    const normalizedTarget = path.resolve(targetPath);

    // 使用 path.relative 做包含关系判断，避免 Windows 盘符根目录（如 E:\\）
    // 在字符串前缀判断时因为末尾分隔符导致 E:\\ + \\ => E:\\\\ 而误判逃逸。
    const relative = path.relative(normalizedMount, normalizedTarget);

    // relative === '' 表示同一路径；否则必须是普通相对路径，不能以 .. 开头，也不能是绝对路径。
    if (relative === "") {
      return;
    }

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Path escape detected: target path is outside mount root`
      );
    }
  }

  /**
   * 检查是否有写权限
   */
  _validateWriteAccess(mountId) {
    const mount = this.mounts.get(mountId);
    if (mount.mode !== "readwrite") {
      throw new Error("Operation denied in readonly mode");
    }
  }

  /**
   * 将相对路径解析为绝对路径
   */
  _resolvePath(mount, relativePath) {
    if (!relativePath || relativePath === ".") {
      return mount.rootRealPath;
    }

    // 清理路径：移除前导的 / 或 \\
    let cleanPath = relativePath.replace(/^[/\\]+/, "");

    // 使用 path.resolve 解析
    const fullPath = path.resolve(mount.rootRealPath, cleanPath);
    return fullPath;
  }

  /**
   * 解决文件名冲突（Phase 2 辅助方法）
   * @param {string} destPath - 目标路径
   * @param {string} strategy - 冲突策略: skip|overwrite|rename
   * @returns {string|null} 解决后的路径，或 null（表示跳过）
   * @private
   */
  async _resolveConflict(destPath, strategy) {
    if (!fsSync.existsSync(destPath)) {
      return destPath;
    }

    if (strategy === "skip") {
      return null;
    }

    if (strategy === "overwrite") {
      return destPath;
    }

    // strategy === "rename": 追加 (1), (2), ...
    const dir = path.dirname(destPath);
    const ext = path.extname(destPath);
    const base = path.basename(destPath, ext);

    let counter = 1;
    let newPath;
    while (true) {
      newPath = path.join(dir, `${base} (${counter})${ext}`);
      if (!fsSync.existsSync(newPath)) {
        return newPath;
      }
      counter++;
      if (counter > 999) {
        throw new Error("Too many conflicting files");
      }
    }
  }
}

// 导出单例
module.exports = new NativeFsService();
