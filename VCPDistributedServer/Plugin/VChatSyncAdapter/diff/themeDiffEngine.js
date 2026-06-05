const fs = require("fs-extra");
const { scanThemePackages } = require("../sync/themePackageSync");
const { canUploadInMode } = require("../sync/modePolicy");

async function uploadThemeAsset(centerClient, themePackage, asset, config) {
  const buffer = await fs.readFile(asset.absolute_path);
  return centerClient.uploadThemeAsset({
    buffer,
    theme_id: themePackage.theme_id,
    asset_hash: asset.asset_hash,
    asset_type: asset.asset_type || "wallpaper",
    slot: asset.slot || "default",
    mime_type: asset.mime_type,
    filename: asset.filename,
    relative_path: asset.relative_path,
    device_id: config.deviceId,
    operation_id: `theme_asset.${config.deviceId}.${themePackage.theme_id}.${asset.asset_hash}`,
  });
}

async function syncThemePackage(
  themePackage,
  localIndex,
  centerClient,
  config,
  logger
) {
  const previous = localIndex.getFile(themePackage.relative_path);
  const changed = !previous || previous.checksum !== themePackage.checksum;
  const assetResults = [];

  // Center requires an existing theme_package before a theme_asset can be linked
  // by theme_id. Upsert the package first so first-time theme sync succeeds.
  if (changed || !previous || previous.uploaded !== true) {
    await centerClient.upsertThemePackage({
      ...themePackage.payload,
      operation_id: `theme_package.${config.deviceId}.${themePackage.theme_id}.${themePackage.checksum}`,
    });
  }

  for (const asset of themePackage.assets) {
    const assetKey = `theme_asset:${asset.asset_hash}`;
    const previousAsset = localIndex.getFile(assetKey);
    const shouldUploadAsset =
      !previousAsset ||
      previousAsset.uploaded !== true ||
      previousAsset.relative_path !== asset.relative_path;
    if (shouldUploadAsset) {
      await uploadThemeAsset(centerClient, themePackage, asset, config);
    }
    await localIndex.setFile(assetKey, {
      kind: "theme_asset",
      theme_id: themePackage.theme_id,
      asset_hash: asset.asset_hash,
      asset_type: asset.asset_type,
      slot: asset.slot,
      filename: asset.filename,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      relative_path: asset.relative_path,
      local_path: asset.absolute_path,
      uploaded: true,
      updated_at: new Date().toISOString(),
    });
    assetResults.push({
      asset_hash: asset.asset_hash,
      uploaded: shouldUploadAsset,
    });
  }

  await localIndex.setFile(themePackage.relative_path, {
    kind: "theme_package",
    theme_id: themePackage.theme_id,
    checksum: themePackage.checksum,
    css_path: themePackage.css_path,
    relative_path: themePackage.relative_path,
    asset_hashes: themePackage.assets.map((asset) => asset.asset_hash),
    uploaded: true,
    updated_at: new Date().toISOString(),
  });

  if (logger && logger.info) {
    logger.info("theme package synced", {
      theme_id: themePackage.theme_id,
      changed,
      assets: themePackage.assets.length,
    });
  }

  return { changed, assets: assetResults.length };
}

async function syncLocalThemes(
  config,
  localIndex,
  centerClient,
  logger,
  context = {}
) {
  const mode = context.mode || "uninitialized";
  const summary = {
    packages: 0,
    changed: 0,
    assets: 0,
    skipped: 0,
  };

  if (!canUploadInMode(mode) || !centerClient || !centerClient.isConfigured()) {
    summary.skipped += 1;
    return { summary, skipped: true, reason: "mode_or_center_not_ready" };
  }

  const packages = await scanThemePackages(config);
  for (const themePackage of packages) {
    summary.packages += 1;
    try {
      const result = await syncThemePackage(
        themePackage,
        localIndex,
        centerClient,
        config,
        logger
      );
      if (result.changed) summary.changed += 1;
      summary.assets += result.assets;
    } catch (error) {
      summary.skipped += 1;
      if (logger && logger.warn) {
        logger.warn("theme package sync failed", {
          theme_id: themePackage.theme_id,
          error: error.message,
        });
      }
    }
  }

  return { summary };
}

module.exports = {
  syncLocalThemes,
  syncThemePackage,
  uploadThemeAsset,
};
