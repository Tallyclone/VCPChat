# VChatSyncAdapter 中文说明

`VChatSyncAdapter` 是运行在 VCPChat 桌面端的同步适配插件，负责扫描/监听本机 `VCPChat/AppData`，把聊天、配置、附件变化转换为结构化同步 operation 提交到 `VChatSyncCenter`，并把中心事件安全投影回本机 AppData。

> 设计边界：Adapter 不是中心数据库，也不会把 `history.json` 当文件镜像同步。它只从稳定落盘后的 AppData 推导 message-level/entity-level operation，并将中心事件 materialize 回 AppData，保证 VChat 和 DeepMemo 继续按原有本地文件结构工作。

## 角色定位

- 所属项目：`G:\VCP\VCPChat`
- 插件目录：`VCPDistributedServer/Plugin/VChatSyncAdapter`
- 插件类型：`service`
- 本地事实投影：`VCPChat/AppData`
- 中心服务：`VCPToolBox/Plugin/VChatSyncCenter`
- 可靠通道：REST API
- 低延迟通知：latest_seq WebSocket，可关闭，REST 轮询兜底

## 目录结构

```text
VChatSyncAdapter/
├── plugin-manifest.json       # VCPDistributedServer 插件声明
├── config.env                 # Adapter 独立运行配置
├── config/sync_profile.json   # runtime 配置同步字段白名单/黑名单
├── index.js                   # 配置解析、路由注册、扫描/队列/拉取/watcher 启动
├── core/                      # 本地索引、身份键、hash、安全配置 DTO 等
├── scanner/                   # 启动全量扫描 AppData
├── watcher/                   # AppData 文件监听、稳定读取
├── diff/                      # history/config/attachment 差异推导
├── projector/                 # 中心事件投影回 AppData
├── sync/                      # centerClient、offlineQueue、pullLoop、bootstrap、写入意图锁
├── utils/                     # 防抖、路径规则、日志等
└── test/                      # smoke tests
```

## 核心能力

1. **独立配置加载**

   - 优先读取插件目录下 `config.env`。
   - 配置优先级：`config.env` > 宿主 `pluginConfig` > 代码默认值。
   - `config/sync_profile.json` 会在启动时加载到 `config.syncProfileConfig`，并传递给扫描、监听、拉取投影和 bootstrap manifest。

2. **启动全量扫描**

   - 启动后调用 `scanAppData()` 扫描 `AppData`，补齐插件离线期间发生的变化。
   - 扫描结果写入 `AppData/sync/state.json`。

3. **watcher-first 变化捕获**

   - watcher 监听 AppData 文件变化。
   - 同步前经过 debounce、稳定读取、JSON parse 校验和 diff 推导。
   - 只产生 message-level/entity-level operation，不产生 `history.json` 文件级 JSON Patch。

4. **本地索引与离线队列**

   - `local_index.json` 记录消息/文件 checksum、server version、last applied seq、pending 状态。
   - `offline_queue.jsonl` 持久化待提交 operation。
   - 队列、索引和 `state.json` 的写入使用 tmp + 校验 + 原地 rename 覆盖：目标文件在替换过程中不会出现"短暂缺失"，rename 失败时保留原文件。启动或读取时若发现旧版本残留的 `*.tmp-*` 文件，会合并/采用其中较新的内容并清理。
   - 读取 `state.json` 时，文件缺失或被临时占用属于 I/O 状况，不会被当作损坏；只有 JSON 无法解析才进入 `recovering`。
   - 每次新编辑生成独立 operation ID；重试沿用持久化 ID。同一消息按顺序提交，只合并尚未发送的尾部操作，连续编辑和恢复旧内容都能同步。
   - 中心缺少 update 目标时，队列会持久化补建 create；已删除的消息或父项返回删除优先结果，结束对应重试。
   - 中心已存在同 ID 但内容不同的消息（`MESSAGE_CREATE_CONFLICT`，HTTP 409）时，create 会以新 operation ID 转成基于中心版本的 update，不再无限重试。
   - 中心返回的其它永久拒绝（4xx 校验错误）重试 3 次后写入 `offline_queue.rejected.jsonl` 死信文件并释放对应实体；网络与 5xx 错误按指数退避持续重试。
   - 消息提交前会核对父话题：本地 `pending` 标记若对应的操作既不在队列也未确认，标记会被清除并向中心查询；话题存在则直接确认，不存在则从 `config.topics[]` 重新生成话题 upsert。远端话题事件投影成功时也会确认本地话题快照。
   - 尚未发送的 delete 遇到同一消息被恢复/编辑时会被撤回；已发送过的 delete 保持在后续编辑之前提交。

