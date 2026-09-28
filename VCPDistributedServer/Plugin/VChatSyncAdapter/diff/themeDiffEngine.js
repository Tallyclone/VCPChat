const fs = require("fs-extra");
const { operationId } = require("../core/identity");
const { scanThemePackages, withThemeSyncLock } = require("../sync/themePackageSync");
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
  const changed = !previous || (previous.source_checksum
    ? previous.source_checksum !== themePackage.source_checksum
    : previous.checksum !== themePackage.checksum);
  const assetResults = [];

  if (!changed && previous.uploaded === true && previous.synced_from_center === true) {
    return { changed: false, assets: 0 };
  }

  // Center requires an existing theme_package before a theme_asset can be linked
  // by theme_id. Upsert the package first so first-time theme sync succeeds.
  if (changed || !previous || previous.uploaded !== true) {
    // Keep one id while retrying an upload, but give a later edit (including a
    // return to old CSS) its own operation instead of deduplicating by content.
    const pendingOperationId = previous &&
      previous.pending_theme_checksum === themePackage.checksum &&
      previous.pending_theme_operation_id ||
      operationId(config.deviceId, "theme_package.upsert", {
        item_type: "theme_package",
        id: themePackage.theme_id,
      }, themePackage.checksum);
    await localIndex.setFile(themePackage.relative_path, {
      ...previous,
      kind: "theme_package",
      theme_id: themePackage.theme_id,
      pending_theme_checksum: themePackage.checksum,
      pending_theme_operation_id: pendingOperationId,
    });
    await centerClient.upsertThemePackage({
      ...themePackage.payload,
      operation_id: pendingOperationId,
    });
  }

  for (const asset of themePackage.assets) {
    const assetKey = `theme_asset:${asset.asset_hash}`;
    const previousAsset = localIndex.getFile(assetKey);
    const uploadReason = !previousAsset
      ? "missing_local_index"
      : previousAsset.binary_uploaded !== true
      ? "binary_not_confirmed"
      : previousAsset.uploaded !== true
      ? "not_uploaded"
      : previousAsset.bootstrap_baseline === true
      ? "bootstrap_metadata_only"
      : previousAsset.relative_path !== asset.relative_path
      ? "relative_path_changed"
      : null;
    const shouldUploadAsset = !!uploadReason;
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
      binary_uploaded: true,
      metadata_baseline: previousAsset
        ? previousAsset.metadata_baseline === true
        : false,
      bootstrap_baseline: false,
      updated_at: new Date().toISOString(),
    });
    assetResults.push({
      asset_hash: asset.asset_hash,
      uploaded: shouldUploadAsset,
      reason: uploadReason,
    });
  }

  await localIndex.setFile(themePackage.relative_path, {
    ...previous,
    kind: "theme_package",
    theme_id: themePackage.theme_id,
    display_name: themePackage.payload.display_name,
    version: themePackage.payload.version,
    mode: themePackage.payload.mode,
    checksum: themePackage.checksum,
    source_checksum: themePackage.source_checksum,
    css_checksum: themePackage.css_checksum,
    css_path: themePackage.css_path,
    relative_path: themePackage.relative_path,
    asset_hashes: themePackage.assets.map((asset) => asset.asset_hash),
    uploaded: true,
    synced_from_center: false,
    pending_theme_checksum: null,
    pending_theme_operation_id: null,
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
  return withThemeSyncLock(config, () => syncLocalThemesUnlocked(
    config, localIndex, centerClient, logger, context
  ));
}

async function syncLocalThemesUnlocked(config, localIndex, centerClient, logger, context) {
  const mode = typeof context.modeProvider === "function"
    ? context.modeProvider()
    : context.mode || "uninitialized";
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

  const packages = await scanThemePackages(config, localIndex);
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
