const path = require("path");
const crypto = require("crypto");
const fs = require("fs-extra");
const { checksumBuffer, checksumJson } = require("../core/hash");
const { normalizeSlashes } = require("../utils/pathRules");

const IMAGE_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const THEME_VARIABLE_PATTERN = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
const WALLPAPER_PATTERN =
  /--chat-wallpaper-(dark|light)\s*:\s*url\((['"]?)([^)'";]+)\2\)\s*;/gi;

function hashThemeId(raw) {
  return crypto
    .createHash("sha256")
    .update(String(raw || "theme"), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function safeThemeIdFromFilename(filename) {
  const basename = path.basename(filename, path.extname(filename));
  const withoutPrefix = basename.replace(/^themes/i, "").trim();
  const raw = withoutPrefix || basename || "theme";
  const asciiSlug = raw
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const hash = hashThemeId(raw);
  return asciiSlug ? `${asciiSlug}-${hash}` : `theme-${hash}`;
}

function displayNameFromFilename(filename) {
  const basename = path.basename(filename, path.extname(filename));
  const withoutPrefix = basename.replace(/^themes/i, "").trim();
  return withoutPrefix || basename;
}

function normalizeCssUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^file:\/\//i, "");
}

function resolveCssAssetPath(cssPath, appRootPath, cssUrl) {
  const normalizedUrl = normalizeCssUrl(cssUrl);
  if (!normalizedUrl || /^[a-z][a-z0-9+.-]*:/i.test(normalizedUrl)) return null;
  const candidates = [
    path.resolve(path.dirname(cssPath), normalizedUrl),
    path.resolve(appRootPath, normalizedUrl.replace(/^\.\.\//, "")),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
  );
}

function mimeFromFile(filePath) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || null;
}

function mimeFromBuffer(buffer, filePath) {
  if (buffer && buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) {
    return "image/png";
  }
  if (
    buffer &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return mimeFromFile(filePath);
}

function slotForWallpaper(mode) {
  return mode === "light" ? "light" : "dark";
}

function collectVariables(cssText, selectorPattern) {
  const variables = {};
  let selectorMatch;
  while ((selectorMatch = selectorPattern.exec(cssText))) {
    const block = selectorMatch[1] || "";
    let variableMatch;
    THEME_VARIABLE_PATTERN.lastIndex = 0;
    while ((variableMatch = THEME_VARIABLE_PATTERN.exec(block))) {
      variables[variableMatch[1]] = variableMatch[2].trim();
    }
  }
  return variables;
}

function extractVariables(cssText) {
  return {
    dark: collectVariables(cssText, /:root\s*\{([\s\S]*?)\}/g),
    light: collectVariables(cssText, /body\.light-theme\s*\{([\s\S]*?)\}/g),
  };
}

async function buildThemeAssetRef(cssPath, appRootPath, mode, cssUrl) {
  const absolutePath = resolveCssAssetPath(cssPath, appRootPath, cssUrl);
  if (!absolutePath || !(await fs.pathExists(absolutePath))) return null;
  const buffer = await fs.readFile(absolutePath);
  const mimeType = mimeFromBuffer(buffer, absolutePath);
  if (!mimeType) return null;
  const hash = checksumBuffer(buffer);
  return {
    asset_hash: hash,
    hash,
    asset_type: "wallpaper",
    slot: slotForWallpaper(mode),
    filename: path.basename(absolutePath),
    mime_type: mimeType,
    size_bytes: buffer.length,
    checksum: hash,
    source_url: normalizeCssUrl(cssUrl),
    relative_path: normalizeSlashes(path.relative(appRootPath, absolutePath)),
    absolute_path: absolutePath,
  };
}

async function buildThemePackageFromCss(cssPath, appRootPath, config = {}) {
  const cssText = await fs.readFile(cssPath, "utf8");
  const themeId = safeThemeIdFromFilename(cssPath);
  const displayName = displayNameFromFilename(cssPath);
  const assets = [];
  let wallpaperMatch;
  WALLPAPER_PATTERN.lastIndex = 0;
  while ((wallpaperMatch = WALLPAPER_PATTERN.exec(cssText))) {
    const ref = await buildThemeAssetRef(
      cssPath,
      appRootPath,
      wallpaperMatch[1],
      wallpaperMatch[3]
    );
    if (ref && !assets.some((asset) => asset.asset_hash === ref.asset_hash)) {
      assets.push(ref);
    }
  }

  const variables = extractVariables(cssText);
  const manifest = {
    schema_version: 1,
    theme_id: themeId,
    display_name: displayName,
    version: 1,
    mode: "dual",
    source: "VChatSyncAdapter",
    source_device_id: config.deviceId || null,
    css: {
      filename: path.basename(cssPath),
      relative_path: normalizeSlashes(path.relative(appRootPath, cssPath)),
      checksum: checksumBuffer(Buffer.from(cssText, "utf8")),
    },
    variables,
    extra_css: cssText,
    assets: assets.map((asset) => ({
      asset_hash: asset.asset_hash,
      asset_type: asset.asset_type,
      slot: asset.slot,
      filename: asset.filename,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      checksum: asset.checksum,
      relative_path: asset.relative_path,
    })),
  };

  const payload = {
    theme_id: themeId,
    display_name: displayName,
    version: 1,
    mode: "dual",
    device_id: config.deviceId,
    source_device_id: config.deviceId,
    variables,
    extra_css: cssText,
    manifest,
    assets: manifest.assets,
  };
  payload.checksum = checksumJson({
    theme_id: payload.theme_id,
    display_name: payload.display_name,
    version: payload.version,
    mode: payload.mode,
    variables: payload.variables,
    extra_css: payload.extra_css,
    manifest: payload.manifest,
    assets: payload.assets,
  });

  return {
    theme_id: themeId,
    css_path: cssPath,
    relative_path: normalizeSlashes(path.relative(appRootPath, cssPath)),
    payload,
    assets,
    checksum: payload.checksum,
  };
}

async function scanThemePackages(config = {}) {
  const appRootPath =
    config.appRootPath || path.resolve(config.appDataPath, "..");
  const themesDir =
    config.themeStylesDir || path.join(appRootPath, "styles", "themes");
  if (!(await fs.pathExists(themesDir))) return [];
  const entries = await fs.readdir(themesDir, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.css$/i.test(entry.name)) continue;
    packages.push(
      await buildThemePackageFromCss(
        path.join(themesDir, entry.name),
        appRootPath,
        config
      )
    );
  }
  packages.sort((a, b) => a.theme_id.localeCompare(b.theme_id));
  return packages;
}

module.exports = {
  buildThemePackageFromCss,
  scanThemePackages,
  safeThemeIdFromFilename,
  mimeFromFile,
};
