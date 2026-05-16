# VChatSyncAdapter 使用说明（通俗版）

这份文档讲怎么使用 `VChatSyncAdapter`。它是装在 VCPChat 桌面端里的“同步助手”：负责看着本机 `AppData`，把聊天、配置、附件变化提交到同步中心，也负责把其他设备的变化写回本机 `AppData`。

## 一句话理解

- `VChatSyncAdapter` 放在 **VCPChat** 里运行。
- 它连接 VCPToolBox 里的 `VChatSyncCenter`。
- 它会扫描和监听本机 `VCPChat/AppData`。
- 它不会把 `history.json` 当文件镜像同步，而是推导消息级变更。
- 同步回来的内容会写回本机 AppData，所以 VChat 和 DeepMemo 还能按老方式读取。

## 你需要先准备什么

1. VCPToolBox 上已经启用了 `VChatSyncCenter`。
2. 你知道中心地址，例如：

```text
http://100.100.50.10:6005/api/plugins/VChatSyncCenter
```

3. 你知道中心同步密钥，例如：

```text
你的同步密钥
```

4. 本插件目录存在：

```text
G:\VCP\VCPChat\VCPDistributedServer\Plugin\VChatSyncAdapter
```

## 最重要的配置文件

Adapter 优先读取自己目录里的：

```text
G:\VCP\VCPChat\VCPDistributedServer\Plugin\VChatSyncAdapter\config.env
```

优先级是：

```text
config.env > 宿主 pluginConfig > 代码默认值
```

所以普通使用时，直接改 `config.env` 最清楚。

## 第 1 步：配置 config.env

打开：

```text
G:\VCP\VCPChat\VCPDistributedServer\Plugin\VChatSyncAdapter\config.env
```

推荐先按下面方式配置：

```env
VCHAT_ADAPTER_ENABLED=true
VCHAT_ADAPTER_MODE=uninitialized
VCHAT_APPDATA_PATH=../AppData

VCHAT_SYNC_CENTER_URL=http://100.100.50.10:6005/api/plugins/VChatSyncCenter
VCHAT_SYNC_KEY=你的同步密钥

VCHAT_DEVICE_ID=pc-home
VCHAT_DEVICE_NAME=家里的电脑

VCHAT_WATCH_DEBOUNCE_MS=700
VCHAT_QUEUE_INTERVAL_MS=5000
VCHAT_PULL_INTERVAL_MS=15000
VCHAT_ATTACHMENT_MULTIPART_THRESHOLD_BYTES=8388608
VCHAT_SYNC_ENABLE_WS=true
VCHAT_BOOTSTRAP_MODE=manual
VCHAT_RELEASE_MODE=mvp-local-only
DebugMode=false
```

必须改的项：

| 配置项 | 怎么填 |
| --- | --- |
| `VCHAT_SYNC_CENTER_URL` | 填 VCPToolBox 上中心插件的 API 前缀 |
| `VCHAT_SYNC_KEY` | 必须和中心侧完全一致 |
| `VCHAT_DEVICE_ID` | 每台设备必须唯一，例如 `pc-home`、`pc-office` |
| `VCHAT_DEVICE_NAME` | 给自己看的设备名，例如 `家里的电脑` |

首次接入建议：

```env
VCHAT_ADAPTER_MODE=uninitialized
VCHAT_BOOTSTRAP_MODE=manual
```

这样不会一启动就自动导入或合并，比较安全。

## 第 2 步：重启 VCPChat / VCPDistributedServer

修改 `config.env` 后，重启 VCPChat 或它的 VCPDistributedServer，让插件重新读取配置。

启动后，Adapter 会注册本地管理接口。

本地接口前缀通常是：

```text
http://127.0.0.1:<VCPChat或VCPDistributedServer端口>/api/vchat-sync-adapter
```

下面用变量表示：

```powershell
$Adapter = "http://127.0.0.1:你的端口/api/vchat-sync-adapter"
$Key = "你的同步密钥"
$Headers = @{ Authorization = "Bearer $Key" }
```

> 端口取决于你本机 VCPChat/VCPDistributedServer 实际监听端口。请用项目当前启动日志或配置确认。

## 第 3 步：检查 Adapter 状态