5. **中心客户端**

   - `sync/centerClient.js` 调用中心 REST API。
   - 支持设备注册、提交 operation、拉取 changes、上传/下载附件、主题 `/themes` 与 `/themes/assets`、bootstrap import/export。
   - 中心 REST 请求携带 `Authorization: Bearer <VCHAT_SYNC_KEY>`，依次经过 VCPToolBox 宿主全局鉴权和 Center 插件鉴权。Adapter、Center 的 `VCHAT_SYNC_KEY` 必须与宿主全局 `Key` 保持一致，无须修改宿主 `server.js`。
   - 可选 WebSocket 只做 latest_seq 通知；关闭后仍可靠 REST 轮询。

6. **远端事件投影**

   - `pullLoop` 从中心按 `after_seq` 拉取事件。
   - `projector` 按 topic 聚合并投影消息、配置、附件事件。
   - 写回使用临时文件、校验、备份、原子替换，并通过 `writeIntentLock` 防回环上传。
   - 本地尚未提交（队列中或尚未被 watcher 观察到）的消息编辑不会被远端版本覆盖；远端版本号记入索引，随后的本地 update 以该版本为 base 提交，中心最终收敛到本地内容。
   - 附件先下载再读取 `history.json`，写回前校验文件内容未被宿主改动，若宿主期间保存过则重新读取合并，不会丢失新消息。
   - 拉取响应携带中心 `generation`，写入 `state.json`。中心恢复旧备份后 generation 会变化，Adapter 检测到后进入 `recovering` 并停止拉取，需重新执行 `join_existing` 或 `merge_existing` 重建基线，避免跳过被复用的序号。

7. **安全配置 DTO**

   - 配置同步按 `profile` 分为 `bootstrap` 与 `runtime`。
   - `bootstrap` profile 表示首次导入/导出的完整安全基线。
   - Center 的 `/bootstrap/export` 会同时导出 `bootstrap` 与 `runtime` 两类 profile 配置，避免新设备 join_existing 后因游标直接前移而跳过历史 runtime 配置。
   - Center 保存累计 runtime 投影及删除字段，新设备可恢复多次局部更新后的完整同步状态。
   - `runtime` 必须携带 `projection_fields`，接收端只修改声明字段。
   - runtime 字段删除通过 `deleted_fields` 显式表达，接收端只删除其中声明的字段。
   - DTO 会递归校验，禁止安全投影中出现未声明字段。

8. **主题路径与身份保持**

   - 主题包保留中心 `theme_id`，并从 `manifest.css` 读取原 CSS 文件信息。有效的原路径会还原到 `styles/themes/*.css`；未提供有效路径时使用该目录内的备用文件名，后续编辑仍沿用同一主题身份。
   - 主题投影与扫描按应用目录串行执行，共用 CSS 相对路径对应的本地内容基线。中心写回的 CSS、随后下载的壁纸以及重复文件事件不会再次上传为新主题。
   - 本地编辑 CSS 或壁纸会继续上传；将 CSS 改回旧内容也属于一次新修改。下载壁纸期间发生的本地 CSS 编辑不会被当作中心写回而忽略。
   - 主题包直接通过 `/themes` 提交。每次新修改生成新的 operation ID，并将待提交 ID 与内容 checksum 保存在本地索引；请求失败或响应丢失后，同一次修改重试时沿用该 ID。

