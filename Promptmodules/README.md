# Promptmodules - 系统提示词模块

VCPChat 的系统提示词管理模块，提供三种不同的提示词编辑模式。

## 功能概述

此模块将系统提示词功能扩展为三个独立的模块，每个模块都有独特的使用场景：

### 1. 原始富文本系统提示词模块
- **字段**: `originalSystemPrompt`
- **特点**: 保持与原有系统完全一致的富文本编辑体验
- **适用场景**: 简单直接的提示词编辑

### 2. 模块化系统提示词模块（积木块功能）
- **字段**: `advancedSystemPrompt`
- **特点**: 
  - 积木块式编辑，每个积木块独立管理
  - 支持拖拽调整顺序
  - 支持禁用/启用单个积木块
  - 支持隐藏积木块到小仓
  - 支持轮换文本（一个积木块多个可选内容）
  - TILE_MODE 控制视觉布局
  - View 模式预览最终格式化结果
- **适用场景**: 复杂的、需要频繁调整组合的提示词

### 3. 临时与预制系统提示词模块
- **字段**: `presetSystemPrompt`
- **特点**:
  - 支持从预设文件夹加载预设提示词
  - 默认路径: `./AppData/systemPromptPresets`
  - 支持 .md 和 .txt 格式
  - 支持自定义预设路径
- **适用场景**: 使用预制模板或快速切换不同场景的提示词

## 文件结构

```
Promptmodules/
├── prompt-manager.js           # 主管理器，负责模式切换
├── original-prompt-module.js   # 原始富文本模块
├── modular-prompt-module.js    # 模块化积木块模块
├── preset-prompt-module.js     # 临时与预制模块
├── prompt-modules.css          # 样式文件
└── README.md                   # 说明文档
```

## 数据结构

### Agent 配置新增字段

```json
{
  "promptMode": "original|modular|preset",
  "originalSystemPrompt": "原始提示词内容...",
  "advancedSystemPrompt": {
    "blocks": [
      {
        "id": "block_xxx",
        "type": "text|newline",
        "content": "积木块内容",
        "disabled": false,
        "variants": ["选项1", "选项2"],
        "selectedVariant": 0
      }
    ],
    "hiddenBlocks": {
      "default": [],
      "warehouse1": []
    },
    "tileMode": true
  },
  "presetSystemPrompt": "预设提示词内容...",
  "presetPromptPath": "./AppData/systemPromptPresets",
  "selectedPreset": "/path/to/preset.md"
}
```

## 使用方法

### 前端集成

在 Agent 设置页面中，原有的 `agentSystemPrompt` textarea 被替换为 Promptmodules：

```html
<!-- 在 main.html 中引入 -->
<link rel="stylesheet" href="Promptmodules/prompt-modules.css">
<script src="Promptmodules/original-prompt-module.js"></script>
<script src="Promptmodules/modular-prompt-module.js"></script>
<script src="Promptmodules/preset-prompt-module.js"></script>
<script src="Promptmodules/prompt-manager.js"></script>
```

### 初始化

```javascript
// 在 settingsManager.js 中初始化
const promptManager = new window.PromptManager();
promptManager.init({
    agentId: 'agent_id',
    config: agentConfig,
    containerElement: document.getElementById('systemPromptContainer'),
    electronAPI: window.electronAPI
});
```

### 获取当前激活的系统提示词

```javascript
// 在发送消息时
const systemPrompt = await promptManager.getCurrentSystemPrompt();
```

### 外部接口（用于插件）

```javascript
// 切换到指定模式
await promptManager.setMode('modular');

// 获取当前模式
const currentMode = promptManager.getMode();
```

## 后端支持

### IPC 处理器

在 `modules/ipc/promptHandlers.js` 中实现了以下处理器：

- `load-preset-prompts`: 加载预设列表
- `load-preset-content`: 加载预设内容
- `select-directory`: 选择目录
- `get-active-system-prompt`: 获取当前激活的系统提示词
- `update-agent-config`: 更新 Agent 配置

### 使用示例

```javascript
// 前端调用
const presets = await electronAPI.loadPresetPrompts('./AppData/systemPromptPresets');
const content = await electronAPI.loadPresetContent('/path/to/preset.md');
const systemPrompt = await electronAPI.getActiveSystemPrompt('agent_id');
```

## 模块化积木块详细说明

### 积木块类型

1. **文本积木块** (`type: 'text'`)
   - 可编辑内容
   - 支持轮换文本
   - 可禁用/启用
   - 可隐藏到小仓

2. **换行积木块** (`type: 'newline'`)
   - 特殊的圆形样式
   - 不透明度60%
   - TILE_MODE 关闭时隐藏

### 积木块操作

- **拖拽**: 在 TILE_MODE 下可拖拽调整顺序
- **右键菜单**: 
  - 禁用/启用
  - 隐藏到小仓
  - 添加轮换文本
  - 删除
- **快捷键**: `Shift+Enter` 快速插入换行块

### 小仓功能

- 支持多个仓库分类
- 拖拽从小仓恢复积木块
- `Alt/Option + 拖拽` 复制积木块

### 格式化规则

积木块格式化时：
1. 跳过禁用的积木块
2. 换行块转换为 `\n`
3. 有轮换文本的块使用选中的版本
4. 按顺序拼接所有内容

## 样式自适应

模块完全适配 VCPChat 的主题系统，支持：
- 亮色/暗色主题自动切换
- 响应式设计（移动端适配）
- 自定义 CSS 变量

## 注意事项

1. **向后兼容**: 模块会自动检测并兼容旧的 `systemPrompt` 字段
2. **数据迁移**: 首次使用会自动将旧数据迁移到 `originalSystemPrompt`
3. **默认模式**: 未设置时默认使用 `original` 模式
4. **预设路径**: 默认预设路径会自动创建

## 开发状态

✅ 核心功能已完成
✅ 后端 IPC 处理器已实现
✅ 前端三个模块已实现
✅ 样式文件已创建
⏳ 前端集成待完成（需要修改 settingsManager.js 和 main.html）
⏳ 测试待完成

## 待集成工作

1. 修改 `modules/settingsManager.js` 中的 `populateAgentSettingsForm` 函数
2. 修改 `main.html` 中的系统提示词输入区域
3. 在 `modules/chatManager.js` 中使用新的 API 获取系统提示词
4. 创建默认预设文件夹和示例预设

## 许可证

与 VCPChat 主项目相同