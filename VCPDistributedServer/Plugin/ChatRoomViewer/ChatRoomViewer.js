const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const chokidar = require('chokidar'); // 添加chokidar用于实时文件监控

// 从环境变量读取配置
const debugMode = (process.env.DebugMode || "false").toLowerCase() === "true";
const enabled = (process.env.Enabled || "true").toLowerCase() === "true";
const customVCPChatRoot = process.env.VCPChatRoot; // 自定义VCPChat根目录
const timeZone = process.env.TimeZone || "Asia/Shanghai"; // 默认东八区

function FORCE_LOG(...args) {
    if (debugMode) {
        console.error(...args); // 强制日志输出到 stderr
    }
}

// 时间戳格式化函数 - 支持时区转换
function formatTimestamp(timestamp, format = 'time') {
    try {
        let date;
        if (typeof timestamp === 'string') {
            date = new Date(timestamp);
        } else if (typeof timestamp === 'number') {
            date = new Date(timestamp);
        } else {
            date = new Date();
        }
        
        // 使用指定时区格式化
        const options = {
            timeZone: timeZone,
            hour12: false // 使甤24小时制
        };
        
        if (format === 'time') {
            // 只显示时间部分（如 19:44:00）
            options.hour = '2-digit';
            options.minute = '2-digit';
            options.second = '2-digit';
        } else if (format === 'datetime') {
            // 显示完整日期时间
            options.year = 'numeric';
            options.month = '2-digit';
            options.day = '2-digit';
            options.hour = '2-digit';
            options.minute = '2-digit';
            options.second = '2-digit';
        } else if (format === 'iso') {
            // 返回ISO格式
            return date.toLocaleString('sv-SE', { timeZone: timeZone }).replace(' ', 'T') + '.000Z';
        }
        
        return date.toLocaleString('zh-CN', options);
    } catch (error) {
        FORCE_LOG('[时间戳格式化错误]:', error.message);
        return timestamp?.toString() || new Date().toLocaleTimeString();
    }
}

// 获取当前时间戳（格式化后）
function getCurrentTimestamp(format = 'iso') {
    return formatTimestamp(new Date(), format);
}


// 检测VCPChat主目录
function getVCPChatMainDirectory() {
    // 优先使用环境变量中的自定义路径
    if (customVCPChatRoot) {
        FORCE_LOG('[ChatRoomViewer] Using custom VCPChat root from env:', customVCPChatRoot);
        return customVCPChatRoot;
    }
    
    // 从当前插件路径推断主目录
    const currentDir = __dirname;
    // 插件路径格式：/path/to/VCPChat/VCPDistributedServer/Plugin/ChatRoomViewer
    // 需要回到 /path/to/VCPChat
    const vcpChatMainDir = path.resolve(currentDir, '../../..');
    
    FORCE_LOG('[ChatRoomViewer] Auto-detected VCPChat root:', vcpChatMainDir);
    return vcpChatMainDir;
}

// 读取VCPChat设置文件
async function readVCPChatSettings() {
    try {
        const mainDir = getVCPChatMainDirectory();
        // VCPChat的settings.json位于AppData目录下，不是用户主目录
        const settingsPath = path.join(mainDir, 'AppData', 'settings.json');
        
        FORCE_LOG('[ChatRoomViewer] Attempting to read settings from:', settingsPath);
        
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        return settings;
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error reading settings:', error.message);
        
        // 尝试备用路径：用户主目录
        try {
            const fallbackPath = path.join(os.homedir(), 'VCPChat', 'settings.json');
            FORCE_LOG('[ChatRoomViewer] Trying fallback path:', fallbackPath);
            const settingsContent = await fs.readFile(fallbackPath, 'utf-8');
            return JSON.parse(settingsContent);
        } catch (fallbackError) {
            FORCE_LOG('[ChatRoomViewer] Fallback path also failed:', fallbackError.message);
            return null;
        }
    }
}

