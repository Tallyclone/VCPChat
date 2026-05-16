# VChatSyncAdapter 中文说明

`VChatSyncAdapter` 是部署在 `VCPChat/VCPDistributedServer/Plugin/VChatSyncAdapter` 下的桌面端同步适配插件。它负责把当前桌面端 `VCPChat/AppData` 的文件变化转换为结构化同步 operation，并把 `VChatSyncCenter` 的中心事件安全投影回本机 AppData，从而保持 VChat 主界面和 DeepMemo 对原有本地文件结构的兼容。

> 设计边界：Adapter 不是中心数据库，也不把 `history.json` 当文件镜像同步。它只从稳定落盘后的 AppData 推导 message-level/entity-level operation，并把中心事件 materialize 回 AppData。

## 角色定位

- 所属项目：`G:\VCP\VCPChat`
- 插件目录：`VCPDistributedServer/Plugin/VChatSyncAdapter`
- 插件类型：`service`
- 本地事实投影：`VCPChat/AppData`
- 中心服务：`VCPToolBox/Plugin/VChatSyncCenter`
- 可靠同步通道：REST API
- 低延迟通知：latest_seq WebSocket，可关闭，REST 轮询兜底

## 当前代码结构

```text
VChatSyncAdapter/
├── plugin-manifest.json       # VCPDistributedServer 插件声明，configSchema 为字符串类型声明
├── config.env                 # Adapter 独立配置文件，优先级高于宿主 pluginConfig
├── index.js                   # 配置解析、路由注册、启动扫描/队列/拉取/watcher、关闭逻辑
├── core/                      # 本地索引、身份键、hash、安全配置 DTO 等核心能力
├── scanner/                   # 启动全量扫描 AppData
├── watcher/                   # AppData 文件监听、稳定读取
├── diff/                      # history/config/attachment 差异推导
├── projector/                 # 将中心事件原子投影回 AppData
├── sync/                      # centerClient、offlineQueue、pullLoop、bootstrap、写入意图锁等
├── utils/                     # 防抖、路径规则、日志等工具
└── test/                      # 插件测试
```

## 核心能力

1. **独立配置加载**

   - `index.js` 会优先读取插件目录下的 `config.env`。
   - 配置优先级为：`config.env` > 宿主 `pluginConfig` > 代码内默认值。
   - 这是当前代码事实，后续不要改回只依赖宿主注入。

2. **启动全量扫描**

   - 插件启动后调用 `scanAppData()` 全量扫描 `AppData`。
   - 用于补齐插件未运行期间发生的本地变更。
   - 扫描结果写入 `AppData/sync/state.json`。

3. **watcher-first 变化捕获**

   - 运行中通过 watcher 监听 AppData 文件变化。
   - watcher 只作为触发器，实际同步前必须经过 debounce、稳定读取、JSON parse 校验和 diff 推导。
   - 只能产生 message-level/entity-level operation，禁止产生 `history.json` JSON Patch。

4. **本地索引与离线队列**

   - `local_index.json` 记录消息/文件的已知 checksum、server version、last applied seq 和 pending 状态。
   - `offline_queue.jsonl` 持久化待提交 operation。
   - 当前 `offlineQueue.js` 已采用 tmp + 校验 + rename 的原子写入模式，并带 Windows move 重试。

5. **中心客户端**

   - `sync/centerClient.js` 使用 `axios` 调用中心 REST API。
   - 支持设备注册、提交 operation、拉取 changes、上传/下载附件、bootstrap import/export。
   - 可选通过 `ws` 连接 latest_seq WebSocket；即使关闭，也会使用 REST 轮询兜底。

6. **远端事件投影**

   - `pullLoop` 从中心按 `after_seq` 拉取事件。
   - `projector` 按 topic 聚合，将消息/配置/附件事件投影回 AppData。
   - 写回应走临时文件、校验、备份、原子替换，并通过 `writeIntentLock` 防止 watcher 把同步写回再次上传。

