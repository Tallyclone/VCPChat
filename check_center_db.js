const Database = require("better-sqlite3");
const path = require("path");

const dbPath = "X:\\VCP\\VCPToolBox\\Plugin\\VChatSyncCenter\\data\\vchat_data.db";

try {
  const db = new Database(dbPath, { readonly: true });

  console.log("检查 VChatSyncCenter 数据库状态...\n");

  const tables = [
    "messages",
    "items",
    "topics",
    "config_entities",
    "attachments",
    "theme_packages",
    "change_log",
  ];

  let isEmpty = true;

  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      const count = row.count;
      if (count > 0) {
        isEmpty = false;
        console.log(`❌ ${table}: ${count} 条记录`);
      } else {
        console.log(`✓ ${table}: 0 条记录`);
      }
    } catch (e) {
      console.log(`[警告] 无法查询 ${table}: ${e.message}`);
    }
  }

  // 特别检查 change_log 中的 operation_id
  try {
    const changeLogRows = db
      .prepare(
        `SELECT operation_id, COUNT(*) as count FROM change_log GROUP BY operation_id HAVING count > 1`
      )
      .all();
    if (changeLogRows.length > 0) {
      console.log("\n⚠️  发现 change_log 中有重复的 operation_id:");
      changeLogRows.forEach((row) => {
        console.log(`  ${row.operation_id}: ${row.count} 次`);
      });
    }

    const allChangeLogs = db.prepare(`SELECT operation_id FROM change_log LIMIT 10`).all();
    if (allChangeLogs.length > 0) {
      console.log("\n前10条 change_log 的 operation_id:");
      allChangeLogs.forEach((row) => {
        console.log(`  - ${row.operation_id}`);
      });
    }
  } catch (e) {
    console.log(`\n[警告] 无法检查 change_log: ${e.message}`);
  }

  db.close();

  console.log("\n========================================");
  if (isEmpty) {
    console.log("✓ 数据库是空的，可以执行 bootstrap_primary");
  } else {
    console.log("❌ 数据库不是空的，bootstrap_primary 会被拒绝");
    console.log("解决方案：删除数据库文件后重启 VCPToolBox");
  }
  console.log("========================================");
} catch (e) {
  console.error("错误:", e.message);
}