推荐直接维护：

```text
G:\VCP\VCPChat\VCPDistributedServer\Plugin\VChatSyncAdapter\config.env
```

| 配置项                                       | 示例/默认              | 说明                                                                                                      |
| -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `VCHAT_ADAPTER_ENABLED`                      | `true`                 | 是否启用 Adapter；false 时只注册管理路由，不启动扫描/监听/拉取                                            |
| `VCHAT_ADAPTER_MODE`                         | `uninitialized`        | 当前同步模式；首次部署建议保持未初始化再通过 bootstrap API 初始化                                         |
| `VCHAT_APPDATA_PATH`                         | `../AppData`           | VChat AppData 路径；相对路径基于 VCPDistributedServer 根目录解析                                          |
| `VCHAT_SYNC_CENTER_URL`                      | `http://<host>:<port>` | 中心宿主地址；可只写到端口，Adapter 自动补全 `/api/plugins/VChatSyncCenter`；兼容完整 API 前缀            |
| `VCHAT_SYNC_WS_URL`                          | 可留空                 | 可选 latest_seq WebSocket 地址；留空时由 Center URL 推导，可只写到端口并自动补全 `/vchat-sync/latest-seq` |
| `VCHAT_SYNC_KEY`                             | 自定义                 | 必须与中心侧 `VCHAT_SYNC_KEY` 及 VCPToolBox 宿主全局 `Key` 一致；生产环境请使用高强度随机字符串           |
| `VCHAT_DEVICE_ID`                            | 可留空自动生成         | 设备唯一 ID；每台设备必须不同                                                                             |
| `VCHAT_DEVICE_NAME`                          | 可留空取 hostname      | 设备显示名                                                                                                |
| `VCHAT_WATCH_DEBOUNCE_MS`                    | `700`                  | 文件监听防抖时间                                                                                          |
| `VCHAT_QUEUE_INTERVAL_MS`                    | `5000`                 | 离线队列冲刷周期                                                                                          |
| `VCHAT_PULL_INTERVAL_MS`                     | `15000`                | REST 拉取中心 changes 的轮询周期                                                                          |
| `VCHAT_ATTACHMENT_MULTIPART_THRESHOLD_BYTES` | `8388608`              | 附件 multipart 上传阈值，默认 8MB                                                                         |
| `VCHAT_SYNC_ENABLE_WS`                       | `true`                 | 是否启用 latest_seq WebSocket 通知                                                                        |
| `VCHAT_BOOTSTRAP_MODE`                       | `manual`               | 启动时自动 bootstrap 策略：`manual` / `bootstrap_primary` / `join_existing` / `merge_existing`            |
| `VCHAT_RELEASE_MODE`                         | `mvp-local-only`       | 发布/能力分层标记                                                                                         |
| `DebugMode`                                  | `false`                | 调试日志开关                                                                                              |

> 注意：`plugin-manifest.json` 中 `configSchema` 当前必须保持字符串类型声明，例如 `"boolean"`、`"integer"`、`"string"`，不要改成 VCPToolBox 的 `{ type, default }` 对象格式。

## Runtime 配置同步：config/sync_profile.json

`sync_profile.json` 控制运行时配置同步哪些字段。默认文件结构：

```json
{
  "version": 1,
  "runtimeSync": {
    "agent_config": {
      "include": [],
      "exclude": [],
      "deleteMissing": false
    },
    "group_config": {
      "include": [],
      "exclude": [],
      "deleteMissing": false
    }
  },
  "bootstrap": {
    "conflictPolicy": "report_only"
  }
}
```

### Agent runtime 默认同步字段

默认只同步较安全的运行时字段：

```text
name
topics
advancedSystemPrompt.hiddenBlocks
advancedSystemPrompt.warehouseOrder
advancedSystemPrompt.viewMode
presetSystemPrompt
selectedPreset
```

### Agent runtime include 可扩展

可以通过 `runtimeSync.agent_config.include` 额外同步 bootstrap allowlist 中的字段，例如：