7. **Bootstrap 管理接口**
   - 插件本地注册：
     - `GET /api/vchat-sync-adapter/status`
     - `POST /api/vchat-sync-adapter/bootstrap/:mode`
     - `GET /api/vchat-sync-adapter/bootstrap/manifest`
     - `GET /api/vchat-sync-adapter/bootstrap/conflicts`
   - 这些接口复用 `VCHAT_SYNC_KEY` 鉴权，支持 `Authorization: Bearer`、`x-vchat-sync-key`、`x-vchat-bootstrap-key`。

## 关键配置

推荐直接维护插件目录下的 `config.env`。

| 配置项                                       | 当前示例/默认                                                  | 说明                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `VCHAT_ADAPTER_ENABLED`                      | `true`                                                         | 是否启用 Adapter；false 时只注册管理路由，不启动扫描/监听/拉取                                 |
| `VCHAT_ADAPTER_MODE`                         | `uninitialized`                                                | 当前同步模式；首次部署建议保持未初始化再通过 bootstrap API 初始化                              |
| `VCHAT_APPDATA_PATH`                         | `../AppData`                                                   | VChat AppData 路径；相对路径基于 VCPDistributedServer 根目录解析                               |
| `VCHAT_SYNC_CENTER_URL`                      | 示例为 `http://100.100.50.10:6005/api/plugins/VChatSyncCenter` | VCPToolBox 中心插件 API 前缀                                                                   |
| `VCHAT_SYNC_KEY`                             | 示例值                                                         | 必须与中心侧 `VCHAT_SYNC_KEY` 一致，生产环境请使用高强度随机字符串                             |
| `VCHAT_DEVICE_ID`                            | 可留空自动生成                                                 | 设备唯一 ID，默认 `hostname-username` 并做安全字符替换                                         |
| `VCHAT_DEVICE_NAME`                          | 可留空取 hostname                                              | 设备显示名                                                                                     |
| `VCHAT_WATCH_DEBOUNCE_MS`                    | `700`                                                          | 文件监听防抖时间                                                                               |
| `VCHAT_QUEUE_INTERVAL_MS`                    | `5000`                                                         | 离线队列冲刷周期                                                                               |
| `VCHAT_PULL_INTERVAL_MS`                     | `15000`                                                        | REST 拉取中心 changes 的轮询周期                                                               |
| `VCHAT_ATTACHMENT_MULTIPART_THRESHOLD_BYTES` | `8388608`                                                      | 附件 multipart 上传阈值，默认 8MB                                                              |
| `VCHAT_SYNC_ENABLE_WS`                       | `true`                                                         | 是否启用 latest_seq WebSocket 通知                                                             |
| `VCHAT_BOOTSTRAP_MODE`                       | `manual`                                                       | 启动时自动 bootstrap 策略：`manual` / `bootstrap_primary` / `join_existing` / `merge_existing` |
| `VCHAT_RELEASE_MODE`                         | `mvp-local-only`                                               | 发布/能力分层标记                                                                              |
| `DebugMode`                                  | `false`                                                        | 调试日志开关                                                                                   |

注意：`plugin-manifest.json` 中的 `configSchema` 当前必须保持字符串类型声明，例如 `"boolean"`、`"integer"`、`"string"`。VCPDistributedServer 的 PluginManager 当前依赖这种格式，不要改成 VCPToolBox 那种 `{ type, default }` 对象格式。

## 本地管理 API

所有本地管理接口都需要同步密钥鉴权：

```http
Authorization: Bearer <VCHAT_SYNC_KEY>
```

或：

```http
x-vchat-sync-key: <VCHAT_SYNC_KEY>
x-vchat-bootstrap-key: <VCHAT_SYNC_KEY>
```

接口列表：

```text
GET  /api/vchat-sync-adapter/status
POST /api/vchat-sync-adapter/bootstrap/bootstrap_primary
POST /api/vchat-sync-adapter/bootstrap/join_existing
POST /api/vchat-sync-adapter/bootstrap/merge_existing
GET  /api/vchat-sync-adapter/bootstrap/manifest
GET  /api/vchat-sync-adapter/bootstrap/conflicts
```

## 同步流程概览