PowerShell：

```powershell
$Adapter = "http://127.0.0.1:你的端口/api/vchat-sync-adapter"
$Key = "你的同步密钥"
$Headers = @{ Authorization = "Bearer $Key" }

Invoke-RestMethod -Uri "$Adapter/status" -Headers $Headers -Method Get
```

重点看这些字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 接口是否正常 |
| `enabled` | Adapter 是否启用 |
| `mode` | 当前同步模式 |
| `app_data_path` | 实际读取的 AppData 路径 |
| `sync_dir` | 同步状态目录 |
| `device_id` | 当前设备 ID |
| `queue` | 离线队列状态 |
| `pull` | 拉取中心事件状态 |
| `index` | 本地索引状态 |

如果 `mode` 还是 `uninitialized`，说明还没有完成首次接入。

## 第 4 步：选择首次接入方式

首次接入有三种常用模式。

### 模式 A：bootstrap_primary

适合：第一台电脑，同步中心（vcptoolbox中心数据库）还是空的，你想把这台电脑当前 AppData 作为初始数据。

命令：

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/bootstrap_primary" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

通俗理解：

```text
把我这台电脑现有聊天数据作为第一份中心数据。
```

建议：执行前先备份本机 `AppData`，并确认中心是新库或空库。

### 模式 B：join_existing

适合：第二台或第三台电脑，中心已经有数据，你希望这台电脑加入同步。

命令：

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/join_existing" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

通俗理解：

```text
中心已经有数据了，我这台电脑加入，并把中心数据拉到本机。
```

### 模式 C：merge_existing

适合：这台电脑本地也有一些数据，中心也有数据，需要尝试合并。

命令：

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/merge_existing" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

通俗理解：

```text
我本机有数据，中心也有数据，尽量合并到一起。
```

建议：这是最容易出现冲突的模式。执行前务必备份本机 `AppData` 和中心数据库。

## 第 5 步：Bootstrap 后再次检查状态

执行 bootstrap 后，再看状态：

```powershell
Invoke-RestMethod -Uri "$Adapter/status" -Headers $Headers -Method Get
```

如果模式已经不再是 `uninitialized`，并且 queue/pull 没有明显错误，就可以正常使用。

## 日常同步是怎么发生的

配置好以后，日常不用手动点同步。流程是：

1. 你在 VChat 里聊天、编辑、删除消息，或者改配置。
2. AppData 文件变化。
3. Adapter 监听到变化。
4. Adapter 等文件稳定后读取。
5. Adapter 推导出“新增消息 / 修改消息 / 删除消息 / 配置变化”等 operation。
6. operation 进入 `offline_queue.jsonl`。
7. 网络正常时提交给 VChatSyncCenter。
8. 其他设备从中心拉到变化。
9. 其他设备的 Adapter 把变化写回自己的 AppData。
10. 其他设备的 VChat 和 DeepMemo 就能读到这些内容。

## 常用命令

### 1. 查看状态

```powershell
Invoke-RestMethod -Uri "$Adapter/status" -Headers $Headers -Method Get
```

最常用。出问题先看这个。

### 2. 查看本机 manifest

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/manifest" -Headers $Headers -Method Get
```

用途：

- 查看 Adapter 扫描到的本机数据概况。
- 首次接入前检查本机 AppData 是否能被识别。

### 3. 扫描 normalized_id 冲突

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/conflicts" -Headers $Headers -Method Get
```

用途：

- 检查本机 Agent/Group 等 ID 是否存在潜在冲突。
- 在 merge 前尤其建议先看。

### 4. 第一台电脑初始化中心

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/bootstrap_primary" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

### 5. 新电脑加入中心

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/join_existing" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

### 6. 本机和中心合并

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/merge_existing" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

## 同步状态文件在哪里

Adapter 会在 AppData 下维护同步状态：

```text
VCPChat/AppData/sync/
├── state.json             # 当前模式、游标、最近扫描结果等
├── local_index.json       # 本地消息/文件索引
├── offline_queue.jsonl    # 离线待提交队列
└── write_intents.jsonl    # 防回环写入意图记录
```

一般不需要手动改这些文件。