```json
{
  "runtimeSync": {
    "agent_config": {
      "include": ["systemPrompt", "model", "temperature", "customCss"],
      "exclude": [],
      "deleteMissing": false
    }
  }
}
```

Center 不再对 agent/group runtime 字段设置额外黑名单；最终仍会校验 `projection_fields` 只能使用 Center bootstrap allowlist 内字段、`deleted_fields` 必须落在 `projection_fields` 内、`safe_projection_json` 不能包含敏感 key，且 DTO 实际字段必须落在 `projection_fields` 内。客户端侧请谨慎配置 include/exclude，默认仍只同步上面的安全运行时字段。

### 旧设备缺字段兼容

`deleteMissing` 默认是 `false`。如果旧设备没有某个字段，即使该字段在 include 里，也不会把它写入 `projection_fields`，因此不会导致另一台设备误删该字段。

如果你确实希望传播字段删除，可以显式开启。Adapter 会把缺失字段写入 `deleted_fields`，Center 校验后转发，接收端只删除 `deleted_fields` 中声明的字段：

```json
{
  "runtimeSync": {
    "agent_config": {
      "include": ["systemPrompt"],
      "deleteMissing": true
    }
  }
}
```

请谨慎使用 `deleteMissing: true`，建议只在所有设备版本一致且确认需要传播删除语义时开启。未进入 `deleted_fields` 的缺失字段不会被接收端删除。

## 支持的配置路径

Adapter 会识别以下配置文件：

```text
Agents/{agentId}/config.json
Agents/{agentId}/regex_rules.json
AgentGroups/{groupId}/config.json
global_prompt_warehouse.json
systemPromptPresets/**/*.json
UserData/memo.config.json
UserData/forum.config.json
settings.json
```

其中 `systemPromptPresets/**/*.json` 支持多层目录，例如：

```text
systemPromptPresets/分类/子分类/preset.json
```

## 本地管理 API

所有接口都需要同步密钥鉴权：

```http
Authorization: Bearer <VCHAT_SYNC_KEY>
```

或：

```http
x-vchat-sync-key: <VCHAT_SYNC_KEY>
```

接口列表：

```text
GET  /api/vchat-sync-adapter/status
POST /api/vchat-sync-adapter/bootstrap/bootstrap_primary
POST /api/vchat-sync-adapter/bootstrap/join_existing
POST /api/vchat-sync-adapter/bootstrap/merge_existing
POST /api/vchat-sync-adapter/bootstrap/agent
GET  /api/vchat-sync-adapter/bootstrap/manifest
GET  /api/vchat-sync-adapter/bootstrap/conflicts
```

## 同步流程概览

1. 读取 `config.env` 和 `config/sync_profile.json`。
2. 初始化 `AppData/sync/` 状态文件。
3. 首次通过 `bootstrap_primary`、`join_existing` 或 `merge_existing` 建立基线。
4. 启动全量扫描，补齐离线期间本地变化。
5. watcher 捕获 history/config/attachment/theme 变化并推导 operation。
6. 消息与配置 operation 进入 offline queue，网络恢复后提交中心；主题包直接提交到 `/themes`，失败重试使用本地索引保存的待提交 ID。
7. pullLoop 按 `last_applied_seq` 拉取中心事件。
8. projector 将消息与配置 JSON 原子写回 AppData，通过 write intent 防回环；主题写入 `styles/themes/*.css` 与 `assets/wallpaper/*`，通过共享内容基线与串行扫描/投影防回环。

## 与 VChatSyncCenter 的关系

中心插件位于 VCPToolBox 项目中，访问前缀通常为：

```text
http://<VCPToolBox主机>:<端口>/api/plugins/VChatSyncCenter
```

Adapter 调用中心接口完成：