// 读取当前主题配置
async function readCurrentTheme(themeName, settings = null) {
    try {
        if (!themeName) {
            // 读取当前激活的主题文件
            const mainDir = getVCPChatMainDirectory();
            const activeThemePath = path.join(mainDir, 'styles', 'themes.css');
            
            FORCE_LOG('[ChatRoomViewer] Reading active theme from:', activeThemePath);
            
            const themeContent = await fs.readFile(activeThemePath, 'utf-8');
            
            // 解析当前主题信息
            const themeInfo = parseThemeFromCSS(themeContent, settings);
            return themeInfo;
        }
        
        const mainDir = getVCPChatMainDirectory();
        // 尝试多个可能的主题路径
        const possiblePaths = [
            path.join(mainDir, 'styles', 'themes', `themes${themeName}.css`),
            path.join(mainDir, 'styles', 'themes', `${themeName}.css`),
            path.join(mainDir, 'public', 'assets', 'themes', themeName, 'theme.config.json'),
            path.join(mainDir, 'styles', 'themes.css') // 当前激活的主题
        ];
        
        for (const themePath of possiblePaths) {
            try {
                FORCE_LOG('[ChatRoomViewer] Attempting to read theme from:', themePath);
                
                const themeContent = await fs.readFile(themePath, 'utf-8');
                
                if (themePath.endsWith('.json')) {
                    return JSON.parse(themeContent);
                } else {
                    return parseThemeFromCSS(themeContent, null);
                }
            } catch (err) {
                continue; // 尝试下一个路径
            }
        }
        
        return null;
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error reading theme config:', error.message);
        return null;
    }
}

// 从CSS文件中解析主题信息
function parseThemeFromCSS(cssContent, settings = null) {
    const themeInfo = {
        name: "当前主题",
        isDarkMode: true, // 默认暗色模式
        colors: {},
        wallpaper: {}
    };
    
    // 优先从settings.json读取currentThemeMode字段
    if (settings && settings.currentThemeMode) {
        themeInfo.isDarkMode = settings.currentThemeMode === 'dark';
        FORCE_LOG('[ChatRoomViewer] Theme mode from settings.json:', settings.currentThemeMode);
    } else {
        // 备用方法：从CSS内容判断
        if (cssContent.includes('body.light-theme')) {
            themeInfo.isDarkMode = false;
        }
        FORCE_LOG('[ChatRoomViewer] Theme mode from CSS fallback:', themeInfo.isDarkMode ? 'dark' : 'light');
    }
    
    // 解析主题名称
    const nameMatch = cssContent.match(/\/\*[\s\S]*?([^\*\/]+)\s*Theme[\s\S]*?\*\//i);
    if (nameMatch) {
        themeInfo.name = nameMatch[1].trim();
    }
    
    // 解析CSS变量
    const varMatches = cssContent.matchAll(/--([\w-]+):\s*([^;]+);/g);
    for (const match of varMatches) {
        const varName = match[1];
        const varValue = match[2].trim();
        
        if (varName.includes('color') || varName.includes('bg')) {
            themeInfo.colors[varName] = varValue;
        }
        
        if (varName.includes('wallpaper')) {
            themeInfo.wallpaper[varName] = varValue;
        }
    }
    
    return themeInfo;
}

// 获取当前节点信息 - 基于真实的Agent配置
async function getCurrentNodeInfo() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const agentsDir = path.join(mainDir, 'AppData', 'Agents');
        
        // 获取所有Agent目录
        const agentDirs = await fs.readdir(agentsDir, { withFileTypes: true });
        const validAgents = agentDirs.filter(dir => dir.isDirectory() && dir.name.startsWith('_Agent_'));
        
        if (validAgents.length > 0) {
            // 使用第一个有效的Agent ID作为节点信息
            const agentDirName = validAgents[0].name;
            const parts = agentDirName.match(/_Agent_(\d+)_(\d+)/);
            
            if (parts) {
                const nodeId = parts[1];
                const timestamp = parts[2];
                
                return {
                    nodeId: agentDirName,
                    agentId: nodeId,
                    timestamp: timestamp,
                    hostname: os.hostname(),
                    createdAt: getCurrentTimestamp('iso'),
                    displayTime: formatTimestamp(parseInt(timestamp), 'time'),
                    source: `VCPChat节点: ${agentDirName}`
                };
            }
        }
        
        // 如果没有找到有效的Agent，则生成一个临时节点ID
        const fallbackNodeId = `temp-${Date.now()}`;
        return {
            nodeId: fallbackNodeId,
            hostname: os.hostname(),
            source: `临时节点: ${fallbackNodeId}`
        };
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error getting node info:', error.message);
        
        const fallbackNodeId = `error-${Date.now()}`;
        return {
            nodeId: fallbackNodeId,
            hostname: os.hostname(),
            error: error.message,
            source: `错误节点: ${fallbackNodeId}`
        };
    }
}

// 检测系统状态
function getSystemStatus() {
    const memUsage = process.memoryUsage();
    
    return {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        memoryUsage: {
            rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100, // MB
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100 // MB
        }
    };
}

