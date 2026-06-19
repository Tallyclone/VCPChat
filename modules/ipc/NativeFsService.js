"use strict";

/**
 * NativeFsService.js — 原生文件系统服务
 *
 * 职责：
 * - Mount 管理（注册/卸载）
 * - 文件浏览（list/stat）
 * - 文件操作（open/reveal）
 * - 安全校验（capabilityToken 验证、路径逃逸检测、mode 权限检查）
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { shell } = require("electron");

class NativeFsService {
  constructor() {
    /** @type {Map<string, MountInfo>} mountId -> MountInfo */
    this.mounts = new Map();
    this._idCounter = 0;
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

    return {
      entries,
      currentPath: relativePath === "." ? "" : relativePath,
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

    // 清理路径：移除前导的 / 或 \
    let cleanPath = relativePath.replace(/^[/\\]+/, "");

    // 使用 path.resolve 解析
    const fullPath = path.resolve(mount.rootRealPath, cleanPath);
    return fullPath;
  }
}

// 导出单例
module.exports = new NativeFsService();
