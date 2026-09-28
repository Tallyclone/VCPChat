const path = require("path");
const fs = require("fs-extra");
const { checksumBuffer, checksumJson } = require("../core/hash");
const { normalizeSlashes } = require("../utils/pathRules");
const {
  buildThemePackageFromCss,
  scanThemePackages,
  themeSourceChecksum,
  withThemeSyncLock,
} = require("../sync/themePackageSync");

function safeSegment(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 160)
    throw new Error(`${label} is required`);
  if (normalized === "." || normalized === "..")
    throw new Error(`unsafe ${label}`);
  if (!/^[\w.\-\u4e00-\u9fa5]+$/u.test(normalized))
    throw new Error(`unsafe ${label}`);
  return normalized;
}

function normalizeHash(value) {
  const hash = String(value || "")
    .replace(/^sha256[:-]/i, "")
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("theme asset hash must be sha256 hex");
  return hash;
}

function themeLibraryRoot(config) {
  return path.join(config.appDataPath, "theme_library");
}

function themeDir(config, themeId) {
  return path.join(themeLibraryRoot(config), safeSegment(themeId, "theme_id"));
}

function appRoot(config) {
  return config.appRootPath || path.resolve(config.appDataPath, "..");
}

function isSafeRelativePath(value) {
  const normalized = normalizeSlashes(String(value || "").trim());
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized))
    return false;
  return !normalized.split("/").some((segment) => segment === ".." || !segment);
}

function safeThemeCssRelativePath(manifest, themeId) {
  const css = (manifest.manifest && manifest.manifest.css) || manifest.css || {};
  const candidate = normalizeSlashes(css.relative_path || css.relativePath);
  if (
    isSafeRelativePath(candidate) &&
    /^styles\/themes\/[^/]+\.css$/i.test(candidate)
  ) {
    return normalizeSlashes(candidate);
  }
  const filename = path.basename(String(css.filename || `${themeId}.css`));
  const safeName = /\.css$/i.test(filename) ? filename : `${themeId}.css`;
  return normalizeSlashes(path.join("styles", "themes", safeName));
}

function safeWallpaperRelativePath(asset, hash) {
  const candidate = asset.relative_path || asset.relativePath;
  if (
    isSafeRelativePath(candidate) &&
    /^assets\/wallpaper\/[^/]+\.(?:png|jpe?g|webp)$/i.test(candidate)
  ) {
    return normalizeSlashes(candidate);
  }
  const fallback = `${hash}${extForAsset(asset)}`;
  const filename = path.basename(String(asset.filename || fallback));
  return normalizeSlashes(
    path.join("assets", "wallpaper", filename || fallback)
  );
}

function extForAsset(asset = {}) {
  const mime = String(asset.mime_type || asset.mime || "").toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  const ext = path.extname(String(asset.filename || "")).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".bin";
}

function manifestForEvent(event) {
  const payload = event.payload || {};
  const theme = payload.theme || payload.payload || payload;
  const manifest = theme.manifest || theme.manifest_json || {};
  return {
    ...theme,
    manifest,
    manifest_json: manifest,
    assets: Array.isArray(theme.assets)
      ? theme.assets
      : Array.isArray(manifest.assets)
      ? manifest.assets
      : [],
    synced_from_center: true,
    source_seq: event.seq,
    source_device_id: event.device_id || theme.source_device_id || null,
    synced_at: new Date().toISOString(),
  };
}