- `POST /devices/register`：注册设备。
- `POST /operations`：提交本地 operation。
- `GET /changes`：按 seq 拉取中心事件。
- `POST /attachments`、`GET /attachments/:hash`：上传/下载附件。
- `POST /themes`、`GET /themes`：主题包上传/查询；主题包是本地 `styles/themes/*.css` 等主题定义的中心事实来源。
- `POST /themes/assets`、`GET /themes/assets/:hash`：上传/下载主题壁纸/资源；Adapter 会把它们投影回 `assets/wallpaper/*`。
- `/bootstrap/import`、`/bootstrap/export`：初始化或合并基线；Center 导出的配置基线包含 `bootstrap` 与 `runtime` 两类 profile，同时也会携带主题 manifest/asset 元数据。

基线导出按不可变主键分页，客户端应原样传回不透明 `next_cursor`，不能将其当成 OFFSET。Adapter 保留首批 `baseline_seq`，在所有页面收集完成后回放导出期间的完整变更区间，再进入 active 模式并推进游标。分页期间的新增、删除和排序变化不会使未变更记录漏页；导出的消息会在本地恢复显示顺序。

Adapter 先收齐导出期间的事件，再写入本地基线。文件投影开始前会持久化 `bootstrapping` 状态；投影中断时保持暂停并保留备份路径，重新执行 `join_existing` 或 `merge_existing` 完成初始化后才恢复普通同步。

## 安全与数据原则

- 不上传 API Key、token、Cookie、密码、本机路径等敏感字段。
- 不上传 `isThinking === true`、`id === loading_history` 或纯 UI placeholder/status 消息。
- 不能简单过滤所有 `role=system` 消息，只能过滤确认是本地 UI 状态的消息。
- 消息身份使用 `item_type + item_id + topic_id + message_id` 复合键，不能只依赖 `message.id`。
- Runtime 配置同步必须使用 `projection_fields`，未声明字段不会被改动。
- 字段删除必须显式写入 `deleted_fields`；仅缺失或仅声明字段都不会删除接收端内容。
- 远端投影写回必须防回环，避免 watcher 再次上传同步写入。
- `uninitialized` 等禁止上传模式下，本地变化不能入队提交。

## 快速联调建议

1. 先在 VCPToolBox 启用 `VChatSyncCenter`，确认中心 `/status` 正常。
2. 修改本插件 `config.env`：
   - `VCHAT_SYNC_CENTER_URL` 指向中心插件挂载前缀。
   - `VCHAT_SYNC_KEY` 与中心侧及 VCPToolBox 宿主全局 `Key` 保持一致。
   - 每台设备使用唯一 `VCHAT_DEVICE_ID`。
3. 首次部署保持：
   - `VCHAT_ADAPTER_MODE=uninitialized`
   - `VCHAT_BOOTSTRAP_MODE=manual`
4. 第一台设备通常执行 `bootstrap_primary`。
5. 后续设备通常执行 `join_existing`；双边已有数据时才考虑 `merge_existing`。
6. 检查 `GET /api/vchat-sync-adapter/status` 中 mode、queue、pull、index 状态。
7. 再观察 AppData 变更是否提交到中心并在其他端投影回来。

## 维护注意点

- `config/sync_profile.json` 修改后需要重启 Adapter 才能稳定生效。
- 多台设备必须使用不同 `VCHAT_DEVICE_ID`。
- 不要让两个 Adapter 实例同时操作同一个 AppData。
- `merge_existing` 前建议备份本机 `AppData` 和中心数据库。
- `writeIntentLock` 在多实例共享同一 AppData 时存在竞态风险，建议单机单实例运行。
- `bootstrap_primary` 会先把导入会话 ID 持久化到 `state.json`，响应丢失后重试会复用该 ID，中心返回已完成的导入结果而不是拒绝。
- 头像每次内容变化都使用新的 operation ID，待确认的 ID 保存在本地索引中供重试复用；A→B→A 的切换会完整同步。
- 话题多次拖动排序推导出的 move 序列会先在本地模拟重放，保证中心重放结果与本地顺序一致。
- 状态接口 `queue.rejected_path` 指向死信文件；里面的操作需要人工确认后重新编辑对应内容以产生新的 operation。