如果同步异常，可以先备份这些文件，再排查。不要随便删除，尤其是 `offline_queue.jsonl`，里面可能有未提交操作。

## 两台电脑同步的推荐步骤

### 第一台电脑

1. 配好中心 `VChatSyncCenter`。
2. 第一台电脑配置 `config.env`：

```env
VCHAT_DEVICE_ID=pc-home
VCHAT_DEVICE_NAME=家里的电脑
VCHAT_ADAPTER_MODE=uninitialized
VCHAT_BOOTSTRAP_MODE=manual
```

3. 重启 VCPChat。
4. 检查状态：

```powershell
Invoke-RestMethod -Uri "$Adapter/status" -Headers $Headers -Method Get
```

5. 执行：

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/bootstrap_primary" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

### 第二台电脑

1. 第二台电脑配置 `config.env`：

```env
VCHAT_DEVICE_ID=pc-office
VCHAT_DEVICE_NAME=办公室电脑
VCHAT_ADAPTER_MODE=uninitialized
VCHAT_BOOTSTRAP_MODE=manual
```

2. `VCHAT_SYNC_CENTER_URL` 和 `VCHAT_SYNC_KEY` 与第一台一致。
3. 重启 VCPChat。
4. 执行：

```powershell
Invoke-RestMethod -Uri "$Adapter/bootstrap/join_existing" -Headers $Headers -Method Post -ContentType "application/json" -Body "{}"
```

5. 检查状态正常后，在任意一台电脑聊天，观察另一台是否同步。

## 和中心插件的联调命令

如果 Adapter 状态不正常，可以同时检查中心。

```powershell
$Center = "http://100.100.50.10:6005/api/plugins/VChatSyncCenter"
Invoke-RestMethod -Uri "$Center/status" -Headers $Headers -Method Get
```

看中心 `latest_seq` 是否增长：

```powershell
Invoke-RestMethod -Uri "$Center/changes?after_seq=0&limit=20" -Headers $Headers -Method Get
```

如果中心有变更，但本机不更新，重点查 Adapter 的 `pull` 状态。

如果本机有变化，但中心没有变更，重点查 Adapter 的 `queue` 状态和中心地址/密钥。

## 常见问题

### 1. 401 / adapter bootstrap authorization failed

同步密钥不对。

检查：

- `config.env` 的 `VCHAT_SYNC_KEY`。
- 命令里的 `$Key`。
- 中心侧 `VCHAT_SYNC_KEY`。

三处必须完全一致。

### 2. status 显示 enabled=false

检查：

```env
VCHAT_ADAPTER_ENABLED=true
```

然后重启 VCPChat。

### 3. mode 一直是 uninitialized

说明还没完成 bootstrap。按你的场景执行：

- 第一台：`bootstrap_primary`
- 新加入：`join_existing`
- 双方都有数据：`merge_existing`

### 4. 本机改了聊天，但中心没变化

检查：

- `VCHAT_SYNC_CENTER_URL` 是否写对。
- `VCHAT_SYNC_KEY` 是否一致。
- `/status` 里的 queue 是否堆积。
- 当前 mode 是否允许上传。

`uninitialized` 模式下不会上传本机变更。

### 5. 另一台电脑没有收到变化

检查：

- 中心 `/changes` 是否能看到新事件。
- 另一台 Adapter 的 `/status` 里 pull 是否正常。
- 另一台 `VCHAT_DEVICE_ID` 是否与第一台重复。设备 ID 不要重复。

### 6. WebSocket 报错怎么办

不用慌。WebSocket 只是加速通知，REST 轮询仍会同步。可以先设置：

```env
VCHAT_SYNC_ENABLE_WS=false
```

重启后靠轮询同步。

## 安全提醒

- 首次 bootstrap 前先备份 `VCPChat/AppData`。
- `merge_existing` 前一定备份，因为它最容易产生冲突。
- 不要手动编辑 `AppData/sync/offline_queue.jsonl`，里面可能有待提交数据。
- 不要让两套 Adapter 同时操作同一个 AppData 目录。
- 每台设备必须使用不同的 `VCHAT_DEVICE_ID`。
- 不要把 API Key、token、Cookie、密码等敏感内容放进要同步的配置里。
