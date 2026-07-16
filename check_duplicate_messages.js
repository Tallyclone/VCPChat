const fs = require("fs");
const path = require("path");

const appDataPath = path.resolve(__dirname, "VCPDistributedServer/AppData");

const messageIds = new Map(); // key: item_type:item_id:topic_id:message_id, value: file paths
const configEntityIds = new Map(); // key: entity_id, value: file paths
const attachmentHashes = new Map(); // key: hash, value: file paths

async function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, visitor);
    else await visitor(fullPath);
  }
}

function isHistoryPath(relativePath) {
  return /[\\/]topics[\\/][^\\/]+[\\/]history\.json$/i.test(relativePath);
}

function isConfigPath(relativePath) {
  return /[\\/]config\.json$/i.test(relativePath);
}

function relativeAppDataPath(appDataPath, fullPath) {
  return path.relative(appDataPath, fullPath).replace(/\\/g, "/");
}

function parseHistoryIdentity(relativePath) {
  const match = /UserData[\\/]([^\\/]+)[\\/]topics[\\/]([^\\/]+)[\\/]history\.json$/i.exec(relativePath);
  if (match) {
    return {
      item_type: "agent",
      item_id: match[1],
      topic_id: match[2],
    };
  }
  return null;
}

(async () => {
  console.log("正在扫描 AppData 查找重复数据...\n");

  await walk(appDataPath, async (filePath) => {
    const relativePath = relativeAppDataPath(appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;

    // 检查 history.json
    if (isHistoryPath(relativePath)) {
      const identity = parseHistoryIdentity(relativePath);
      if (!identity) return;

      try {
        const history = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!Array.isArray(history)) return;

        history.forEach((message) => {
          if (!message || !message.id) return;
          const key = `${identity.item_type}:${identity.item_id}:${identity.topic_id}:${message.id}`;
          if (!messageIds.has(key)) {
            messageIds.set(key, []);
          }
          messageIds.get(key).push(relativePath);
        });
      } catch (e) {
        console.log(`[警告] 无法读取 ${relativePath}: ${e.message}`);
      }
    }

    // 检查 config.json
    if (isConfigPath(relativePath)) {
      try {
        const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const entityId = relativePath;
        if (!configEntityIds.has(entityId)) {
          configEntityIds.set(entityId, []);
        }
        configEntityIds.get(entityId).push(relativePath);
      } catch (e) {
        console.log(`[警告] 无法读取 ${relativePath}: ${e.message}`);
      }
    }
  });

  // 检查重复
  let hasDuplicates = false;

  console.log("=== 检查重复的 message.id ===");
  for (const [key, paths] of messageIds.entries()) {
    if (paths.length > 1) {
      hasDuplicates = true;
      console.log(`\n重复的 message: ${key}`);
      console.log(`  出现在以下 ${paths.length} 个文件中:`);
      paths.forEach((p) => console.log(`    - ${p}`));
    }
  }

  if (!hasDuplicates) {
    console.log("✓ 未发现重复的 message.id\n");
  }

  console.log("\n=== 统计信息 ===");
  console.log(`总共扫描到 ${messageIds.size} 个不同的 message`);
  console.log(`总共扫描到 ${configEntityIds.size} 个不同的 config`);

  if (hasDuplicates) {
    console.log("\n⚠️  发现重复数据！这会导致 bootstrap_primary 失败。");
    console.log("请检查并清理重复的文件。");
  } else {
    console.log("\n✓ 没有发现重复数据，问题可能在其他地方。");
  }
})();
