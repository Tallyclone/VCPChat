# ShadowDistributedRouter 架构设计文档 (Final)

## 1. 核心设计哲学
- **非侵入式扩展**：不修改 VCP 核心基类 `Plugin.js`。通过 `ShadowDistributedRouter` 插件劫持 `PluginManager.execute` 实现路由控制。
- **意图显式驱动**：支持 `tool_name@device_alias` 语法，赋予 Agent 主动跨设备协作的能力。
- **动态环境感知**：通过 VCP 系统占位符机制，实时为 Agent 提供在线设备拓扑。

## 2. 关键实现方案

### A. 动态设备注入 (Live Injection)
- **占位符**：定义 `{{SHADOW_DEVICES}}` 为系统级或插件级占位符。
- **注入时机**：在 `chatCompletionHandler.js` 处理提示词或在路由插件的 `getPrompt` 钩子中（取决于具体拦截点）。
- **内容构成**：
  ```json
  [
    {"alias": "盛世国际电脑", "os": "Windows 10", "ip": "192.168.1.5", "status": "online"},
    {"alias": "客厅终端", "os": "Linux", "ip": "192.168.1.10", "status": "online"}
  ]
  ```
- **别名持久化**：建立 `alias_map.json`。逻辑为：`Client_UUID/IP -> Custom_Alias`。

### B. tool@alias 路由机制
1. **正则剥离**：路由插件匹配 `^(.+)@(.+)$`。
2. **逻辑分流**：
   - **本地优先**：若 `PluginManager.tools.has(target_tool)` 且未指定别名，则执行本地。
   - **指定路由**：若指定了 `@alias`，查表找到对应的 `clientId`。
   - **屏蔽与清洗**：在向目标设备下发指令前，将 `tool_name` 还原为不带 `@alias` 的原始名称，确保目标设备插件能正常响应。

### C. 兼容性处理
- **@ 语法冲突**：经确认，VCP 内部 `@` 广泛用于 Mention 和特定文件协议。但在 `tool_name` 字段（`<<<[TOOL_REQUEST]>>>` 内部）使用 `@` 属于私有协议域，与外部 Markdown/对话解析器不产生直接冲突。

## 3. 待办与约束
- **移除旧逻辑**：正式删除基于“用户对话向量化”的被动指定设备逻辑。
- **不改源码原则**：所有逻辑封装在 `ShadowDistributedRouter` 插件及其对应的 `Monkey Patch` 脚本中。

---
*由 鹿小满 协作整理存盘 2026-05-17*