// 生成VCPChat状态信息
async function generateVCPChatStatus() {
    const systemStatus = getSystemStatus();
    const settings = await readVCPChatSettings();
    const nodeInfo = await getCurrentNodeInfo();
    const sessionWatcher = await getCurrentSessionWatcher();
    
    let statusInfo = {
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time'),
        system: systemStatus,
        clientStatus: "运行中",
        nodeInfo: {
            hostname: nodeInfo.hostname
        },
        timeZone: timeZone
    };
    
    if (settings) {
        statusInfo.settings = {
            userName: settings.userName || "未设置",
            vcpServerUrl: settings.vcpServerUrl || "未设置",
            vcpLogEnabled: !!(settings.vcpLogUrl && settings.vcpLogKey),
            distributedServerEnabled: settings.enableDistributedServer || false,
            assistantEnabled: settings.assistantEnabled || false,
            musicControlEnabled: settings.agentMusicControl || false,
            vcpToolInjectionEnabled: settings.enableVcpToolInjection || false,
            sidebarWidth: settings.sidebarWidth || 260,
            notificationsSidebarWidth: settings.notificationsSidebarWidth || 300
        };
    } else {
        statusInfo.settings = {
            error: "无法读取设置文件"
        };
    }
    
    // 添加会话监控信息
    statusInfo.sessionWatcher = sessionWatcher;
    
    return statusInfo;
}

// 生成主题信息
async function generateThemeInfo() {
    const settings = await readVCPChatSettings();
    let themeInfo = {
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time')
    };
    
    try {
        // 读取当前激活的主题
        const themeConfig = await readCurrentTheme(null, settings);
        
        if (themeConfig) {
            themeInfo.currentTheme = themeConfig.name || "未知主题";
            themeInfo.mode = themeConfig.isDarkMode ? "暗色模式" : "亮色模式";
            themeInfo.isDarkMode = themeConfig.isDarkMode;
            
            // 提取主要颜色信息
            const colors = themeConfig.colors || {};
            themeInfo.colors = {
                primaryBg: colors['primary-bg'] || colors['--primary-bg'] || "#unknown",
                secondaryBg: colors['secondary-bg'] || colors['--secondary-bg'] || "#unknown",
                primaryText: colors['primary-text'] || colors['--primary-text'] || "#unknown",
                highlightText: colors['highlight-text'] || colors['--highlight-text'] || "#unknown",
                borderColor: colors['border-color'] || colors['--border-color'] || "#unknown"
            };
            
            // 提取壁纸信息
            const wallpaper = themeConfig.wallpaper || {};
            const wallpaperDark = wallpaper['chat-wallpaper-dark'] || wallpaper['--chat-wallpaper-dark'];
            const wallpaperLight = wallpaper['chat-wallpaper-light'] || wallpaper['--chat-wallpaper-light'];
            
            themeInfo.wallpaper = {
                current: themeConfig.isDarkMode ? wallpaperDark : wallpaperLight,
                dark: wallpaperDark,
                light: wallpaperLight
            };
            
            // 提取完整的CSS信息
            const mainDir = getVCPChatMainDirectory();
            const activeThemePath = path.join(mainDir, 'styles', 'themes.css');
            try {
                const fullCSS = await fs.readFile(activeThemePath, 'utf-8');
                themeInfo.fullCSS = fullCSS; // 不再截断，返回完整内容
            } catch (cssError) {
                themeInfo.fullCSS = "无法读取完整CSS";
            }
            
        } else {
            themeInfo.error = "无法读取主题配置";
        }
        
        // 如果有设置文件，尝试获取设置中的主题信息
        if (settings && settings.currentTheme) {
            themeInfo.settingsTheme = settings.currentTheme;
        }
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error generating theme info:', error.message);
        themeInfo.error = `生成主题信息时出错: ${error.message}`;
    }
    
    return themeInfo;
}


// 获取当前会话监控信息
async function getCurrentSessionWatcher() {
    // 这个函数现在只是一个占位符，实际的会话监控信息在generateVCPChatStatus中生成
    return {
        info: "会话监控信息将通过VCPChatStatus获取"
    };
}