async function writeThemePackage(event, context) {
  const { config, localIndex, logger } = context;
  const manifest = manifestForEvent(event);
  const themeId = safeSegment(manifest.theme_id || event.entity_id, "theme_id");
  const dir = themeDir(config, themeId);
  const manifestPath = path.join(dir, "manifest.json");
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  const cssRelativePath = safeThemeCssRelativePath(manifest, themeId);
  const cssPath = path.join(appRoot(config), cssRelativePath);
  const cssText = String(
    manifest.extra_css ||
      manifest.extraCss ||
      (manifest.manifest && manifest.manifest.extra_css) ||
      ""
  );
  await fs.ensureDir(path.dirname(cssPath));
  await fs.writeFile(cssPath, cssText, "utf8");

  const previous = localIndex.getFile(cssRelativePath) || {};
  const identity = {
    theme_id: themeId,
    display_name: manifest.display_name || themeId,
    version: Number(manifest.version || 1),
    mode: manifest.mode || "dual",
  };
  const projected = await buildThemePackageFromCss(
    cssPath, appRoot(config), config, identity
  );
  const expectedCssChecksum = checksumBuffer(Buffer.from(cssText, "utf8"));
  const projectionUnchanged = projected.css_checksum === expectedCssChecksum;

  const manifestRelativePath = normalizeSlashes(
    path.relative(config.appDataPath, manifestPath)
  );
  const record = {
    kind: "theme_package",
    ...identity,
    checksum: projectionUnchanged ? projected.checksum : previous.checksum,
    source_checksum: projectionUnchanged
      ? projected.source_checksum
      : previous.source_checksum,
    css_checksum: expectedCssChecksum,
    center_checksum: manifest.checksum || checksumJson(manifest),
    manifest_path: manifestPath,
    css_path: cssPath,
    relative_path: cssRelativePath,
    manifest_relative_path: manifestRelativePath,
    asset_hashes: manifest.assets
      .map((asset) => asset.asset_hash || asset.hash)
      .filter(Boolean),
    last_applied_seq: event.seq,
    uploaded: true,
    synced_from_center: true,
    pending_theme_operation_id: null,
    pending_theme_checksum: null,
    updated_at: new Date().toISOString(),
  };
  // The watcher looks up CSS paths. Keep the library lookup as an alias for
  // bootstrap and UI consumers, but use the same baseline as a local scan.
  await localIndex.setFile(cssRelativePath, record);
  await localIndex.setFile(`theme_package:${themeId}`, record);
  if (logger && logger.info)
    logger.info("theme package projected", {
      theme_id: themeId,
      relativePath: cssRelativePath,
      manifestRelativePath,
    });
  return {
    theme_id: themeId,
    relativePath: cssRelativePath,
    manifestRelativePath,
  };
}

async function deleteThemePackage(event, context) {
  const { config, localIndex } = context;
  const themeId = safeSegment(event.entity_id, "theme_id");
  await fs.remove(themeDir(config, themeId));
  await localIndex.deleteFile(`theme_package:${themeId}`);
  return { theme_id: themeId, deleted: true };
}