1. **初始化配置**：读取 `config.env`，解析 AppData 路径、中心 URL、设备 ID、同步密钥等。
2. **准备状态目录**：在 `AppData/sync/` 下维护 `state.json`、`local_index.json`、`offline_queue.jsonl`、`write_intents.jsonl` 等文件。
3. **Bootstrap**：首次接入时通过 `bootstrap_primary`、`join_existing` 或 `merge_existing` 建立本地与中心的基线关系。
4. **启动扫描**：全量扫描 AppData，推导插件关闭期间发生的变化。
5. **监听变化**：watcher 捕获 history/config/attachment 变化，稳定读取后推导 operation。
6. **离线提交**：operation 进入 offline queue，网络恢复或中心可用后重试提交。
7. **拉取中心事件**：按 `last_applied_seq` 调用中心 `/changes` 补拉事件。
8. **原子投影**：把远端事件写回本机 AppData，并用 write intent 防止回环上传。

## AppData 与同步状态

Adapter 默认使用：

```text
VCPChat/AppData/
├── Agents/{agentId}/config.json
├── AgentGroups/{groupId}/config.json
├── UserData/{itemId}/topics/{topicId}/history.json
└── sync/
    ├── state.json
    ├── local_index.json
    ├── offline_queue.jsonl
    └── write_intents.jsonl
```

其中 `history.json` 是 VChat 和 DeepMemo 继续读取的本地投影文件，不是同步协议里的文件级事实源。

## 与 VChatSyncCenter 的关系

`VChatSyncCenter` 位于 VCPToolBox 项目中，是中心事实源。Adapter 通过 `VCHAT_SYNC_CENTER_URL` 访问它，例如：

```text
http://<VCPToolBox主机>:<端口>/api/plugins/VChatSyncCenter
```

Adapter 调用中心接口完成：

- `POST /devices/register`：注册设备。
- `POST /operations`：提交本地推导的 operation。
- `GET /changes`：按 seq 拉取中心事件。
- `POST /attachments`、`GET /attachments/:hash`：上传/下载附件。
- `/bootstrap/import`、`/bootstrap/export`：初始化或合并基线。

## 安全与数据原则

- 不上传 `isThinking === true`、`id === loading_history` 或纯 UI placeholder/status 消息。
- 不能简单过滤所有 `role=system` 消息，只有确认是本地 UI 状态消息才过滤。
- 消息身份必须使用 `item_type + item_id + topic_id + message_id` 复合键，不能只依赖 `message.id`。
- 本机路径、API Key、token、Cookie、密码等敏感字段不得进入中心同步。
- 远端投影写回必须防回环，避免 watcher 再次把同步写入当成本地编辑上传。
- `uninitialized` 等禁止上传的模式下，观察到的本地变化不能入队提交。

## 快速联调建议

1. 先在 VCPToolBox 启用 `VChatSyncCenter`，确认中心 `/status` 正常。
2. 修改本插件 `config.env`：
   - `VCHAT_SYNC_CENTER_URL` 指向中心插件挂载前缀。
   - `VCHAT_SYNC_KEY` 与中心侧保持一致。
   - 每台设备使用唯一 `VCHAT_DEVICE_ID`。
3. 首次部署保持 `VCHAT_ADAPTER_MODE=uninitialized`、`VCHAT_BOOTSTRAP_MODE=manual`。
4. 调用本地 bootstrap API 完成初始化：
   - 第一台设备通常使用 `bootstrap_primary`。
   - 后续设备按实际情况使用 `join_existing` 或 `merge_existing`。
5. 确认 `GET /api/vchat-sync-adapter/status` 中 mode、queue、pull、index 状态正常。
6. 再观察 AppData 变更是否能提交到中心，并在其他端投影回来。

## 已知工程注意点

根据同步功能 Review，当前实现整体遵守核心架构约束，但后续维护要特别注意：

- `pullLoop` 若遇到永久不可投影事件，需要有告警或死信处理策略，避免同步卡死。
- `historyDiffEngine` 应避免把异常截断/清空的历史误判为大批量删除。
- `localIndex` 在大批量事件下可能存在写放大，后续可继续做批量保存或 SQLite 化优化。
- `writeIntentLock` 在多 Adapter 实例共享同一 AppData 时存在竞态风险，建议保持单机单实例运行。