// 获取所有Agent的基本信息
async function getAllAgentsInfo() {
    try {
        const mainDir = getVCPChatMainDirectory();
        const agentsDir = path.join(mainDir, 'AppData', 'Agents');
        
        // 获取所有Agent目录
        const agentDirs = await fs.readdir(agentsDir, { withFileTypes: true });
        const validAgents = agentDirs.filter(dir => dir.isDirectory() && dir.name.startsWith('_Agent_'));
        
        const agentsInfo = [];
        
        for (const agentDir of validAgents) {
            const agentPath = path.join(agentsDir, agentDir.name);
            const configPath = path.join(agentPath, 'config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                
                // 使用config.json文件的创建时间作为Agent创建时间
                const configStats = await fs.stat(configPath);
                const createdTimestamp = configStats.birthtime.getTime(); // 文件创建时间
                
                // 统计topics数量
                let topicsCount = 0;
                if (config.topics && Array.isArray(config.topics)) {
                    topicsCount = config.topics.length;
                }
                
                const agentInfo = {
                    agentId: agentDir.name,
                    folderPath: agentPath,
                    name: config.name || '未命名Agent',
                    model: config.model || '未指定',
                    temperature: config.temperature || 0.5,
                    contextTokenLimit: config.contextTokenLimit || 0,
                    maxOutputTokens: config.maxOutputTokens || 0,
                    // 查找Agent头像文件
                    avatarPath: await findAgentAvatar(agentPath),
                    // 使用config.json文件的创建时间作为正式的Agent创建时间
                    createdAt: formatTimestamp(createdTimestamp, 'iso'),
                    // topics数量统计
                    topicsCount: topicsCount
                };
                
                // 添加非空的配置项
                if (config.streamOutput !== undefined) agentInfo.streamOutput = config.streamOutput;
                if (config.ttsVoicePrimary) agentInfo.ttsVoicePrimary = config.ttsVoicePrimary;
                if (config.ttsRegexPrimary) agentInfo.ttsRegexPrimary = config.ttsRegexPrimary;
                if (config.ttsVoiceSecondary) agentInfo.ttsVoiceSecondary = config.ttsVoiceSecondary;
                if (config.ttsRegexSecondary) agentInfo.ttsRegexSecondary = config.ttsRegexSecondary;
                if (config.ttsSpeed !== undefined) agentInfo.ttsSpeed = config.ttsSpeed;
                if (config.avatarCalculatedColor) agentInfo.avatarCalculatedColor = config.avatarCalculatedColor;
                if (config.top_p !== undefined) agentInfo.top_p = config.top_p;
                if (config.top_k !== undefined) agentInfo.top_k = config.top_k;
                
                agentsInfo.push(agentInfo);
                
            } catch (configError) {
                FORCE_LOG(`[ChatRoomViewer] Error reading agent config for ${agentDir.name}:`, configError.message);
                // 即使配置文件读取失败，也记录Agent基本信息
                
                // 尝试获取文件创建时间
                let createdTimestamp = null;
                let displayTime = null;
                
                try {
                    const configStats = await fs.stat(configPath);
                    createdTimestamp = configStats.birthtime.getTime();
                    displayTime = formatTimestamp(createdTimestamp, 'time');
                } catch (statError) {
                    // 如果无法获取文件统计信息，使用当前时间
                    createdTimestamp = Date.now();
                    displayTime = formatTimestamp(new Date(), 'time');
                }
                
                agentsInfo.push({
                    agentId: agentDir.name,
                    folderPath: agentPath,
                    name: '无法读取配置',
                    error: configError.message,
                    avatarPath: await findAgentAvatar(agentPath),
                    createdAt: formatTimestamp(createdTimestamp, 'iso'),
                    topicsCount: 0 // 配置读取失败时无法统计topics
                });
            }
        }
        
        return {
            totalCount: agentsInfo.length,
            agents: agentsInfo,
            lastUpdate: getCurrentTimestamp('iso'),
            lastUpdateDisplay: formatTimestamp(new Date(), 'time')
        };
        
    } catch (error) {
        FORCE_LOG('[ChatRoomViewer] Error getting agents info:', error.message);
        return {
            error: `获取Agent信息失败: ${error.message}`,
            totalCount: 0,
            agents: [],
            lastUpdate: getCurrentTimestamp('iso'),
            lastUpdateDisplay: formatTimestamp(new Date(), 'time')
        };
    }
}

// 查找Agent头像文件
async function findAgentAvatar(agentPath) {
    const possibleAvatarFiles = [
        'avatar.png',
        'avatar.jpg',
        'avatar.jpeg',
        'avatar.gif',
        'avatar.webp',
        'profile.png',
        'profile.jpg'
    ];
    
    for (const avatarFile of possibleAvatarFiles) {
        const avatarPath = path.join(agentPath, avatarFile);
        try {
            await fs.access(avatarPath);
            return avatarPath; // 找到头像文件
        } catch (err) {
            // 继续尝试下一个
        }
    }
    
    // 如果没有找到头像，返回默认头像路径
    return 'assets/default_avatar.png';
}

