# Remote Gateway 使用说明（个人自用简化版）

## 配置来源
Host 读取 `AppData/settings.json`（由 `appSettingsManager` 默认值补齐）：
- `remoteGatewayEnabled`: `true`
- `remoteGatewayHost`: `0.0.0.0`
- `remoteGatewayPort`: `17888`
- `remoteGatewayToken`: `vchat-remote-token`
- `remoteAllowedRoots`: `[]`（为空时默认仅允许 `AppData`）

## HTTP
- `GET /health`
- `GET /meta`

## WebSocket 协议（v1）
1. 服务端先发：
```json
{ "type": "hello", "protocolVersion": 1, "protocolCompat": [1], "requiresAuth": true }
```
2. 客户端发鉴权：
```json
{ "type": "auth", "token": "...", "clientId": "desktop_xxx" }
```
3. RPC 调用：
```json
{ "type": "rpc", "id": 1, "method": "getAgents", "params": {} }
```
4. RPC 返回：
```json
{ "type": "rpc_result", "id": 1, "success": true, "result": [...] }
```

## 当前已实现方法
### Agent/Topic
- `getAgents`
- `getAgentConfig`
- `saveAgentConfig`
- `getAgentTopics`
- `createNewTopicForAgent`
- `renameTopic`
- `deleteTopic`
- `saveTopicOrder`
- `setTopicUnread`
- `toggleTopicLock`

### Chat
- `getChatHistory`
- `saveChatHistory`
- `sendToVCP`（流式代理）

### Canvas
- `getCanvasHistory`
- `getCanvasContent`
- `saveCanvasContent`
- `createCanvas`

### Settings/File
- `loadSettings`
- `readHostFile`（受白名单限制）

## 关键事件
- `topic.created`
- `topic.renamed`
- `topic.deleted`
- `topic.order.updated`
- `topic.unread.updated`
- `topic.lock.updated`
- `chat.history.updated`
- `chat.message.append`
- `chat.stream.chunk`
- `chat.stream.end`
- `chat.stream.error`
- `bubble.render.meta`
- `canvas.created`
- `canvas.content.updated`
- `agent.config.updated`

## 审计日志
写入：`AppData/remote_gateway_audit.log`
