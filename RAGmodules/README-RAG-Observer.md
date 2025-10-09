# RAG Observer 使用说明

## 功能说明

RAG Observer 是一个独立的网页工具，用于监听和显示 RAG 知识库的召回信息。

## 主要特性

1. **自动配置**: 从 `settings.js` 读取连接信息（vcpLogUrl 和 vcpLogKey）
2. **主题同步**: 自动应用主程序的明暗主题（dark/light）
3. **磨砂特效**: 集成了主程序的磨砂玻璃视觉效果
4. **实时监听**: WebSocket 连接实时接收 RAG 召回详情

## 文件说明

- `RAG_Observer.html` - 主页面
- `settings.js` - 配置文件（包含连接信息和主题设置）
- `rag-observer-config.js` - 配置管理和自动连接脚本

## 重要提示

**当主程序的 `AppData/settings.json` 更新时，需要同步更新 `settings.js` 文件！**

### settings.js 格式示例：

```javascript
window.VCP_SETTINGS = {
    "vcpLogUrl": "ws://192.168.2.179:6005",
    "vcpLogKey": "123456",
    "currentThemeMode": "dark"
};
```

### 建议的同步方案

在主程序中添加以下逻辑（保存 settings.json 时）：

```javascript
const fs = require('fs');
const path = require('path');

function syncSettingsToObserver(settings) {
    const observerSettings = {
        vcpLogUrl: settings.vcpLogUrl,
        vcpLogKey: settings.vcpLogKey,
        currentThemeMode: settings.currentThemeMode
    };
    
    const content = `// VCP Settings - Auto-generated from AppData/settings.json
// 这个文件会被主程序自动更新
window.VCP_SETTINGS = ${JSON.stringify(observerSettings, null, 4)};
`;
    
    fs.writeFileSync(
        path.join(__dirname, 'RAGmodules/settings.js'),
        content,
        'utf8'
    );
}
```

## 使用方式

1. 直接在浏览器中打开 `RAG_Observer.html`
2. 页面会自动读取配置并连接到 WebSocket 服务器
3. 主题会根据 `currentThemeMode` 自动切换
4. 每 5 秒自动检测主题变化

## 主题切换

- `dark` 模式：夜樱倒影（深色背景 + 樱花粉色调）
- `light` 模式：绿影猫咪（浅绿背景 + 清新绿色调）

磨砂玻璃效果在两种模式下都会自动应用。


## 启动示例
请右键属性示例修改正确启动路径。