// 生成主题模式切换气泡示范
function generateModeBubbleTip() {
    // 恢复原来的硬编码内容
    const content = `主题模式自适应气泡实现指南：

使用CSS变量实现亮暗模式自动切换的关键要素：

1. 基础结构：
<div style="
    background-color: var(--primary-bg);
    color: var(--primary-text);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 20px;
">

2. 核心变量：
- var(--primary-bg) : 主背景色
- var(--secondary-bg) : 次要背景色
- var(--primary-text) : 主文字颜色
- var(--highlight-text) : 高亮文字颜色
- var(--border-color) : 边框颜色

3. 增强效果：
    backdrop-filter: blur(10px) saturate(120%);
    transition: all 0.3s ease-in-out;
    box-shadow: 0 4px 15px rgba(0,0,0,0.1);

4. 示例应用：
<h2 style="color: var(--highlight-text); border-bottom: 1px solid var(--border-color);">
    标题文字
</h2>
<p style="color: var(--primary-text);">内容文字</p>

关键优势：
- 自动适配亮色/暗色主题
- 无需JavaScript干预
- 平滑过渡动画
- 磨砂玻璃效果`;
    
    return {
        content: content,
        timestamp: getCurrentTimestamp('iso'),
        displayTime: formatTimestamp(new Date(), 'time'),
        purpose: '提供主题模式自适应气泡的实现指导'
    };
}

async function main() {
    if (!enabled) {
        FORCE_LOG('[ChatRoomViewer] Plugin is disabled by configuration.');
        const disabledOutput = {
            "{{VCPChatStatus}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatTheme}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatSessionWatcher}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatAgent}}": "[ChatRoomViewer: Disabled]",
            "{{VCPChatModeBubbleTip}}": "[ChatRoomViewer: Disabled]"
        };
        process.stdout.write(JSON.stringify(disabledOutput));
        process.exit(0);
        return;
    }

    try {
        FORCE_LOG('[ChatRoomViewer] Starting to collect VCPChat client information...');
        
        // 并行获取所有信息
        const [statusInfo, themeInfo, agentsInfo] = await Promise.all([
            generateVCPChatStatus(),
            generateThemeInfo(),
            getAllAgentsInfo()
        ]);
        
        // 获取主题模式气泡示范（同步操作）
        const modeBubbleTip = generateModeBubbleTip();
        
        // 获取日志信息（同步操作）
        // 已删除日志功能
        
        // 获取会话监控信息
        const sessionWatcherInfo = statusInfo.sessionWatcher || { error: "无法获取会话监控信息" };
        
        const outputData = {
            "{{VCPChatStatus}}": JSON.stringify(statusInfo),
            "{{VCPChatTheme}}": JSON.stringify(themeInfo),
            "{{VCPChatSessionWatcher}}": JSON.stringify(sessionWatcherInfo),
            "{{VCPChatAgent}}": JSON.stringify(agentsInfo),
            "{{VCPChatModeBubbleTip}}": JSON.stringify(modeBubbleTip)
        };
        
        if (debugMode) {
            FORCE_LOG('[ChatRoomViewer] Generated status data:', JSON.stringify(statusInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated theme data:', JSON.stringify(themeInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated session watcher data:', JSON.stringify(sessionWatcherInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated agents data:', JSON.stringify(agentsInfo, null, 2));
            FORCE_LOG('[ChatRoomViewer] Generated mode bubble tip:', JSON.stringify(modeBubbleTip, null, 2));
        }
        
        process.stdout.write(JSON.stringify(outputData));
        process.exit(0);
        
    } catch (error) {
        const errorMsg = `[ChatRoomViewer] Unexpected error: ${error.message}`;
        FORCE_LOG(errorMsg);
        
        const errorOutput = {
            "{{VCPChatStatus}}": errorMsg,
            "{{VCPChatTheme}}": errorMsg,
            "{{VCPChatLogs}}": errorMsg,
            "{{VCPChatSessionWatcher}}": errorMsg
        };
        process.stdout.write(JSON.stringify(errorOutput));
        process.exit(1);
    }
}

// 执行主函数
main().catch(error => {
    FORCE_LOG('[ChatRoomViewer] Fatal error in main():', error);
    process.exit(1);
});