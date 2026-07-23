# E3 Chat 内置应用 — 维护、更新与 BUG 排查索引文档

> 核查日期：2026-07-16  
> 代码根目录：`E:\VCPChat`  
> 基准文档：`E:\E3_Chat_VCPdesktop_内置应用落地实现文档.md`（2026-07-14 版）  
> 核查方式：逐文件源码 + 实际 grep 比对，非推测

---

## 目录

1. [文件清单与实际状态](#1-文件清单与实际状态)
2. [架构层次速查](#2-架构层次速查)
3. [既有文件接入点速查](#3-既有文件接入点速查)
4. [IPC 通道完整列表](#4-ipc-通道完整列表)
5. [核心模块职责与关键函数索引](#5-核心模块职责与关键函数索引)
6. [数据流与事件传播路径](#6-数据流与事件传播路径)
7. [渲染管线 10 阶段速查](#7-渲染管线-10-阶段速查)
8. [已知边界情况与易出 BUG 热点](#8-已知边界情况与易出-bug-热点)
9. [BUG 排查路由表](#9-bug-排查路由表)
10. [安全红线速查](#10-安全红线速查)
11. [更新维护操作指引](#11-更新维护操作指引)
12. [与原始设计文档的偏差记录](#12-与原始设计文档的偏差记录)
13. [诊断命令速查](#13-诊断命令速查)

---

## 1. 文件清单与实际状态

### 1.1 新增文件（主进程端 `modules/e3chat/`）

| 文件                          | 字节   | 核查状态           | 职责简述                                                                   |
| ----------------------------- | ------ | ------------------ | -------------------------------------------------------------------------- |
| `e3ChatWindow.js`             | 1747   | ✅                 | 创建/聚焦 E3 Chat BrowserWindow                                            |
| `e3ChatIpcHandlers.js`        | 3097   | ✅                 | 注册所有 `e3chat:*` IPC，调用者鉴权                                        |
| `e3ChatService.js`            | 10874  | ✅                 | 核心服务协调器，组合所有子模块                                             |
| `e3BackendDiscovery.js`       | 3454   | ✅                 | 发现 E3 后端（进程/手动/last-known）                                       |
| `e3SignalRClient.js`          | 5283   | ✅                 | 基于 `ws` 的 SignalR JSON 协议客户端                                       |
| `e3EventNormalizer.js`        | 5241   | ✅                 | Hub 事件规范化为统一 E3NormalizedEvent                                     |
| `e3WorkspaceCoordinator.js`   | 752    | ✅                 | 维护 connectionGeneration 与 workspace 上下文                              |
| `e3SessionRepository.js`      | 991    | ✅                 | List/Load/Rename 会话的 Hub invoke 封装                                    |
| `e3SessionSyncService.js`     | 796    | ✅                 | 刷新会话列表并推断 workspaceIdentity                                       |
| `e3ProtocolDiagnostics.js`    | 873    | ✅                 | 环形诊断缓冲区（500 条），含脱敏                                           |
| `e3LocalStateStore.js`        | 1329   | ✅                 | 本地 JSON 状态持久化（AppData/E3Chat）                                     |
| **`e3ViewportBridge.js`**     | 4450   | ⚠️ **文档未列出**  | E3 原生 3D 视口桥接（draw_objects 等 RPC）                                 |
| **`e3HistoryCoordinator.js`** | ~1020+ | ✅ 2026-07-20 新增 | 会话历史编辑/删除/再生成事务管理、stale-reference 检测、per-session 串行化 |

### 1.2 新增文件（渲染器端 `Desktopmodules/e3chat/`）

| 文件                          | 字节  | 核查状态           | 职责简述                                                                       |
| ----------------------------- | ----- | ------------------ | ------------------------------------------------------------------------------ |
| `e3chat.html`                 | —     | ✅                 | 入口 HTML，保留侧栏新建会话入口，并在输入区新增上传/新建会话 SVG 按钮          |
| `e3chat.js`                   | —     | ✅                 | 主控制器（事件路由、发送、文件选择、图片粘贴）                                 |
| `e3chat.css`                  | —     | ✅                 | 全部样式，含附件及图片缩略预览                                                 |
| `workspaceSessionSidebar.js`  | 6574  | ✅                 | 会话列表渲染、历史恢复、会话切换                                               |
| `messageStreamRenderer.js`    | 7247  | ✅                 | 流式消息渲染协调器（generation 过滤）                                          |
| `e3ChatSettingsPanel.js`      | 413   | ✅                 | 连接状态/workspace 显示                                                        |
| `e3DiagnosticsPanel.js`       | 323   | ✅                 | 诊断日志面板                                                                   |
| **`animationProcessor.js`**   | 11995 | ⚠️ **文档未列出**  | anime.js/Three.js 安全执行、CDN→ 本地重写                                      |
| `blocks/messageBlock.js`      | 33833 | ✅                 | 消息块渲染（Markdown + 10 阶段管线）                                           |
| `blocks/thinkingBlock.js`     | 990   | ✅                 | 思考块（默认折叠）                                                             |
| `blocks/toolCard.js`          | 3466  | ✅                 | E3 原生工具卡                                                                  |
| `blocks/questionCard.js`      | 2210  | ✅                 | AskUserQuestion 卡片                                                           |
| `blocks/errorBlock.js`        | 336   | ✅                 | 错误块                                                                         |
| **`e3MessageContextMenu.js`** | ~800+ | ✅ 2026-07-20 新增 | 右键菜单组件（复制/编辑/删除/再生成/中止），挂载 `window.E3MessageContextMenu` |

### 1.3 Preload

| 文件                 | 字节 | 核查状态                                                                                                                |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `preloads/e3chat.js` | —    | ✅ 通过 `contextBridge.exposeInMainWorld("e3chat", ...)` 暴露窄 API（含文件选择/粘贴保存/编辑消息/删除消息/再生成消息） |

### 1.4 已修改的既有文件

| 文件                                         | 修改行号   | 修改内容                                                                   |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| `main.js`                                    | L64        | `const e3ChatIpcHandlers = require("./modules/e3chat/e3ChatIpcHandlers");` |
| `main.js`                                    | L1148      | `e3ChatIpcHandlers.initialize({ projectRoot: PROJECT_ROOT });`             |
| `modules/ipc/desktopHandlers.js`             | L1466-1469 | `if (appAction === "open-e3-chat-window")` 分支                            |
| `Desktopmodules/builtinWidgets/vchatApps.js` | L320-327   | `vchat-app-e3-chat` 应用条目                                               |

### 1.5 Vendor 依赖（全部本地，不需 CDN）

全部 12 个 vendor 文件均已确认存在于 `E:\VCPChat\vendor\`：

| 文件                 | 大小  | 用途                                   |
| -------------------- | ----- | -------------------------------------- |
| `marked.min.js`      | 42KB  | Markdown 解析                          |
| `highlight.min.js`   | 123KB | 代码高亮                               |
| `katex.min.js`       | 277KB | LaTeX 公式渲染                         |
| `auto-render.min.js` | 3.5KB | KaTeX 自动渲染                         |
| `katex.min.css`      | 23KB  | KaTeX 样式                             |
| `mermaid.min.js`     | 2.7MB | 图表渲染                               |
| `morphdom.min.js`    | 12KB  | DOM diff（预留，尚未在流式渲染中使用） |
| `anime.min.js`       | 17KB  | 动画库                                 |
| `html2canvas.min.js` | 199KB | HTML→Canvas 截图（预留）               |
| `three.min.js`       | 670KB | 3D 渲染                                |
| `three.module.js`    | 1.3MB | Three.js ES module                     |
| `purify.min.js`      | 21KB  | DOMPurify HTML 净化                    |

---

## 2. 架构层次速查

```
VCPdesktop Dock
  ↓ click "E3 Chat"
  ↓ appAction = "open-e3-chat-window"
vchatApps.js → desktopHandlers.js → e3ChatWindow.js
  ↓ creates BrowserWindow (contextIsolation: true, nodeIntegration: false)
  ↓ preload: preloads/e3chat.js → exposes window.e3chat
  ↓ loads: Desktopmodules/e3chat/e3chat.html

main.js → e3ChatIpcHandlers.js → E3ChatService
  ├─ e3BackendDiscovery     (发现 E3 后端)
  ├─ e3SignalRClient         (WebSocket SignalR 客户端)
  ├─ e3WorkspaceCoordinator  (generation 管理)
  ├─ e3SessionRepository     (会话 CRUD Hub invoke)
  ├─ e3SessionSyncService    (会话列表同步+workspace推断)
  ├─ e3EventNormalizer       (Hub事件→标准事件)
  ├─ e3ProtocolDiagnostics   (脱敏日志)
  ├─ e3LocalStateStore       (本地JSON持久化)
  ├─ e3ViewportBridge        (E3原生3D视口RPC)
  └─ e3HistoryCoordinator    (会话历史编辑/删除/再生成事务)

Renderer (e3chat.html)
  ├─ e3chat.js               (主控制器)
  ├─ e3MessageContextMenu.js (右键菜单：复制/编辑/删除/再生成/中止)
  ├─ messageStreamRenderer.js (流式渲染协调)
  ├─ workspaceSessionSidebar.js (会话侧栏)
  ├─ e3ChatSettingsPanel.js  (连接状态)
  ├─ e3DiagnosticsPanel.js   (诊断面板)
  ├─ animationProcessor.js   (动画安全执行)
  └─ blocks/
      ├─ messageBlock.js     (消息块+Markdown管线)
      ├─ thinkingBlock.js    (思考折叠块)
      ├─ toolCard.js         (E3工具卡)
      ├─ questionCard.js     (问答卡)
      └─ errorBlock.js       (错误块)
```

---

## 3. 既有文件接入点速查

### 3.1 `main.js`

| 行号      | 内容                                                          | 维护注意                                                         |
| --------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| **L64**   | `require("./modules/e3chat/e3ChatIpcHandlers")`               | 修改路径需同步                                                   |
| **L1148** | `e3ChatIpcHandlers.initialize({ projectRoot: PROJECT_ROOT })` | 在既有桌面 IPC 初始化之后；传入 `projectRoot` 供本地状态存储使用 |

**注意**：文档设计为传递 `{ openChildWindows }`，但实际实现传递 `{ projectRoot: PROJECT_ROOT }`。`openChildWindows` 改为在 `desktopHandlers.js` 的调用链中传递。

### 3.2 `desktopHandlers.js` (L1466-1469)

```js
if (appAction === "open-e3-chat-window") {
  const e3ChatWindow = require("../e3chat/e3ChatWindow");
  await e3ChatWindow.openE3ChatWindow({ openChildWindows });
  return { success: true };
}
```

**维护注意**：此分支位于 `desktop-launch-vchat-app` handler 内部，须置于通用 appId 解析之前。

### 3.3 `vchatApps.js` (L320-327)

```js
{
  id: "vchat-app-e3-chat",
  name: "E3 Chat",
  // ...
  description: "打开 E3 原生聊天内置窗口",
  appAction: "open-e3-chat-window",
}
```

**维护注意**：`description` 文本与文档略有不同（文档为"连接 E3 后端的工作空间同步聊天窗口"，实际为"打开 E3 原生聊天内置窗口"）。不影响功能。

---

## 4. IPC 通道完整列表

| 通道                        | 方向          | Handler 位置              | 功能                                                                     |
| --------------------------- | ------------- | ------------------------- | ------------------------------------------------------------------------ |
| `e3chat:register-window`    | Renderer→Main | `e3ChatIpcHandlers.js:62` | 窗口注册（sender 鉴权入口）                                              |
| `e3chat:get-status`         | Renderer→Main | `e3ChatIpcHandlers.js:73` | 获取连接状态                                                             |
| `e3chat:connect`            | Renderer→Main | `e3ChatIpcHandlers.js:74` | 连接 E3 后端                                                             |
| `e3chat:disconnect`         | Renderer→Main | `e3ChatIpcHandlers.js:77` | 断开连接                                                                 |
| `e3chat:refresh-workspace`  | Renderer→Main | `e3ChatIpcHandlers.js:78` | 刷新工作空间                                                             |
| `e3chat:list-sessions`      | Renderer→Main | `e3ChatIpcHandlers.js:79` | 列出会话                                                                 |
| `e3chat:load-session`       | Renderer→Main | `e3ChatIpcHandlers.js:80` | 加载会话历史                                                             |
| `e3chat:rename-session`     | Renderer→Main | `e3ChatIpcHandlers.js`    | 重命名会话                                                               |
| `e3chat:select-files`       | Renderer→Main | `e3ChatIpcHandlers.js`    | 打开文件选择器并复用 VChat fileManager 保存/提取                         |
| `e3chat:store-pasted-file`  | Renderer→Main | `e3ChatIpcHandlers.js`    | 保存从剪贴板粘贴的图片/文件（上限 25MB）                                 |
| `e3chat:send-message`       | Renderer→Main | `e3ChatIpcHandlers.js`    | 发送消息及附件元数据                                                     |
| `e3chat:cancel`             | Renderer→Main | `e3ChatIpcHandlers.js`    | 取消当前聊天                                                             |
| `e3chat:answer-question`    | Renderer→Main | `e3ChatIpcHandlers.js:94` | 回答问题                                                                 |
| `e3chat:get-diagnostics`    | Renderer→Main | `e3ChatIpcHandlers.js:97` | 获取诊断日志                                                             |
| `e3chat:get-local-state`    | Renderer→Main | `e3ChatIpcHandlers.js:98` | 读取本地状态                                                             |
| `e3chat:save-local-state`   | Renderer→Main | `e3ChatIpcHandlers.js:99` | 保存本地状态                                                             |
| `e3chat:edit-message`       | Renderer→Main | `e3ChatIpcHandlers.js`    | 编辑消息（JSONL 重写 + index.json 更新）⚠️ 2026-07-20 新增               |
| `e3chat:delete-message`     | Renderer→Main | `e3ChatIpcHandlers.js`    | 删除消息（JSONL 重写 + index.json 更新）⚠️ 2026-07-20 新增               |
| `e3chat:regenerate-message` | Renderer→Main | `e3ChatIpcHandlers.js`    | 再生成（截断历史 → LoadChatSession → SendChatMessage）⚠️ 2026-07-20 新增 |
| `e3chat:event`              | Main→Renderer | `e3ChatIpcHandlers.js:58` | 推送规范化事件                                                           |

**鉴权机制**：`assertE3Sender()` 验证 `event.sender.id === win.webContents.id` 且在 `allowedWebContents` Set 中。`register-window` 时将 sender.id 加入 Set，sender destroyed 时自动移除。

---

## 5. 核心模块职责与关键函数索引

### 5.1 `e3ChatService.js` — 核心服务协调器

| 方法                                                    | 行号    | 说明                                                                                                                                              |
| ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor()`                                         | 80      | 组合所有子模块（discovery、signalr、workspace、session、diagnostics、localState、**viewport**）                                                   |
| `connect(options)`                                      | 117     | 发现后端 → 创建 SignalR 客户端 → 绑定事件 → 握手 →**注册 draw_objects/clear/view_capture 远程 RPC**→ 同步会话 → 发射 connected 事件               |
| `bindClient(client)`                                    | 172     | 监听 `hub-event`→`normalizeHubEvent`→`emitEvent`；监听 `connection` 状态变化                                                                      |
| `disconnect(mark)`                                      | 194     | 断开 WebSocket，清理客户端引用                                                                                                                    |
| `refreshWorkspace()`                                    | 206     | 刷新会话列表，检测 workspace 变化时重连                                                                                                           |
| `sendMessage(content, attachments, sessionId)`          | —       | **核心发送流程**：附件转为 `[附加文件]` 正文块 → LoadChatSession（如有 sessionId）→`SendChatMessage(messageContent, sessionId)`→ 重试检测新建会话 |
| `cancel()`                                              | 312     | `CancelChat()` invoke                                                                                                                             |
| `answerQuestion(requestId, payload)`                    | 326     | 验证 pending→`AnswerChatQuestion` invoke→ 移除 pending                                                                                            |
| `getLocalState(scope)` / `saveLocalState(scope, patch)` | 352/357 | 委托 e3LocalStateStore                                                                                                                            |
| `getDiagnostics()`                                      | 363     | 返回诊断列表                                                                                                                                      |

**⚠ 关键发现：`SendChatMessage` 的第二参数**

文档§9 写 `SendChatMessage(content, attachments ?? null)`，但实际源码（L260-266）为：

```js
const result = await this.client.invoke(
  "SendChatMessage",
  messageContent,
  requestedSessionId
);
```

第二参数是 **currentSessionId**，不是 attachments。传 `null` 会创建新会话。这是已确认的 E3 协议真实行为。附件会先通过 VChat 的 `fileManager` 保存和提取文本，再由 `buildMessageContent()` 合入第一参数，未改变 E3 Hub 调用签名。

### 5.2 `e3BackendDiscovery.js` — 后端发现

| 方法                       | 说明                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `discover(manualBaseUrl)`  | 按顺序：手动 URL → 进程命令行 → last-known-good                               |
| `discoverFromProcess()`    | PowerShell `Get-CimInstance Win32_Process` 查找 `esws.exe --urls`             |
| `validateBaseUrl(baseUrl)` | POST `/workspace-hub/negotiate?key=dev&negotiateVersion=1`，检查 200-499 响应 |
| `normalizeBaseUrl(value)`  | 限制 `localhost/127.0.0.1`，替换为 `127.0.0.1`                                |
| `remember(baseUrl)`        | 保存到 localState `global.lastKnownGoodBaseUrl`                               |

**⚠ 排查注意**：`hubKey` 硬编码为 `"dev"` (e3ChatService.js:129)。如果 E3 后端更换 key，需在此处修改。

### 5.3 `e3SignalRClient.js` — SignalR 客户端

| 方法                                          | 说明                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `negotiate()`                                 | POST 获取 connectionToken                                                                                        |
| `connect()`                                   | WebSocket 连接 + handshake `{"protocol":"json","version":1}\u001e`                                               |
| `handleMessage(data)`                         | 分帧解析：type=1(invocation/event) → 分发到 remoteHandlers 或 emit `hub-event`；type=3(completion)；type=6(ping) |
| `invoke(target, ...args)`                     | 发送带 invocationId 的调用并等待 completion，Promise 映射                                                        |
| `send(target, ...args)`                       | 发送无 invocationId 的命令型调用；用于 `CancelChat`，不等待服务端 completion                                     |
| `registerRemote(methodName, handler)`         | 注册服务端可调用的客户端方法                                                                                     |
| `sendCompletion(invocationId, result, error)` | 回复服务端 invocation                                                                                            |
| `disconnect()`                                | 关闭 WebSocket                                                                                                   |

**⚠ 注意**：type=7(close) **未实现**。如果 E3 服务端发送 close 帧，当前只会触发 WebSocket 的 `close` 事件。

### 5.4 `e3EventNormalizer.js` — 事件规范化

将 Hub 的 `(name, ...args)` 转换为统一的 `E3NormalizedEvent`：

| 输入事件            | 输出 type      | 关键字段                                  |
| ------------------- | -------------- | ----------------------------------------- |
| `chat-message`      | `message`      | `text`, `messageId`                       |
| `chat-thinking`     | `thinking`     | `text`, `messageId`                       |
| `chat-tool-call`    | `tool-call`    | `tool: {source, id, name, input, status}` |
| `chat-tool-result`  | `tool-result`  | `toolId, result, status, isError`         |
| `chat-done`         | `done`         | `usage, finishReason`                     |
| `chat-error`        | `error`        | `message, code`                           |
| `chat-ask-question` | `ask-question` | `requestId, questions[]`                  |
| 其它                | `diagnostic`   | `name, raw`                               |

每个事件自动附带 `workspaceIdentity`、`connectionGeneration`、`receivedAt`。

**⚠ isError 判断**：`rawIsError === true || "true" || 1 || event.success === false`。字符串 `"true"` 是 E3 的实际返回格式。

### 5.5 `e3WorkspaceCoordinator.js` — Generation 管理

- `nextGeneration(root)` → 自增 `connectionGeneration`，更新 identity/root/displayName
- `current()` → 返回当前上下文的浅拷贝

### 5.6 `e3ViewportBridge.js` — E3 原生视口桥接 ⚠️ 文档未涉及

处理 E3 服务端通过 SignalR 发起的 RPC 调用（`draw_objects`、`draw_objects_agent`、`clear`、`view_capture`）。创建隐藏的 BrowserWindow 加载 E3 原生 viewport HTML，通过 IPC 双向通信完成 3D 渲染操作。

### 5.7 `e3HistoryCoordinator.js` — 会话历史编辑/删除/再生成事务 ⚠️ 2026-07-20 新增

| 方法                                             | 说明                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `constructor(service, sessionsRoot)`             | 绑定 E3ChatService 引用和 JSONL/index.json 根目录                    |
| `editMessage({ sessionId, reference, newText })` | JSONL 重写 + index.json 更新，per-session 串行化                     |
| `deleteMessage({ sessionId, reference })`        | JSONL 过滤 + index.json 更新，reference 类型校验（不允许删 system）  |
| `regenerateMessage({ sessionId, reference })`    | 截断历史 → `LoadChatSession` → `SendChatMessage` → 返回流式事件      |
| `_withSessionLock(sessionId, fn)`                | per-session 串行化队列，防止并发 JSONL 写入                          |
| `_rewriteJSONL(sessionId, filterFn)`             | 原子 JSONL 重写（读取 → 过滤/变换 → 写入临时文件 → rename）          |
| `_updateIndex(sessionId, messages)`              | 根据重写后的消息更新 `index.json` 中的 `messageCount`/`lastModified` |
| `_resolveReference(messages, reference)`         | stale-reference 检测：按 `{ role, index }` 或 `{ id }` 定位消息      |

**⚠ 排查注意**：

- `sessionsRoot` 配置路径（`%AppData%/E3Chat/sessions/`）需在 IPC handler 初始化时正确传入
- JSONL 重写使用 rename 原子替换，崩溃时可能残留 `.tmp` 文件
- stale-reference（消息已被前序操作删除/移动）会抛出 `STALE_REFERENCE` 错误码

### 5.8 `e3MessageContextMenu.js` — 渲染器右键菜单组件 ⚠️ 2026-07-20 新增

挂载为 `window.E3MessageContextMenu`，通过 `#message-list` 的 `contextmenu` 事件委托触发。

| 方法                                  | 说明                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `init()`                              | 初始化菜单 DOM 容器 + 全局 click/Escape 监听，并给 composer 安装局部 `pointerdown` 焦点自愈                       |
| `show(event, block, { chatRunning })` | 读取 `block.__e3History` 元数据 → 构建菜单项 → 定位显示                                                           |
| `close()`                             | 关闭菜单（`messageStreamRenderer` 清除对话时自动调用）                                                            |
| 内联编辑                              | `.message-content` → `.e3-edit-textarea` → 保存/取消 → `api.editMessage()` → `loadSession` 刷新                   |
| 删除确认                              | 页面内模态确认 → 乐观移除同 reference 节点 → `api.deleteMessage()` → fingerprint 权威增量协调；匹配失败才完整重绘 |
| 焦点恢复                              | 确认关闭后同步 `prompt.focus()`，删除协调结束后再次聚焦并在下一帧验证                                             |
| Toast                                 | `showToast(msg, type)` — 自动消失的操作反馈（复制成功/失败等）                                                    |

**⚠ 数据依赖**：菜单项的可用性完全取决于 `block.__e3History` 中的 `canEdit`/`canDelete`/`canRegenerate`/`originalText`/`reference`/`sessionId` 字段。如果 `messageStreamRenderer.js` 未正确填充这些字段，菜单项将被禁用或不显示。

---

## 6. 数据流与事件传播路径

### 6.1 发送消息与附件

```
用户输入文字，或通过“上传文件”/输入框粘贴添加附件（最多 10 个）
  → 文件选择：e3chat:select-files；粘贴文件：e3chat:store-pasted-file（单文件上限 25MB）
  → e3ChatIpcHandlers → VChat fileManager.storeFile() 保存文件并提取文本
  → e3chat.js 显示文件名；图片使用 internalPath 的 file:// URL 显示缩略图
  → 点击 SVG 发送按钮或按 Enter（Shift+Enter 仅换行）
  → e3chat.js sendMessage() → 按钮切换为运行/取消 SVG 状态
  → appendUserMessage() 显示用户消息
  → IPC e3chat:send-message { content, attachments, sessionId }
  → e3ChatService.sendMessage()
    → buildMessageContent() 将附件路径/提取文本合入第一参数的 `[附加文件]` 块
    → [有sessionId] LoadChatSession(sessionId)
    → SendChatMessage(messageContent, sessionId|null) via SignalR
    → [新会话] 轮询 ListChatSessions 检测新增 sessionId (最多5次,间隔150ms递增)
  → 返回 { result, activeSessionId, sessions }
  → 更新 sidebar 选中会话
  → [chat-done/chat-error] 最终化当前助手消息；[断线] 按钮恢复发送 SVG 状态
  → [运行时点击按钮] 发送 CancelChat，最终化已生成内容后恢复发送 SVG 状态
```

`SendChatMessage` 的第二参数始终是 `sessionId`，附件不能占用该参数。发送失败时渲染层恢复输入文字和待发送附件；侧栏和输入区均保留新建会话入口，两个入口共用同一逻辑并清空待发送附件。输入区的上传附件、新建会话按钮以及侧栏新建会话按钮均使用 SVG 图标。

### 6.2 接收流式事件

```
E3 Hub → SignalR type=1 invocation
  → e3SignalRClient.handleMessage() → emit "hub-event"
  → e3ChatService.bindClient() 监听
  → normalizeHubEvent() 规范化
  → emitEvent() → emit "event"
  → e3ChatIpcHandlers → win.webContents.send("e3chat:event", payload)
  → preload onEvent listener
  → e3chat.js handleEvent()
    → [message]  → appendAssistantMessageText() → update(..., { streaming:true })
    → [thinking] → messageStreamRenderer.appendThinking()
    → [tool-call] → messageStreamRenderer.renderTool()
    → [tool-result] → messageStreamRenderer.finalizeToolResult()
    → [ask-question] → messageStreamRenderer.renderQuestion()
    → [done] → finalizeCurrentAssistant() + clearQuestion() + renderSessions()
    → [error] → finalizeCurrentAssistant() + showError("e3")
    → [invocation-error] → finalizeCurrentAssistant() + showError("invocation")
    → [connection] → setGeneration() + renderStatus() + renderSessions()
```

### 6.3 会话切换

```
点击侧栏会话 → loadSessionIntoView(sessionId)
  → IPC e3chat:load-session
  → SignalR LoadChatSession(sessionId)
  → 返回 messages[]
  → clearConversation() (不递增 generation!)
  → renderHistoryMessage() 逐条渲染
    → 按 block.type 分发：text/thinking/tool
```

### 6.4 Workspace 切换

```
refreshWorkspace() → IPC e3chat:refresh-workspace
  → e3ChatService.refreshWorkspace()
    → syncService.refresh() → ListChatSessions
    → 检测 workspace root 变化
    → [变化] → disconnect → connect(baseUrl) → 重建连接
    → [不变] → 返回最新 sessions
  → renderer setGeneration(新值, {clear:true})
  → 旧 generation 事件被过滤
```

---

## 7. 渲染管线 10 阶段速查

`messageBlock.js → renderMarkdown(text)` 的完整处理管线：

| 阶段 | 名称               | 关键逻辑                                               | BUG 排查关键点                     |
| ---- | ------------------ | ------------------------------------------------------ | ---------------------------------- |
| 0    | 原始 HTML 保留     | 不再将 `<!DOCTYPE html>` 自动包成代码围栏              | 实时与历史 HTML 共用同一入口       |
| 1    | 代码围栏保护       | 状态机提取代码块 → 占位符 `%%E3_CODEFENCE_N%%`         | 未闭合围栏也会被保护（流式安全）   |
| 2    | LaTeX 保护         | `$$...$$`、`\[...\]`、`\(...\)` → 占位符               | 代码块内的 `$` 不会误触            |
| 3    | HTML 行去缩进      | 4+ 空格开头的 HTML 标签去除缩进                        | 防止 Markdown 将 HTML 当代码块     |
| 4    | Scoped CSS 提取    | `<style>` 标签提取，作用域化注入 `<head>`              | `cleanupScopedStyles()` 负责清理   |
| 4.5  | Script 占位符      | `<script>` → 隐藏 `span[data-e3-script-id]`            | 吞掉独占行缩进，绕过 anti-mXSS     |
| 5    | LaTeX 占位符去缩进 | 防止 LaTeX 占位符被当代码块                            | —                                  |
| 5.5  | 相邻粗体边界规范化 | `**文本****文本**` 间插入 `<!-- -->`                   | 修复中文引号粗体渲染               |
| 6    | 恢复代码围栏       | 占位符 → 原始代码块                                    | —                                  |
| 7    | Markdown/HTML 分流 | HTML 主导片段绕过 `marked`，其余调用 `marked.parse()`  | 流式半截 HTML 不生成 `<pre><code>` |
| 8    | 恢复 LaTeX         | 占位符 →`escapeHtml(原始)`                             | 先转义再交给 KaTeX                 |
| 9    | DOMPurify 净化     | 允许内部脚本占位属性，脚本本体已提前提取               | —                                  |
| 9.5  | 恢复 Script        | 隐藏 span 占位符 → 原始 `<script>`                     | 防御性清理泄漏占位符               |
| 10   | Scoped CSS 注入    | 选择器按稳定 `.message-block` ID 前缀化并注入 `<head>` | 更新/清空前清理旧 style            |

**流式/最终态分工**：流式帧使用 `update(..., { streaming:true })`，只做内容转换并跳过缓存与 `enhanceContent`；`done`、取消、`error`、`invocation-error` 调用 `finalizeCurrentAssistant()`，以相同原文执行最终完整渲染。

**后处理** (`enhanceContent` 7 阶段)：

| 阶段 | 功能                | 依赖                                        |
| ---- | ------------------- | ------------------------------------------- |
| 1    | KaTeX 渲染          | `renderMathInElement`、`auto-render.min.js` |
| 2    | 代码高亮            | `hljs.highlightElement`                     |
| 3    | 代码复制按钮        | 原生 `navigator.clipboard`                  |
| 4    | Mermaid 图表        | `mermaid.render()` + 交互式查看器           |
| 5    | 外部链接            | `electronAPI.sendOpenExternalLink`          |
| 6    | 图片预览 + 表情修复 | `fixEmoticonUrlSmart()` Levenshtein 匹配    |
| 7    | 动画脚本执行        | `E3AnimationProcessor.processScripts()`     |

**渲染缓存**：LRU 策略，200 条上限，5MB 容量上限，256B-256KB 文本范围，FNV-1a 哈希。

**懒增强**：`IntersectionObserver`（rootMargin: 200px），非可见区域消息延迟后处理。

---

## 8. 已知边界情况与易出 BUG 热点

### 8.1 关键已知问题

| ID          | 问题                                   | 根因                                                                                                                                                                    | 影响范围                | 修复状态                                                                                                                                                   |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BUG-001** | 会话切换后流式消息不显示               | `loadSessionIntoView` 递增了 generation，导致后续当前连接事件被 generation 过滤丢弃                                                                                     | 所有消息类事件          | ✅ 已修复：切换会话只 `clearConversation()`，不递增 generation                                                                                             |
| **BUG-002** | 流式文本为空/只显示切换后的历史        | `normalizeHubEvent` 只取对象参数，忽略了纯字符串位置参数                                                                                                                | chat-message/thinking   | ✅ 已修复：normalizer 同时兼容对象、JSON 字符串和位置参数                                                                                                  |
| **BUG-003** | 新消息创建新会话而非复用当前会话       | `SendChatMessage` 第二参数是 sessionId 不是 attachments                                                                                                                 | 每条消息都创建新会话    | ✅ 已修复：传入 `requestedSessionId`                                                                                                                       |
| **BUG-004** | 首次发送后会话列表不显示新会话         | invocation completion 早于 ListChatSessions 可见                                                                                                                        | 新建会话场景            | ✅ 已修复：有限重试（5 次, 150ms 递增间隔）+ beforeSessions 差集检测                                                                                       |
| **BUG-005** | `<script>` 占位符泄漏到代码窗口        | DOMPurify 会删除脚本；未知自定义占位标签可能被转义，且带 4 空格缩进的隐藏 `span` 会被 marked 解析为 `<pre><code>`                                                       | 动画/Three.js 脚本      | ✅ 已修复：DOMPurify 前提取脚本；独占行替换时吞掉行首缩进；Phase 9.5 宽松恢复并防御性清理占位符                                                            |
| **BUG-006** | 中文粗体标记连续时渲染异常             | `**文本****文本**` marked 无法正确解析                                                                                                                                  | Markdown 渲染           | ✅ 已修复：Phase 5.5 插入 HTML 注释分隔符                                                                                                                  |
| **BUG-007** | 重启或切换会话后历史 HTML 不渲染       | 除旧版 `<!DOCTYPE html>` 自动围栏和 marked HTML 块边界外，旧缓存还在消息 scope wrapper 创建前保存 HTML；缓存命中会跳过 scoped CSS 注入并用无 scope DOM 覆盖首次正确渲染 | 历史 Markdown/HTML/动画 | ✅ 已修复：保留 HTML 主导片段绕过 marked；缓存仅保存去除 `<style>` 后的纯 raw HTML；CSS 每次按稳定消息容器 ID 重新 scope 和注入；历史与实时共用 `update()` |
| **BUG-008** | 流式期间临时出现代码窗口，完成后恢复   | 每个增量帧都按最终态运行 `marked` 和重型增强；未闭合 HTML 在流式中间态可能被解释为缩进代码块                                                                            | 流式 HTML/动画          | ✅ 已修复：对齐 VChat 的流式/最终态分工；HTML 主导片段流式绕过 marked，流式帧跳过重型增强，done/取消/error 时统一最终化                                    |
| **BUG-009** | 删除/再生成报 `Invalid E3 sessionId`   | `decorateLoadedSession()` 生成的 `__e3History` 描述符缺少 `sessionId`，右键菜单向 IPC 传入 `undefined`                                                                  | 编辑/删除/再生成        | ✅ 已修复：历史描述符显式携带可信 `sessionId`，并补齐 `originalText`/`text` 供菜单复制、编辑和确认预览                                                     |
| **BUG-010** | 当前聊天右键仅复制，切换会话后才可编辑 | 实时消息块没有持久化历史引用；生成完成后只刷新侧栏，未把当前视图替换为带 `__e3History` 的权威历史                                                                       | 当前会话右键菜单        | ✅ 已修复：done 后重载当前已知会话；新会话在发送返回 sessionId 后补重载，避免误加载侧栏第一条历史会话                                                      |
| **BUG-011** | 编辑/删除成功后界面不立即刷新          | 菜单成功分支仅调用 preload `loadSession()`，返回值未进入渲染器                                                                                                          | 编辑/删除后的当前视图   | ✅ 已修复：编辑仍重载权威会话；删除改用后端 decorated session 按 fingerprint 增量刷新 reference，无法完整匹配时才分段重绘                                  |
| **BUG-012** | 删除后输入框约 40 秒无光标、无法输入   | 同步 `window.confirm()` 关闭后 Chromium 文本编辑焦点异常，单次 rAF 聚焦又可能被后续整会话重绘覆盖；打开/取消附件对话框后的直接 focus 会暂时自愈                         | 删除消息后的 composer   | ✅ 已修复：页面内确认弹层替代 `window.confirm()`；确认关闭/删除协调完成双阶段聚焦；composer 局部 pointerdown 自愈；删除默认不再 clear+rebuild              |
| **BUG-013** | 聊天内容无法选择，复制选中项不出现     | `html, body` 全局 `user-select: none` 继承到消息区；右键菜单又要求选区两端都位于当前消息块，无法支持跨消息选区                                                          | 聊天区选择与右键复制    | ✅ 已修复：`#message-list` 对应 `.message-list` 显式恢复 `user-select: text`；菜单打开前缓存聊天区选区，并允许跨消息复制选中文字                           |

### 8.2 高风险热点区域

| 区域                                        | 风险                                                                                           | 监控要点                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `mergeStreamText()`                         | E3 可能发送增量/快照混合模式                                                                   | 检查是否出现文本重复或丢失                               |
| `pendingQuestions` Set                      | 如果 requestId 不匹配，`answerQuestion` 会抛错                                                 | 确保 done/error 后不残留 pending question                |
| `hubKey: "dev"` 硬编码                      | 生产环境可能使用不同 key                                                                       | 如果连接失败先检查此处                                   |
| `IntersectionObserver` 懒增强               | 快速滚动可能导致消息未增强                                                                     | rootMargin 200px 是安全边距                              |
| `renderCache` FNV-1a 碰撞                   | 极低概率但理论上可能                                                                           | 相同哈希返回错误缓存 HTML                                |
| Scoped CSS 生命周期                         | scope 绑定稳定的 `.message-block` ID；更新前按消息删除旧 style，会话清空再全局兜底             | 检查 `style[data-e3-scope]` 是否与消息 ID 一一对应       |
| Three.js/anime.js 内存泄漏                  | `update()` 与 `clearConversation()` 都会在 DOM 移除前调用 `cleanupAnimations()`                | 检查流式更新和会话切换后是否残留 canvas/动画             |
| JSONL 重写并发（2026-07-20 新增）           | `_withSessionLock` per-session 串行化；跨 session 可并发但同 session 必须串行                  | 高频编辑/删除操作是否导致 JSONL 损坏                     |
| stale-reference 竞态（2026-07-20 新增）     | 用户快速连续编辑/删除不同消息，前序操作可能使后续 reference 失效                               | `STALE_REFERENCE` 错误是否正确上报给渲染层               |
| `__e3History` 元数据填充（2026-07-20 新增） | `messageStreamRenderer` 需在 load-session 时正确填充 canEdit/canDelete/canRegenerate/reference | 缺失字段导致菜单项不显示                                 |
| 菜单与编辑器状态残留（2026-07-20 新增）     | 会话切换/`clearConversation` 时 `E3MessageContextMenu.close()` 是否被调用                      | 旧会话的编辑器/菜单是否残留到新会话                      |
| 删除增量协调（2026-07-21 新增）             | 按 `reference.fingerprint` 保留未变 DOM、刷新 `__e3History`；缺失/新增描述符时回退分段完整重绘 | 删除后 reference 正确、滚动/动画不闪烁、无 detached node |
| composer 焦点生命周期（2026-07-21 新增）    | 页面内确认关闭和权威协调结束后均聚焦；仅 composer 非按钮区域启用 pointerdown 自愈              | 删除后立即可点击输入且不抢占附件/发送/内联编辑焦点       |

---

## 9. BUG 排查路由表

### 症状 → 排查路径

| 症状                           | 第一步检查                                                       | 第二步检查                                                         | 第三步检查                                                     |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Dock 看不到 E3 Chat**        | `vchatApps.js` L320 是否存在                                     | `desktopHandlers.js` L1466 分支是否存在                            | `main.js` L64/L1148 初始化是否正常                             |
| **窗口打不开/白屏**            | `e3ChatWindow.js` loadFile 路径                                  | DevTools 控制台错误                                                | preload 路径 `preloads/e3chat.js`                              |
| **"未连接"状态不变**           | E3 是否在运行（检查 `esws.exe` 进程）                            | `e3BackendDiscovery.js` 发现逻辑                                   | 诊断面板查看具体错误                                           |
| **连接失败**                   | negotiate 返回状态码（检查 diagnostics）                         | hubKey 是否匹配                                                    | E3 端口是否正确                                                |
| **消息发送无响应**             | SignalR `connected` 状态                                         | `SendChatMessage` invocation 是否返回                              | diagnostics 中是否有 invocation error                          |
| **流式文本为空**               | `e3EventNormalizer.js` → 检查 args 格式                          | `messageStreamRenderer.appendAssistantMessageText` generation 过滤 | E3 Hub 事件格式是否变化                                        |
| **切换会话后消息不显示**       | `loadSessionIntoView` 是否改变了 generation                      | `renderHistoryMessage` block.type 解析                             | `normalizeMessages` 返回值                                     |
| **工具卡不更新结果**           | `toolId` 是否匹配（`chat-tool-call.id` → `chat-tool-result.id`） | `finalizeToolResult` fallback 逻辑                                 | `lastRunningToolId` 是否被正确设置                             |
| **问题卡提交失败**             | `pendingQuestions` 是否包含该 requestId                          | `AnswerChatQuestion` invocation 错误                               | 网络/SignalR 连接状态                                          |
| **Markdown 渲染异常**          | 哪个阶段出错（代码围栏/LaTeX/Mermaid）                           | DOMPurify 是否删除了内容                                           | 检查 renderCache 是否返回了旧缓存                              |
| **流式期间出现代码窗口**       | `appendAssistantMessageText` 是否传入 `streaming:true`           | HTML 主导片段是否绕过 `marked`                                     | done/error/cancel 是否执行最终化                               |
| **KaTeX 公式不渲染**           | `vendor/katex.min.js` 是否加载                                   | `auto-render.min.js` 是否加载                                      | `$` 是否在代码块内被误触                                       |
| **Mermaid 图表报错**           | 智能字符替换（em dash → `--`、smart quotes → `"`）是否生效       | `mermaid.render()` 错误信息                                        | 异步/同步 API 兼容                                             |
| **动画不执行**                 | `animationProcessor.js` 是否加载                                 | CDN→ 本地 URL 重写是否正确                                         | DOMPurify script 占位符是否恢复                                |
| **表情包图片 404**             | `fixEmoticonUrlSmart()` 相似度阈值 0.6                           | `electronAPI.getEmoticonLibrary()` 是否可用                        | 相对路径 `../../` 是否正确                                     |
| **workspace 切换后数据串线**   | generation 是否递增                                              | 旧 generation 事件是否被过滤                                       | `refreshWorkspace()` 是否触发重连                              |
| **本地状态丢失**               | `AppData/E3Chat/local-state.json` 路径                           | `fs-extra` 写是否成功                                              | `loadAll()` 缓存是否过期                                       |
| **内存泄漏**                   | Three.js renderer 是否 dispose                                   | anime.js 实例是否清理                                              | scoped CSS `<style>` 是否清理                                  |
| **右键菜单不显示**（新增）     | `e3MessageContextMenu.js` 是否通过 `<script>` 加载               | `e3chat.js` `bindUi()` 是否初始化 `E3MessageContextMenu.init()`    | 右键目标是否为 `.message-block`                                |
| **菜单项缺失/全灰**（新增）    | `block.__e3History` 元数据是否填充                               | `canEdit`/`canDelete`/`canRegenerate` 值是否为 true                | 消息是否仍在 streaming 状态                                    |
| **编辑消息保存失败**（新增）   | `preloads/e3chat.js` 是否暴露 `editMessage` 方法                 | `e3ChatIpcHandlers.js` 是否注册 `e3chat:edit-message` handler      | `e3HistoryCoordinator.editMessage` 是否抛错（JSONL 路径/权限） |
| **删除消息无效果**（新增）     | 页面内确认弹层是否被取消                                         | `e3chat:delete-message` IPC 是否到达主进程                         | `reconcileDeletedSession()` 是否成功或触发 fallback 重绘       |
| **删除后输入框无光标**（新增） | 是否仍调用 `window.confirm()`（当前应为 0 处）                   | 确认关闭/删除结束后 `document.activeElement === #prompt`           | composer pointerdown 自愈是否被按钮/编辑器条件正确过滤         |
| **再生成无回复**（新增）       | `regenerateMessage` 是否正确截断历史                             | `LoadChatSession` + `SendChatMessage` 是否成功 invoke              | 事件流是否正常推送到渲染层                                     |

### 诊断数据获取

1. **Renderer DevTools**：窗口内按 `Ctrl+Shift+I`
2. **诊断面板**：侧栏底部 `<pre id="diagnostics">` 区域
3. **IPC 诊断**：`await e3chat.getDiagnostics()` — 获取最近 500 条脱敏日志
4. **本地状态**：`await e3chat.getLocalState("global")` — 含 lastKnownGoodBaseUrl

---

## 10. 安全红线速查

| 类别                                | 要求                                                   | 源码实现位置                            | 状态 |
| ----------------------------------- | ------------------------------------------------------ | --------------------------------------- | ---- |
| **contextIsolation**                | `true`                                                 | `e3ChatWindow.js:33`                    | ✅   |
| **nodeIntegration**                 | `false`                                                | `e3ChatWindow.js:34`                    | ✅   |
| **窄 preload API**                  | 只暴露 `window.e3chat` 17 个方法（含编辑/删除/再生成） | `preloads/e3chat.js:12-33`              | ✅   |
| **sender 鉴权**                     | 验证 webContents.id                                    | `e3ChatIpcHandlers.js:17-27`            | ✅   |
| **参数校验**                        | content 长度 ≤ 200000                                  | `e3ChatService.js:233-236`              | ✅   |
| **pending requestId**               | 只允许回答 pending 中的                                | `e3ChatService.js:327-328`              | ✅   |
| **脱敏**                            | API key/Authorization/cookie/token/workspace key       | `e3ProtocolDiagnostics.js:3` 正则       | ✅   |
| **DOMPurify**                       | 所有 Markdown HTML 都经过净化                          | `messageBlock.js:340-345`               | ✅   |
| **不暴露 ipcRenderer/require/Node** | preload 只用 contextBridge                             | `preloads/e3chat.js:35` `Object.freeze` | ✅   |
| **不修改 E3 私有存储**              | 本地状态存储在 `AppData/E3Chat/`                       | `e3LocalStateStore.js:8-9`              | ✅   |
| **不修改 package.json**             | 使用已安装的 `ws`                                      | `e3SignalRClient.js:4`                  | ✅   |

**⚠ 注意事项**：

- `sandbox: false`（e3ChatWindow.js:35）— 文档未明确要求 sandbox，当前为 false。如果需要更严格的安全，可改为 true，但可能影响 preload 的 `require("electron")`。
- `devTools: true`（e3ChatWindow.js:36）— 生产环境可考虑设为 false。

---

## 11. 更新维护操作指引

### 11.1 添加新的 IPC 通道

1. `e3ChatService.js` — 添加业务方法
2. `e3ChatIpcHandlers.js` — `wrap("e3chat:新通道名", ...)` 注册
3. `preloads/e3chat.js` — `api` 对象添加新方法
4. `e3chat.js` 或对应前端模块 — 调用 `window.e3chat.新方法()`

### 11.2 添加新的 Hub 事件类型

1. `e3EventNormalizer.js` — `normalizeHubEvent()` 添加新的 `if (eventName === "...")` 分支
2. `e3chat.js handleEvent()` — 添加对应的 `if (event.type === "...")` 路由
3. 可选：添加新的 block 组件

### 11.3 添加新的渲染 Block

1. 在 `Desktopmodules/e3chat/blocks/` 创建新文件（暴露到 `window.E3NewBlock`）
2. `e3chat.html` — 添加 `<script src="./blocks/newBlock.js">`
3. `messageStreamRenderer.js` — 添加对应的 render/append 方法
4. `e3chat.css` — 添加样式

### 11.4 更新 vendor 依赖

1. 替换 `vendor/` 下对应的 `.min.js` 文件
2. 注意 API 兼容性（尤其是 `mermaid.render()` 的异步/同步切换）
3. `animationProcessor.js` 的 CDN URL 正则可能需要更新

### 11.5 修改 E3 后端发现逻辑

- 进程发现：`e3BackendDiscovery.js:56` — 修改 PowerShell 命令
- negotiate URL：`e3BackendDiscovery.js:68` — 修改路径
- hub key：`e3ChatService.js:129` — 当前硬编码 `"dev"`
- URL 验证：`e3BackendDiscovery.js:34` — 限制 `localhost/127.0.0.1`

### 11.6 文件修改影响矩阵

| 修改文件                   | 影响范围            | 需同步检查                                |
| -------------------------- | ------------------- | ----------------------------------------- |
| `e3ChatService.js`         | 所有 IPC 调用       | `e3ChatIpcHandlers.js` 参数传递           |
| `e3SignalRClient.js`       | 所有 Hub 通信       | `e3ChatService.js` 绑定逻辑               |
| `e3EventNormalizer.js`     | 所有事件显示        | `e3chat.js handleEvent()`                 |
| `messageBlock.js`          | 所有消息渲染        | CSS 样式、vendor 依赖                     |
| `messageStreamRenderer.js` | 流式显示+历史恢复   | `e3chat.js`、`workspaceSessionSidebar.js` |
| `e3ChatWindow.js`          | 窗口创建            | `desktopHandlers.js` 调用                 |
| `preloads/e3chat.js`       | Renderer API 可用性 | `e3chat.js` 调用                          |

---

## 12. 与原始设计文档的偏差记录

| 条目               | 文档设计                                                  | 实际实现                                                                | 影响评估                                                    |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| §4 文件列表        | 未列出 `e3ViewportBridge.js`                              | 实际存在（4450B），处理 E3 原生 3D 视口 RPC                             | 低风险，属于功能扩展                                        |
| §4 文件列表        | 未列出 `animationProcessor.js`                            | 实际存在（11995B），处理 anime.js/Three.js 安全执行                     | 低风险，对齐 VChat animation.js                             |
| §5.1 main.js       | `initialize({ openChildWindows })`                        | `initialize({ projectRoot: PROJECT_ROOT })`                             | 无影响，`openChildWindows` 改在 desktopHandlers 传递        |
| §5.3 vchatApps.js  | `description: "连接 E3 后端的工作空间同步聊天窗口"`       | `description: "打开 E3 原生聊天内置窗口"`                               | 无功能影响                                                  |
| §6 preload API     | 未列出 `ready()`                                          | 实际存在 `ready() → invoke("e3chat:register-window")`                   | 必需的鉴权步骤                                              |
| §9 Hub 调用        | `SendChatMessage(content, attachments ?? null)`           | `SendChatMessage(content, sessionId ?? null)` — 第二参数是 sessionId    | **关键偏差**，已确认为 E3 真实协议                          |
| §12 本地存储路径   | `app.getPath("userData")/e3chat/state.json`               | `projectRoot/AppData/E3Chat/local-state.json`                           | 路径不同但功能等价                                          |
| §13.4 渲染管线     | 文档建议 `morphdom patch`                                 | 实际对齐 VChat 的流式/最终态分工，但仍使用 `replaceChildren()` 更新 DOM | morphdom.min.js 已加载但未使用；当前修复未额外引入复杂 diff |
| §13 VChat 渲染资产 | 文档列出 `modules/renderer/contentPipeline.js` 等抽取复用 | 实际重新实现了独立的 `messageBlock.js` 渲染管线                         | 符合"复用能力不复用宿主"原则                                |

---

## 13. 诊断命令速查

### 启动前检查

```powershell
# 检查 E3 后端是否在运行
Get-CimInstance Win32_Process -Filter "Name='esws.exe'" | Select-Object ProcessId,CommandLine

# 语法检查所有主进程模块
$root = "E:\VCPChat"
$files = @(
  "modules\e3chat\e3ChatWindow.js",
  "modules\e3chat\e3ChatIpcHandlers.js",
  "modules\e3chat\e3ChatService.js",
  "modules\e3chat\e3BackendDiscovery.js",
  "modules\e3chat\e3SignalRClient.js",
  "modules\e3chat\e3EventNormalizer.js",
  "modules\e3chat\e3WorkspaceCoordinator.js",
  "modules\e3chat\e3SessionRepository.js",
  "modules\e3chat\e3SessionSyncService.js",
  "modules\e3chat\e3ProtocolDiagnostics.js",
  "modules\e3chat\e3LocalStateStore.js",
  "modules\e3chat\e3ViewportBridge.js",
  "modules\e3chat\e3HistoryCoordinator.js",
  "preloads\e3chat.js"
)
foreach ($f in $files) { node --check (Join-Path $root $f) }
```

### 运行时诊断（在 E3 Chat 窗口 DevTools Console 中）

```js
// 连接状态
await e3chat.getStatus();

// 完整诊断日志
await e3chat.getDiagnostics();

// 本地状态
await e3chat.getLocalState("global");

// 当前 generation
window.E3MessageStreamRenderer.state.generation;

// 当前活跃会话
window.E3WorkspaceSidebar.getActiveSessionId();

// 手动连接指定端口
await e3chat.connect({ baseUrl: "http://127.0.0.1:49981" });

// 手动列出会话
await e3chat.listSessions();

// 手动加载会话
await e3chat.loadSession("会话ID");
```

### 手动回归测试清单

```
□ Dock 出现 E3 Chat 图标
□ 点击图标打开窗口
□ 重复点击聚焦现有窗口
□ 自动发现 E3 后端并连接
□ 会话列表正确显示
□ 点击会话加载历史
□ 发送短文本聊天
□ 流式文本增量显示
□ 流式未闭合 HTML 不临时显示 `<pre><code>` 代码窗口
□ done、取消和错误后执行最终完整渲染
□ 思考块折叠显示
□ E3 工具卡 running→success/error
□ AskUserQuestion 单选/多选/Other
□ 取消后收到 done 的处理
□ 点击上传文件：单选、多选、取消均正常，并显示附件预览
□ 在输入框粘贴剪贴板图片并显示缩略图
□ 粘贴普通文本不被附件逻辑阻止
□ 仅附件无文字、文字与附件组合时均可发送
□ 点击 × 后对应附件不再发送
□ 添加超过 10 个附件时只保留前 10 个并显示提示
□ 粘贴空文件或超过 25MB 的文件时显示错误
□ 发送失败后恢复输入文字和待发送附件
□ 生成期间上传文件和新建会话按钮禁用
□ 上传文件按钮旁的新建会话按钮清空当前视图和待发送附件
□ 新建会话
□ 重命名会话
□ Workspace 切换后重建 hub
□ 断线后 reconnect
□ Markdown/代码/KaTeX/Mermaid 渲染
□ 关闭窗口后资源清理
□ 右键消息块显示上下文菜单，菜单项根据消息类型/状态正确显示/隐藏
□ 复制文本 → 剪贴板内容正确
□ 复制选中 → 仅选区文字进入剪贴板
□ 复制源文本 → 原始 Markdown 进入剪贴板
□ 编辑消息 → 内联 textarea 显示 → 保存后 session reload 正确刷新
□ 编辑取消/Escape → 恢复原消息内容，无残留 UI
□ 删除消息 → 页面内确认弹层 → fingerprint 增量协调，未变消息 DOM/滚动位置/动画不闪烁
□ 删除确认取消、确认后 IPC 等待期、成功 Toast 消失后，输入框均可立即获得光标并输入
□ 删除含 thinking/tool 关联块时，同 reference 节点一并移除且剩余消息 reference 可继续编辑/删除
□ 人为制造 fingerprint 匹配失败时自动回退 chunked 完整重绘，界面保持权威状态
□ 再生成 → 截断历史 → 新回复流式渲染
□ 中止生成 → CancelChat → UI 恢复
□ 流式中/streaming 状态不显示编辑/删除菜单项
□ 浅色主题下菜单/编辑/toast 外观正确
□ 菜单定位不超出视口边界（右下角消息）
```

---

> **文档维护约定**：当 E3 Chat 源码发生结构性变更（新增/删除模块、IPC 通道变化、渲染管线调整）时，应同步更新本文档对应章节。
