# Mailboxmodules - 邮箱模块

Mailboxmodules 是 VCPChat 的一个扩展模块，提供了带预制消息的新建话题功能，支持 Agent 选择、会话发起和聊天窗口跳转。

## 功能特性

### 1. 带参数的新建话题接口
- 支持在新建话题时自动添加预制消息
- 支持多种消息角色：`user`、`assistant`、`system`
- 支持多条预制消息
- 自动跳转到新创建的话题

### 2. Agent 管理系统
- 获取可用 Agent 列表
- 选择特定 Agent 发起会话
- 自动创建默认话题（如果 Agent 没有话题）

### 3. FileWatcher 集成
- 确保文件监控机制正常工作
- 支持实时话题文件变化检测
- 与现有的聊天历史同步机制集成

### 4. 测试面板
- 提供直观的图形界面测试所有功能
- 实时状态显示
- 操作日志记录

## 使用方法

### 基本用法

```javascript
// 初始化模块
window.mailboxManager.init({
    electronAPI: window.electronAPI,
    chatManager: window.chatManager
});

// 创建带预制消息的话题
const result = await window.mailboxManager.createTopicWithPresetMessages(
    'agent_id_123',           // Agent ID
    '我的新话题',              // 话题名称
    [                         // 预制消息数组
        {
            role: 'system',
            content: '你是一个有用的AI助手。'
        },
        {
            role: 'user',
            content: '你好，请帮我解答一个问题。'
        }
    ],
    {
        autoSwitch: true      // 自动跳转到新话题
    }
);

if (result.success) {
    console.log(`话题创建成功: ${result.topicId}`);
} else {
    console.error(`话题创建失败: ${result.error}`);
}
```

### 打开测试面板

在主界面聊天头部区域，点击 "📬 Mailbox测试" 按钮打开测试面板。

## API 参考

### mailboxManager.init(config)

初始化 MailboxManager 模块。

**参数:**
- `config.electronAPI` - Electron API 对象
- `config.chatManager` - 聊天管理器实例

**返回值:** `boolean` - 初始化是否成功

### mailboxManager.getAvailableAgents()

获取所有可用 Agent 列表。

**返回值:** `Promise<Array>` - Agent 数组

### mailboxManager.selectAgent(agentId, options)

选择指定的 Agent 并发起会话。

**参数:**
- `agentId` (string) - Agent ID
- `options` (Object) - 选项
  - `skipTopicSelection` (boolean) - 是否跳过自动选择话题（默认: false）
  - `skipDefaultTopic` (boolean) - 是否跳过创建默认话题（默认: false）

**返回值:** `Promise<Object>` - 选择结果

### mailboxManager.createTopicWithPresetMessages(agentId, topicName, messages, options)

创建带预制消息的新话题。

**参数:**
- `agentId` (string) - Agent ID
- `topicName` (string) - 话题名称
- `messages` (Array) - 预制消息数组
  - `role` (string) - 消息角色 ('user'|'assistant'|'system')
  - `content` (string) - 消息内容
- `options` (Object) - 选项
  - `autoSwitch` (boolean) - 是否自动跳转到新话题

**返回值:** `Promise<Object>` - 创建结果

### mailboxManager.switchToTopic(agentId, topicId)

跳转到指定话题。

**参数:**
- `agentId` (string) - Agent ID
- `topicId` (string) - 话题 ID

**返回值:** `Promise<Object>` - 跳转结果

### mailboxManager.getCurrentState()

获取当前状态。

**返回值:** `Object` - 当前状态信息

### mailboxManager.showTestPanel()

显示测试面板。

## 测试面板功能

测试面板提供以下功能：

1. **Agent 管理**
   - 查看和选择可用 Agent
   - 刷新 Agent 列表

2. **话题创建**
   - 输入话题名称
   - 添加多条预制消息（支持不同角色）
   - 一键创建话题

3. **状态监控**
   - 实时显示当前 Agent 和话题状态
   - 显示模块初始化状态

4. **操作控制**
   - 测试 FileWatcher 功能
   - 重置模块状态
   - 查看操作日志

## 集成说明

### 文件结构

```
Mailboxmodules/
├── mailboxManager.js      # 主模块文件
├── testPanel.html         # 测试面板HTML
├── testIntegration.js     # 集成测试脚本
└── README.md             # 说明文档
```

### 依赖模块

- `chatManager.js` - 聊天管理器（需扩展支持预制消息）
- `electronAPI` - Electron API 对象
- `uiHelperFunctions` - UI 辅助函数

### 扩展的聊天管理器功能

在 `chatManager.js` 中新增了以下方法：

```javascript
// 创建带预制消息的话题
async function createNewTopicWithMessages(agentId, topicName, messages = [], options = {})
```

## 注意事项

1. **初始化顺序**: 确保在聊天管理器初始化之后再初始化 MailboxManager
2. **Agent 路径**: Agent 数据存储在 `/AppData/Agents/` 目录下
3. **话题文件**: 话题历史存储在 `/AppData/UserData/{agentId}/topics/{topicId}/history.json`
4. **FileWatcher**: 监控话题文件变化，确保实时同步

## 故障排除

### 常见问题

1. **模块未初始化**
   - 检查是否正确调用了 `mailboxManager.init()`
   - 确认依赖模块已正确加载

2. **Agent 列表为空**
   - 检查 `/AppData/Agents/` 目录是否存在
   - 确认 Agent 配置格式正确

3. **话题创建失败**
   - 检查 Agent ID 是否有效
   - 确认用户数据目录存在且可写

4. **FileWatcher 不工作**
   - 检查文件路径是否正确
   - 确认监听器已正确启动

5. **Agent选择后跳转到上次话题**
   - 这是正常行为，新话题会在创建后自动跳转
   - 如果需要避免，请在选择Agent时使用 `skipTopicSelection: true` 选项

6. **预制消息没有保存**
   - 检查文件写入权限
   - 确认话题ID正确
   - 查看浏览器控制台日志获取详细错误信息

### 调试技巧

1. 打开浏览器开发者工具查看控制台日志
2. 使用测试面板的"显示日志"功能
3. 检查网络请求和文件操作

## 更新日志

### v1.0.1
- 修复：Agent选择时自动跳转到上次话题的问题
- 新增：`skipTopicSelection` 选项控制是否自动选择话题
- 新增：测试面板中可选择是否跳过话题自动选择
- 改进：预制消息保存验证机制
- 优化：新话题创建和跳转的时序控制

### v1.0.0
- 初始版本发布
- 支持带预制消息的新建话题功能
- 集成 Agent 选择和会话管理
- 提供图形化测试面板
- 集成 FileWatcher 机制