async function writeThemeAsset(event, context) {
  const { config, centerClient, localIndex, logger } = context;
  const payload = event.payload || {};
  const asset = payload.asset || payload.payload || payload;
  const hash = normalizeHash(asset.asset_hash || asset.hash || event.entity_id);
  const themeId = asset.theme_id || asset.themeId || "unlinked";
  const dir = path.join(themeDir(config, themeId), "assets");
  const target = path.join(dir, `${hash}${extForAsset(asset)}`);
  const wallpaperRelativePath = safeWallpaperRelativePath(asset, hash);
  const wallpaperTarget = path.join(appRoot(config), wallpaperRelativePath);
  const beforePackages = await scanThemePackages(config, localIndex);
  let downloaded = false;
  let pendingBinary = false;
  if (!(await fs.pathExists(target))) {
    if (asset.binary_available === false) {
      pendingBinary = true;
    } else {
      if (!centerClient || !centerClient.downloadThemeAsset) {
        pendingBinary = true;
      } else {
        try {
          const result = await centerClient.downloadThemeAsset(hash);
          const buffer = result.buffer;
          if (checksumBuffer(buffer) !== hash)
            throw new Error(
              `downloaded theme asset checksum mismatch: ${hash}`
            );
          await fs.ensureDir(dir);
          await fs.writeFile(target, buffer);
          await fs.ensureDir(path.dirname(wallpaperTarget));
          await fs.writeFile(wallpaperTarget, buffer);
          downloaded = true;
        } catch (error) {
          if (/binary is not available|409/i.test(error.message || "")) {
            pendingBinary = true;
          } else {
            throw error;
          }
        }
      }
    }
  } else {
    const buffer = await fs.readFile(target);
    if (checksumBuffer(buffer) !== hash)
      throw new Error(`local theme asset checksum mismatch: ${hash}`);
    await fs.ensureDir(path.dirname(wallpaperTarget));
    if (!(await fs.pathExists(wallpaperTarget))) {
      await fs.writeFile(wallpaperTarget, buffer);
    } else if (checksumBuffer(await fs.readFile(wallpaperTarget)) !== hash) {
      await fs.writeFile(wallpaperTarget, buffer);
    }
  }
  const libraryRelativePath = normalizeSlashes(
    path.relative(config.appDataPath, target)
  );
  await localIndex.setFile(`theme_asset:${hash}`, {
    kind: "theme_asset_remote",
    theme_id: themeId,
    asset_hash: hash,
    asset_type: asset.asset_type || "wallpaper",
    slot: asset.slot || "default",
    filename: asset.filename || path.basename(target),
    mime_type: asset.mime_type || asset.mime || null,
    size_bytes: asset.size_bytes || 0,
    local_path: pendingBinary ? null : target,
    wallpaper_path: pendingBinary ? null : wallpaperTarget,
    relative_path: wallpaperRelativePath,
    library_relative_path: libraryRelativePath,
    downloaded,
    pending_binary: pendingBinary,
    binary_strategy: pendingBinary ? "download_by_hash" : "local",
    // A downloaded binary is already present in the center. A later watcher
    // scan must not upload it again as if it were a new local wallpaper.
    uploaded: !pendingBinary,
    binary_uploaded: !pendingBinary,
    bootstrap_baseline: false,
    last_applied_seq: event.seq,
    updated_at: new Date().toISOString(),
  });
  if (!pendingBinary) {
    await refreshThemeSourcesAfterAsset(beforePackages, wallpaperTarget, context);
  }
  if (logger && logger.info)
    logger.info("theme asset projected", {
      hash,
      theme_id: themeId,
      relativePath: wallpaperRelativePath,
      pendingBinary,
    });
  return {
    asset_hash: hash,
    relativePath: wallpaperRelativePath,
    pending_binary: pendingBinary,
  };
}

async function refreshThemeSourcesAfterAsset(beforePackages, wallpaperTarget, context) {
  const { config, localIndex } = context;
  const beforeByPath = new Map(beforePackages.map((entry) => [entry.relative_path, entry]));
  for (const after of await scanThemePackages(config, localIndex)) {
    const before = beforeByPath.get(after.relative_path);
    const record = localIndex.getFile(after.relative_path);
    if (!before || !record || record.source_checksum !== before.source_checksum) continue;
    // Only acknowledge the wallpaper we just projected. A user's concurrent
    // CSS edit or a change to another wallpaper must still be uploaded.
    if (themeSourceChecksum(before, wallpaperTarget) !== themeSourceChecksum(after, wallpaperTarget)) continue;
    if (before.source_checksum === after.source_checksum) continue;
    const next = {
      ...record,
      checksum: after.checksum,
      source_checksum: after.source_checksum,
      updated_at: new Date().toISOString(),
    };
    await localIndex.setFile(after.relative_path, next);
    await localIndex.setFile(`theme_package:${after.theme_id}`, next);
  }
}

async function applyThemeEventUnlocked(event, context) {
  if (event.entity_type === "theme_package") {
    if (event.action === "delete") return deleteThemePackage(event, context);
    if (["create", "update", "upsert", "baseline"].includes(event.action))
      return writeThemePackage(event, context);
  }
  if (event.entity_type === "theme_asset") {
    if (["create", "update", "upsert", "baseline"].includes(event.action))
      return writeThemeAsset(event, context);
    if (event.action === "delete")
      return { skipped: true, reason: "theme_asset_delete_keeps_cas" };
  }
  throw new Error(
    `unsupported theme event: ${event.entity_type}/${event.action}`
  );
}

async function applyThemeEvent(event, context) {
  return withThemeSyncLock(context.config, () => applyThemeEventUnlocked(event, context));
}

async function applyThemeEvents(events, context) {
  return withThemeSyncLock(context.config, async () => {
    let applied = 0;
    for (const event of events) {
      await applyThemeEventUnlocked(event, context);
      applied += 1;
    }
    return { applied };
  });
}

module.exports = { applyThemeEvents, applyThemeEvent };
