// main.js - Electron 主进程

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, shell, clipboard, net, nativeImage } = require('electron'); // Added net and nativeImage
const path = require('path');
const fs = require('fs-extra'); // Using fs-extra for convenience
const os = require('os');
const WebSocket = require('ws'); // For VCPLog notifications
const fileManager = require('./modules/fileManager'); // Import the new file manager

// --- Configuration Paths ---
// Data storage will be within the project's 'AppData' directory
const PROJECT_ROOT = __dirname; // __dirname is the directory of main.js
const APP_DATA_ROOT_IN_PROJECT = path.join(PROJECT_ROOT, 'AppData');

const AGENT_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Agents');
const USER_DATA_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'UserData'); // For chat histories and attachments
const SETTINGS_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');

let mainWindow;
let vcpLogWebSocket;
let vcpLogReconnectInterval;
let openChildWindows = [];

// --- Main Window Creation ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: false, // 移除原生窗口框架
        titleBarStyle: 'hidden', // 隐藏标题栏
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,    // 恢复: 开启上下文隔离
            nodeIntegration: false,  // 恢复: 关闭Node.js集成在渲染进程
            spellcheck: true, // Enable spellcheck for input fields
        },
        icon: path.join(__dirname, 'assets', 'icon.png'), // Add an icon
        title: 'VCP AI 聊天客户端',
        show: false, // Don't show until ready
    });

    mainWindow.loadFile('main.html');
    // mainWindow.webContents.openDevTools(); // Uncomment for debugging

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Set application menu (basic example)
    const menuTemplate = [
        {
            label: '文件',
            submenu: [
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '重新加载' },
                { role: 'forceReload', label: '强制重新加载' },
                { role: 'toggleDevTools', label: '切换开发者工具' },
                { type: 'separator' },
                { role: 'resetZoom', label: '重置缩放' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '切换全屏' }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '了解更多关于Electron',
                    click: async () => {
                        await shell.openExternal('https://electronjs.org');
                    }
                }
            ]
        }
    ];
    // const menu = Menu.buildFromTemplate(menuTemplate); // 注释掉原有菜单创建
    // Menu.setApplicationMenu(menu); // 注释掉原有菜单设置
    mainWindow.setMenu(null); // 移除应用程序菜单栏

    // Set dark mode based on system preference, or allow user to toggle
    nativeTheme.themeSource = 'dark'; // Or 'light' or 'system'

    // Listen for window events to notify renderer
    mainWindow.on('maximize', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('window-maximized');
        }
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('window-unmaximized');
        }
    });
}

// --- App Lifecycle ---
app.whenReady().then(() => {
    fs.ensureDirSync(APP_DATA_ROOT_IN_PROJECT); // Ensure the main AppData directory in project exists
    fs.ensureDirSync(AGENT_DIR);
    fs.ensureDirSync(USER_DATA_DIR);
    fileManager.initializeFileManager(USER_DATA_DIR, AGENT_DIR); // Initialize FileManager

    // --- Moved IPC Handler Registration ---
    ipcMain.handle('display-text-content-in-viewer', async (event, textContent, windowTitle, theme) => { // Added theme parameter
        console.log(`[Main Process] Received display-text-content-in-viewer (handle inside whenReady). Title: ${windowTitle}, Theme: ${theme}`);
        const textViewerWindow = new BrowserWindow({
            width: 800,
            height: 700,
            minWidth: 500,
            minHeight: 400,
            title: decodeURIComponent(windowTitle) || '阅读模式',
            parent: mainWindow,
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'), // Can reuse if common functionalities are needed
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true // Enable devtools for easier debugging of the viewer
            },
            icon: path.join(__dirname, 'assets', 'icon.png'),
            show: false
        });

        const viewerUrl = `file://${path.join(__dirname, 'text-viewer.html')}?text=${encodeURIComponent(textContent)}&title=${encodeURIComponent(windowTitle || '阅读模式')}&theme=${encodeURIComponent(theme || 'dark')}`; // Pass theme parameter
        console.log(`[Main Process] Attempting to load URL in text viewer window: ${viewerUrl.substring(0, 200)}...`);
        
        textViewerWindow.webContents.on('did-start-loading', () => {
            console.log(`[Main Process] textViewerWindow webContents did-start-loading for URL: ${viewerUrl.substring(0, 200)}`);
        });

        textViewerWindow.webContents.on('dom-ready', () => {
            console.log(`[Main Process] textViewerWindow webContents dom-ready for URL: ${textViewerWindow.webContents.getURL()}`);
        });
        
        textViewerWindow.loadURL(viewerUrl)
            .then(() => {
                console.log(`[Main Process] textViewerWindow successfully initiated URL loading (loadURL resolved): ${viewerUrl.substring(0, 200)}`);
            })
            .catch((err) => {
                console.error(`[Main Process] textViewerWindow FAILED to initiate URL loading (loadURL rejected): ${viewerUrl.substring(0, 200)}`, err);
            });

        textViewerWindow.webContents.on('did-finish-load', () => {
            console.log(`[Main Process] textViewerWindow webContents did-finish-load for URL: ${textViewerWindow.webContents.getURL()}`);
        });

        textViewerWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error(`[Main Process] textViewerWindow webContents did-fail-load: Code ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`);
        });
        openChildWindows.push(textViewerWindow); // Add to keep track
        
        textViewerWindow.setMenu(null); // No menu for the text viewer window

        textViewerWindow.once('ready-to-show', () => {
            console.log(`[Main Process] textViewerWindow is ready-to-show. Window Title: "${textViewerWindow.getTitle()}". Calling show().`);
            textViewerWindow.show();
            console.log('[Main Process] textViewerWindow show() called.');
        });

        textViewerWindow.on('show', () => {
            console.log('[Main Process] textViewerWindow show event fired. Window is visible.');
        });

        textViewerWindow.on('closed', () => {
            console.log('[Main Process] textViewerWindow has been closed.');
            openChildWindows = openChildWindows.filter(win => win !== textViewerWindow); // Remove from track
        });
    });
    // --- End of Moved IPC Handler Registration ---

    // Notes IPC Handlers
    const NOTES_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'Notes', 'notes.json');
    fs.ensureDirSync(path.dirname(NOTES_FILE)); // Ensure the Notes directory exists

    ipcMain.handle('read-notes', async () => {
        try {
            if (await fs.pathExists(NOTES_FILE)) {
                const notes = await fs.readJson(NOTES_FILE);
                return notes;
            }
            return []; // Default empty array if file doesn't exist
        } catch (error) {
            console.error('读取笔记失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('write-notes', async (event, notes) => {
        try {
            await fs.writeJson(NOTES_FILE, notes, { spaces: 2 });
            return { success: true };
        } catch (error) {
            console.error('保存笔记失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('open-notes-window', async (event, theme) => {
        console.log(`[Main Process] Received open-notes-window (handle inside whenReady). Theme: ${theme}`);
        const notesWindow = new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            title: '我的笔记',
            parent: mainWindow,
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, 'assets', 'icon.png'),
            show: false
        });

        const notesUrl = `file://${path.join(__dirname, 'Notes', 'notes.html')}?theme=${encodeURIComponent(theme || 'dark')}`;
        console.log(`[Main Process] Attempting to load URL in notes window: ${notesUrl.substring(0, 200)}...`);
        
        notesWindow.loadURL(notesUrl)
            .then(() => {
                console.log(`[Main Process] notesWindow successfully initiated URL loading: ${notesUrl.substring(0, 200)}`);
            })
            .catch((err) => {
                console.error(`[Main Process] notesWindow FAILED to initiate URL loading: ${notesUrl.substring(0, 200)}`, err);
            });

        openChildWindows.push(notesWindow);
        notesWindow.setMenu(null);

        notesWindow.once('ready-to-show', () => {
            console.log(`[Main Process] notesWindow is ready-to-show. Window Title: "${notesWindow.getTitle()}". Calling show().`);
            notesWindow.show();
            console.log('[Main Process] notesWindow show() called.');
        });

        notesWindow.on('closed', () => {
            console.log('[Main Process] notesWindow has been closed.');
            openChildWindows = openChildWindows.filter(win => win !== notesWindow);
        });
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    // Disconnect WebSocket on quit
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close();
    }
    if (vcpLogReconnectInterval) {
        clearInterval(vcpLogReconnectInterval);
    }
});

// --- IPC Handlers ---

ipcMain.on('open-external-link', (event, url) => {
  if (url) {
    // 验证 URL 是否是期望的类型，例如 http, https, file
    // 为安全起见，可以只允许 http 和 https
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external link:', err);
        // 可以选择通知用户打开失败
      });
    } else if (url.startsWith('file:')) {
      // 对于文件链接，shell.openExternal 会尝试用系统默认程序打开
      // 如果希望所有文件链接都在外部浏览器打开（如果可能），则逻辑不变
      // 如果有特定类型的文件不想用外部浏览器打开，可以在这里添加判断
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external file link:', err);
      });
    } else {
      console.warn(`[Main Process] Received request to open non-standard link externally, ignoring: ${url}`);
    }
  }
});

// Settings Management
ipcMain.handle('load-settings', async () => {
    try {
        if (await fs.pathExists(SETTINGS_FILE)) {
            const settings = await fs.readJson(SETTINGS_FILE);
            return settings;
        }
        return {}; // Default empty settings
    } catch (error) {
        console.error('加载设置失败:', error);
        return { error: error.message };
    }
});

ipcMain.handle('save-settings', async (event, settings) => {
    try {
        await fs.writeJson(SETTINGS_FILE, settings, { spaces: 2 });
        return { success: true };
    } catch (error) {
        console.error('保存设置失败:', error);
        return { error: error.message };
    }
});

// Agent Management
ipcMain.handle('get-agents', async () => {
    try {
        const agentFolders = await fs.readdir(AGENT_DIR);
        let agents = [];
        for (const folderName of agentFolders) {
            const agentPath = path.join(AGENT_DIR, folderName);
            const stat = await fs.stat(agentPath);
            if (stat.isDirectory()) {
                const configPath = path.join(agentPath, 'config.json');
                const avatarPathPng = path.join(agentPath, 'avatar.png');
                const avatarPathJpg = path.join(agentPath, 'avatar.jpg');
                const avatarPathGif = path.join(agentPath, 'avatar.gif');
                
                let agentData = { id: folderName, name: folderName, avatarUrl: null, config: {} };

                if (await fs.pathExists(configPath)) {
                    const config = await fs.readJson(configPath);
                    agentData.name = config.name || folderName;
                    let topicsArray = config.topics && Array.isArray(config.topics) && config.topics.length > 0
                                       ? config.topics
                                       : [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    
                    if (!config.topics || !Array.isArray(config.topics) || config.topics.length === 0) {
                        try {
                            config.topics = topicsArray;
                            await fs.writeJson(configPath, config, { spaces: 2 });
                        } catch (e) {
                            console.error(`Error saving default/fixed topics for agent ${folderName}:`, e);
                        }
                    }
                    agentData.topics = topicsArray;
                    agentData.config = config;
                } else {
                    agentData.name = folderName;
                    agentData.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    const defaultConfigData = {
                        name: agentData.name,
                        topics: agentData.topics,
                        systemPrompt: `你是 ${agentData.name}。`,
                        model: '',
                        temperature: 0.7,
                        contextTokenLimit: 4000,
                        maxOutputTokens: 1000
                    };
                    try {
                        await fs.ensureDir(agentPath);
                        await fs.writeJson(configPath, defaultConfigData, { spaces: 2 });
                        agentData.config = defaultConfigData;
                    } catch (e) {
                        console.error(`Error creating default config for agent ${folderName}:`, e);
                    }
                }
                
                if (await fs.pathExists(avatarPathPng)) {
                    agentData.avatarUrl = `file://${avatarPathPng}`;
                } else if (await fs.pathExists(avatarPathJpg)) {
                    agentData.avatarUrl = `file://${avatarPathJpg}`;
                } else if (await fs.pathExists(avatarPathGif)) {
                    agentData.avatarUrl = `file://${avatarPathGif}`;
                }
                agents.push(agentData);
            }
        }

        // Apply saved order if it exists
        let settings = {};
        try {
            if (await fs.pathExists(SETTINGS_FILE)) {
                settings = await fs.readJson(SETTINGS_FILE);
            }
        } catch (readError) {
            console.warn('Could not read settings file for agent order:', readError);
        }

        if (settings.agentOrder && Array.isArray(settings.agentOrder)) {
            const orderedAgents = [];
            const agentMap = new Map(agents.map(agent => [agent.id, agent]));
            settings.agentOrder.forEach(id => {
                if (agentMap.has(id)) {
                    orderedAgents.push(agentMap.get(id));
                    agentMap.delete(id); // Remove from map to handle agents not in order array
                }
            });
            // Add any agents not in the order array to the end
            orderedAgents.push(...agentMap.values());
            agents = orderedAgents;
        } else {
            // Default sort by name if no order is saved
            agents.sort((a, b) => a.name.localeCompare(b.name));
        }
        return agents;
    } catch (error) {
        console.error('获取Agent列表失败:', error);
        return { error: error.message };
    }
});

ipcMain.handle('save-agent-order', async (event, orderedAgentIds) => {
    console.log('[Main IPC] Received save-agent-order with IDs:', orderedAgentIds);
    try {
        let settings = {};
        try {
            if (await fs.pathExists(SETTINGS_FILE)) {
                const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
                settings = JSON.parse(data);
            }
        } catch (readError) {
            if (readError.code !== 'ENOENT') {
                console.error('Failed to read settings file for saving agent order:', readError);
                return { success: false, error: '读取设置文件失败' };
            }
            console.log('Settings file not found, will create a new one for agent order.');
        }

        settings.agentOrder = orderedAgentIds; // Store the order of agent IDs

        await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        console.log('Agent order saved successfully to:', SETTINGS_FILE);
        return { success: true };
    } catch (error) {
        console.error('Error saving agent order:', error);
        return { success: false, error: error.message || '保存Agent顺序时发生未知错误' };
    }
});

ipcMain.handle('save-topic-order', async (event, agentId, orderedTopicIds) => {
    console.log(`[Main IPC] Received save-topic-order for agent ${agentId} with Topic IDs:`, orderedTopicIds);
    if (!agentId || !Array.isArray(orderedTopicIds)) {
        return { success: false, error: '无效的 agentId 或 topic IDs' };
    }

    const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
    try {
        let agentConfig = {};
        try {
            const data = await fs.readFile(agentConfigPath, 'utf-8');
            agentConfig = JSON.parse(data);
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                 console.error(`Agent config file not found for ID ${agentId} at ${agentConfigPath}`);
                return { success: false, error: `Agent配置文件 ${agentId} 未找到` };
            }
            console.error(`Failed to read agent config file ${agentConfigPath}:`, readError);
            return { success: false, error: '读取Agent配置文件失败' };
        }

        if (!Array.isArray(agentConfig.topics)) {
            agentConfig.topics = [];
        }

        const newTopicsArray = [];
        const topicMap = new Map(agentConfig.topics.map(topic => [topic.id, topic]));

        orderedTopicIds.forEach(id => {
            if (topicMap.has(id)) {
                newTopicsArray.push(topicMap.get(id));
                topicMap.delete(id); // Remove from map to handle topics not in ordered list
            } else {
                console.warn(`Topic ID ${id} from ordered list not found in agent ${agentId}'s config.topics.`);
            }
        });
        
        // Add any topics not in the ordered list to the end
        newTopicsArray.push(...topicMap.values());
        
        agentConfig.topics = newTopicsArray;

        await fs.writeFile(agentConfigPath, JSON.stringify(agentConfig, null, 2));
        console.log(`Topic order for agent ${agentId} saved successfully to: ${agentConfigPath}`);
        return { success: true };
    } catch (error) {
        console.error(`Error saving topic order for agent ${agentId}:`, error);
        return { success: false, error: error.message || `保存Agent ${agentId} 的话题顺序时发生未知错误` };
    }
});

ipcMain.handle('get-agent-config', async (event, agentId) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (await fs.pathExists(configPath)) {
            return await fs.readJson(configPath);
        }
        return {}; // Default empty config
    } catch (error) {
        console.error(`获取Agent ${agentId} 配置失败:`, error);
        return { error: error.message };
    }
});

ipcMain.handle('save-agent-config', async (event, agentId, config) => {
    try {
        const agentDir = path.join(AGENT_DIR, agentId);
        await fs.ensureDir(agentDir);
        const configPath = path.join(agentDir, 'config.json');
        
        // Ensure existing config is loaded if we are partially updating
        let existingConfig = {};
        if (await fs.pathExists(configPath)) {
            existingConfig = await fs.readJson(configPath);
        }
        
        const newConfigData = { ...existingConfig, ...config }; // Merge, new config values overwrite old
        
        await fs.writeJson(configPath, newConfigData, { spaces: 2 });
        return { success: true, message: `Agent ${agentId} 配置已保存。` };
    } catch (error) {
        console.error(`保存Agent ${agentId} 配置失败:`, error);
        return { error: error.message };
    }
});

ipcMain.handle('save-agent-topic-title', async (event, agentId, topicId, newTitle) => {
    if (!topicId || !newTitle) {
        return { error: "保存话题标题失败: topicId 或 newTitle 未提供。" };
    }
    try {
        const agentDir = path.join(AGENT_DIR, agentId);
        const configPath = path.join(agentDir, 'config.json');
        if (!await fs.pathExists(configPath)) {
            return { error: `保存话题标题失败: Agent ${agentId} 的配置文件不存在。` };
        }
        let config = await fs.readJson(configPath);
        
        if (!config.topics || !Array.isArray(config.topics)) {
             return { error: `保存话题标题失败: Agent ${agentId} 没有话题列表。` };
        }

        const topicIndex = config.topics.findIndex(t => t.id === topicId);

        if (topicIndex === -1) {
            return { error: `保存话题标题失败: Agent ${agentId} 中未找到 ID 为 ${topicId} 的话题。` };
        }

        config.topics[topicIndex].name = newTitle;
        await fs.writeJson(configPath, config, { spaces: 2 });
        return { success: true, topics: config.topics }; // Return updated topics array
    } catch (error) {
        console.error(`保存Agent ${agentId} 话题 ${topicId} 标题为 "${newTitle}" 失败:`, error);
        return { error: error.message };
    }
});

ipcMain.handle('select-avatar', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择头像文件',
        properties: ['openFile'],
        filters: [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif'] }
        ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('save-avatar', async (event, agentId, avatarData) => { // avatarData is { name, type, buffer (ArrayBuffer) }
    try {
        if (!avatarData || !avatarData.name || !avatarData.type || !avatarData.buffer) {
            console.error(`保存Agent ${agentId} 头像失败: avatarData 无效 (值为: ${JSON.stringify(avatarData)})`);
            return { error: '保存头像失败：未提供有效的头像数据。' };
        }

        const agentDir = path.join(AGENT_DIR, agentId);
        await fs.ensureDir(agentDir);

        // Determine extension from MIME type or filename
        let ext = path.extname(avatarData.name).toLowerCase();
        if (!ext) { // If no extension in name, try to infer from MIME type
            if (avatarData.type === 'image/png') ext = '.png';
            else if (avatarData.type === 'image/jpeg') ext = '.jpg';
            else if (avatarData.type === 'image/gif') ext = '.gif';
            else if (avatarData.type === 'image/webp') ext = '.webp';
            else {
                console.warn(`无法从类型 ${avatarData.type} 和名称 ${avatarData.name} 推断头像扩展名。`);
                return { error: '保存头像失败：无法确定文件扩展名。' };
            }
        }
        
        // Validate extension
        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        if (!allowedExtensions.includes(ext)) {
            return { error: `保存头像失败：不支持的文件类型/扩展名 "${ext}"。` };
        }

        // Remove old avatars first
        const oldAvatarPng = path.join(agentDir, 'avatar.png');
        const oldAvatarJpg = path.join(agentDir, 'avatar.jpg');
        const oldAvatarGif = path.join(agentDir, 'avatar.gif');
        const oldAvatarWebp = path.join(agentDir, 'avatar.webp');
        if (await fs.pathExists(oldAvatarPng)) await fs.remove(oldAvatarPng);
        if (await fs.pathExists(oldAvatarJpg)) await fs.remove(oldAvatarJpg);
        if (await fs.pathExists(oldAvatarGif)) await fs.remove(oldAvatarGif);
        if (await fs.pathExists(oldAvatarWebp)) await fs.remove(oldAvatarWebp);

        const newAvatarPath = path.join(agentDir, `avatar${ext}`);
        const nodeBuffer = Buffer.from(avatarData.buffer); // Convert ArrayBuffer to Node.js Buffer

        await fs.writeFile(newAvatarPath, nodeBuffer);
        console.log(`Agent ${agentId} 的头像已保存到: ${newAvatarPath}`);
        return { success: true, avatarUrl: `file://${newAvatarPath}` };
    } catch (error) {
        console.error(`保存Agent ${agentId} 头像失败:`, error);
        return { error: `保存头像失败: ${error.message}` };
    }
});

ipcMain.handle('create-agent', async (event, agentName, initialConfig = null) => {
    try {
        // Generate a safe folder name
        const baseName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const agentId = `${baseName}_${Date.now()}`;
        const agentDir = path.join(AGENT_DIR, agentId);

        if (await fs.pathExists(agentDir)) {
            // Should be rare with timestamp, but good to check
            return { error: 'Agent文件夹已存在（ID冲突）。' };
        }
        await fs.ensureDir(agentDir);

        let configToSave;
        if (initialConfig) {
            configToSave = { ...initialConfig, name: agentName }; // Ensure new name is set
        } else {
            configToSave = {
                name: agentName,
                systemPrompt: `你是 ${agentName}。`,
                model: 'gemini-2.5-flash-preview-05-20', // Default model pre-filled
                temperature: 0.7,
                contextTokenLimit: 1000000, // Default context token limit increased
                maxOutputTokens: 60000, // Default max output tokens increased
                topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }] // Default topic
                // topicTitle: "" // Replaced by topics array
            };
        }
        // Ensure 'topics' array exists and has at least one item if using initialConfig
        if (initialConfig) {
            if (!initialConfig.topics || !Array.isArray(initialConfig.topics) || initialConfig.topics.length === 0) {
                configToSave.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
            } else {
                configToSave.topics = initialConfig.topics; // Use provided topics
            }
        }

        await fs.writeJson(path.join(agentDir, 'config.json'), configToSave, { spaces: 2 });
        
        // Create history file for the first (or default) topic
        if (configToSave.topics && configToSave.topics.length > 0) {
            const firstTopicId = configToSave.topics[0].id || "default";
            const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', firstTopicId);
            await fs.ensureDir(topicHistoryDir);
            const historyFilePath = path.join(topicHistoryDir, 'history.json');
            if (!await fs.pathExists(historyFilePath)) {
                 await fs.writeJson(historyFilePath, [], { spaces: 2 });
            }
        }
        
        // If initialConfig provided an avatar path (e.g. from a source agent), copy it.
        // This needs careful handling: initialConfig.avatarPath (original file path) vs avatarUrl (file://)
        // For simplicity, we'll skip copying avatar during context creation for now. User can set it.
        // If initialConfig contained an avatarUrl, it won't be directly usable unless we copy the file.

        return { success: true, agentId: agentId, agentName: agentName, config: configToSave, avatarUrl: null };
    } catch (error) {
        console.error('创建Agent失败:', error);
        return { error: error.message };
    }
});

ipcMain.handle('delete-agent', async (event, agentId) => {
    try {
        const agentDir = path.join(AGENT_DIR, agentId);
        const userDataAgentDir = path.join(USER_DATA_DIR, agentId);
        if (await fs.pathExists(agentDir)) {
            await fs.remove(agentDir);
        }
        if (await fs.pathExists(userDataAgentDir)) {
            await fs.remove(userDataAgentDir);
        }
        return { success: true, message: `Agent ${agentId} 已删除。` };
    } catch (error) {
        console.error(`删除Agent ${agentId} 失败:`, error);
        return { error: error.message };
    }
});

// 新增：处理从 preload 过来的读取剪贴板图片请求
ipcMain.handle('read-image-from-clipboard-main', async () => {
    console.log('[Main Process] Received request to read image from clipboard.');
    try {
        const nativeImage = clipboard.readImage(); // 在主进程中使用 clipboard
        if (nativeImage && !nativeImage.isEmpty()) {
            console.log('[Main Process] NativeImage is not empty.');
            const buffer = nativeImage.toPNG();
            if (buffer && buffer.length > 0) {
                console.log('[Main Process] Conversion to PNG successful.');
                return { success: true, data: buffer.toString('base64'), extension: 'png' };
            } else {
                console.warn('[Main Process] Conversion to PNG resulted in empty buffer.');
                return { success: false, error: 'Conversion to PNG resulted in empty buffer.' };
            }
        } else if (nativeImage && nativeImage.isEmpty()) {
            console.warn('[Main Process] NativeImage is empty. No image on clipboard or unsupported format.');
            return { success: false, error: 'No image on clipboard or unsupported format.' };
        } else {
            console.warn('[Main Process] clipboard.readImage() returned null or undefined.');
            return { success: false, error: 'Failed to read image from clipboard (readImage returned null/undefined).' };
        }
    } catch (error) {
        console.error('[Main Process] Error reading image from clipboard:', error);
        return { success: false, error: error.message };
    }
});

// Chat History Management
ipcMain.handle('get-chat-history', async (event, agentId, topicId) => {
    if (!topicId) {
        const errorMessage = `获取Agent ${agentId} 聊天历史失败: topicId 未提供。`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
    try {
        const historyFile = path.join(USER_DATA_DIR, agentId, 'topics', topicId, 'history.json');
        await fs.ensureDir(path.dirname(historyFile)); // Ensure topic directory exists

        if (await fs.pathExists(historyFile)) {
            const history = await fs.readJson(historyFile);
            return history;
        }
        return []; // Default empty history if file doesn't exist
    } catch (error) {
        console.error(`获取Agent ${agentId} 话题 ${topicId} 聊天历史失败:`, error);
        return { error: error.message };
    }
});

ipcMain.handle('save-chat-history', async (event, agentId, topicId, history) => {
    if (!topicId) {
        const errorMessage = `保存Agent ${agentId} 聊天历史失败: topicId 未提供。`;
        console.error(errorMessage);
        return { error: errorMessage };
    }
    try {
        const historyDir = path.join(USER_DATA_DIR, agentId, 'topics', topicId);
        await fs.ensureDir(historyDir);
        const historyFile = path.join(historyDir, 'history.json');
        await fs.writeJson(historyFile, history, { spaces: 2 });
        return { success: true };
    } catch (error) {
        console.error(`保存Agent ${agentId} 话题 ${topicId} 聊天历史失败:`, error);
        return { error: error.message };
    }
});

// New IPC handler to get topics for an agent
ipcMain.handle('get-agent-topics', async (event, agentId) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (await fs.pathExists(configPath)) {
            const config = await fs.readJson(configPath);
            // Ensure topics array exists and is not empty
            if (config.topics && Array.isArray(config.topics) && config.topics.length > 0) {
                return config.topics;
            } else { // Config exists but topics array is missing or empty, create/fix default and save
                const defaultTopics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                config.topics = defaultTopics;
                await fs.writeJson(configPath, config, { spaces: 2 });
                return defaultTopics;
            }
        } else { // Config file doesn't exist, this case should ideally be handled by get-agents creating a default config
            console.warn(`Config file not found for agent ${agentId} in get-agent-topics. Attempting to use default.`);
            // This implies an issue if get-agents didn't create a config.
            // For robustness, return a default, but this indicates a potential prior setup issue.
            return [{ id: "default", name: "主要对话", createdAt: Date.now() }];
        }
    } catch (error) {
        console.error(`获取Agent ${agentId} 话题列表失败:`, error);
        // Return a default topic array in case of error to prevent renderer issues
        return [{ id: "default", name: "主要对话", createdAt: Date.now(), error: error.message }];
    }
});

// New IPC handler to create a new topic for an agent
ipcMain.handle('create-new-topic-for-agent', async (event, agentId, topicName, refreshTimestamp = false) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (!await fs.pathExists(configPath)) {
            return { error: `Agent ${agentId} 的配置文件不存在。` };
        }
        const config = await fs.readJson(configPath);
        if (!config.topics || !Array.isArray(config.topics)) {
            config.topics = []; // Initialize if not present or not an array
        }

        const newTopicId = `topic_${Date.now()}`;
        // Use current time if refreshTimestamp is true, otherwise keep existing logic (which implies new topic gets current time anyway)
        // The key difference is that for a "branch", we explicitly want a *new* timestamp.
        const createdAt = refreshTimestamp ? Date.now() : Date.now(); // Effectively always Date.now() for new topics, but explicit for branching.
        const newTopic = { id: newTopicId, name: topicName || `新话题 ${config.topics.length + 1}`, createdAt: createdAt };
        config.topics.push(newTopic);
        await fs.writeJson(configPath, config, { spaces: 2 });

        // Create directory and empty history file for the new topic
        const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', newTopicId);
        await fs.ensureDir(topicHistoryDir);
        await fs.writeJson(path.join(topicHistoryDir, 'history.json'), [], { spaces: 2 });

        return { success: true, topicId: newTopicId, topicName: newTopic.name, topics: config.topics };
    } catch (error) {
        console.error(`为Agent ${agentId} 创建新话题失败:`, error);
        return { error: error.message };
    }
});

ipcMain.handle('delete-topic', async (event, agentId, topicIdToDelete) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (!await fs.pathExists(configPath)) {
            return { error: `Agent ${agentId} 的配置文件不存在。` };
        }
        let config = await fs.readJson(configPath);
        if (!config.topics || !Array.isArray(config.topics)) {
            return { error: `Agent ${agentId} 没有话题列表可供删除。` };
        }

        const initialTopicCount = config.topics.length;
        config.topics = config.topics.filter(topic => topic.id !== topicIdToDelete);

        if (config.topics.length === initialTopicCount) {
            // This means the topicIdToDelete was not found
            console.warn(`Attempted to delete non-existent topic ${topicIdToDelete} from agent ${agentId}`);
            // It's not strictly an error if the goal is "ensure this topic doesn't exist",
            // but good to be aware. We can return success as the state is achieved.
            // However, to inform the renderer that no actual change to list happened, an error might be better.
            // For now, let's treat it as "topic not found to delete".
            return { error: `未找到要删除的话题 ID: ${topicIdToDelete}` };
        }

        // Ensure agent always has at least one topic. If all are deleted, add a new default.
        if (config.topics.length === 0) {
            const defaultTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
            config.topics.push(defaultTopic);
            // Also create history for this new default topic
            const defaultTopicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', defaultTopic.id);
            await fs.ensureDir(defaultTopicHistoryDir);
            await fs.writeJson(path.join(defaultTopicHistoryDir, 'history.json'), [], { spaces: 2 });
        }

        await fs.writeJson(configPath, config, { spaces: 2 });

        // Delete the topic's data directory
        const topicDataDir = path.join(USER_DATA_DIR, agentId, 'topics', topicIdToDelete);
        if (await fs.pathExists(topicDataDir)) {
            await fs.remove(topicDataDir);
        }

        return { success: true, remainingTopics: config.topics };
    } catch (error) {
        console.error(`删除Agent ${agentId} 的话题 ${topicIdToDelete} 失败:`, error);
        return { error: error.message };
    }
});

// File Handling for Chat
ipcMain.handle('handle-file-paste', async (event, agentId, topicId, fileData) => {
    if (!topicId) {
        return { error: "处理文件粘贴失败: topicId 未提供。" };
    }
    // fileData could be { type: 'path', path: '...' } or { type: 'base64', data: '...', extension: 'png' }
    try {
        let storedFileObject;
        if (fileData.type === 'path') {
            const originalFileName = path.basename(fileData.path);
            // Infer type from extension for better storage, though fileManager might refine this
            const ext = path.extname(fileData.path).toLowerCase();
            let fileTypeHint = 'application/octet-stream';
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileTypeHint = `image/${ext.substring(1)}`;
            else if (['.mp3', '.wav', '.ogg'].includes(ext)) fileTypeHint = `audio/${ext.substring(1)}`;

            storedFileObject = await fileManager.storeFile(fileData.path, originalFileName, agentId, topicId, fileTypeHint);
        } else if (fileData.type === 'base64') {
            const originalFileName = `pasted_image_${Date.now()}.${fileData.extension || 'png'}`;
            const buffer = Buffer.from(fileData.data, 'base64');
            const fileTypeHint = `image/${fileData.extension || 'png'}`;
            storedFileObject = await fileManager.storeFile(buffer, originalFileName, agentId, topicId, fileTypeHint);
        } else {
            throw new Error('不支持的文件粘贴类型');
        }
        // Return the full attachment object from fileManager
        return { success: true, attachment: storedFileObject };
    } catch (error) {
        console.error('处理粘贴文件失败:', error);
        return { error: error.message };
    }
});

ipcMain.handle('select-files-to-send', async (event, agentId, topicId) => { // Added agentId and topicId
    if (!agentId || !topicId) {
        console.error('[Main - select-files-to-send] Agent ID or Topic ID not provided.');
        return { error: "Agent ID and Topic ID are required to select files." };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择要发送的文件',
        properties: ['openFile', 'multiSelections']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const storedFilesInfo = [];
        for (const filePath of result.filePaths) {
            try {
                const originalName = path.basename(filePath);
                // Infer type from extension
                const ext = path.extname(filePath).toLowerCase();
                let fileTypeHint = 'application/octet-stream';
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileTypeHint = `image/${ext.substring(1)}`;
                else if (['.mp3', '.wav', '.ogg'].includes(ext)) fileTypeHint = `audio/${ext.substring(1)}`;
                // Add more types as needed (pdf, txt, docx etc.)

                const storedFile = await fileManager.storeFile(filePath, originalName, agentId, topicId, fileTypeHint);
                storedFilesInfo.push(storedFile);
            } catch (error) {
                console.error(`[Main - select-files-to-send] Error storing file ${filePath}:`, error);
                // Optionally, inform renderer about partial failure
                storedFilesInfo.push({ name: path.basename(filePath), error: error.message });
            }
        }
        return { success: true, attachments: storedFilesInfo };
    }
    return { success: false, attachments: [] }; // Indicate no files selected or dialog cancelled
});

// IPC handler to get file content as Base64
ipcMain.handle('get-file-as-base64', async (event, filePath) => {
    try {
        console.log(`[Main - get-file-as-base64] Received request for filePath: "${filePath}"`);
        if (!filePath || typeof filePath !== 'string') {
            console.error('[Main - get-file-as-base64] Invalid file path received:', filePath);
            throw new Error('Invalid file path provided.');
        }
        
        const cleanPath = filePath.startsWith('file://') ? filePath.substring(7) : filePath;
        console.log(`[Main - get-file-as-base64] Cleaned path: "${cleanPath}"`);
        
        if (!await fs.pathExists(cleanPath)) {
            console.error(`[Main - get-file-as-base64] File not found at path: ${cleanPath}`);
            throw new Error(`File not found at path: ${cleanPath}`);
        }
        
        console.log(`[Main - get-file-as-base64] Reading file: ${cleanPath}`);
        const fileBuffer = await fs.readFile(cleanPath);
        const base64String = fileBuffer.toString('base64');
        console.log(`[Main - get-file-as-base64] Successfully converted "${cleanPath}" to Base64, length: ${base64String.length}`);
        return base64String;
    } catch (error) {
        console.error(`[Main - get-file-as-base64] Error processing path "${filePath}":`, error.message);
        return { error: `获取文件Base64失败: ${error.message}` };
    }
});

// IPC handler to get text content from a file
ipcMain.handle('get-text-content', async (event, filePath, fileType) => {
    try {
        console.log(`[Main - get-text-content] Received request for filePath: "${filePath}", type: "${fileType}"`);
        // filePath here is expected to be an internal file:// URL
        if (!filePath || !filePath.startsWith('file://')) {
            throw new Error('Invalid internal file path provided for text content extraction.');
        }
        const textContent = await fileManager.getTextContent(filePath, fileType);
        if (textContent === null) {
            // This case means fileManager determined it's not a supported text type or failed silently
            return { error: `不支持的文件类型 (${fileType}) 或无法提取文本内容。` };
        }
        return { success: true, textContent: textContent };
    } catch (error) {
        console.error(`[Main - get-text-content] Error extracting text for path "${filePath}":`, error);
        return { error: `提取文本内容失败: ${error.message}` };
    }
});

// IPC Handler for long text paste to be saved as a file
ipcMain.handle('handle-text-paste-as-file', async (event, agentId, topicId, textContent) => {
    if (!agentId || !topicId) {
        return { error: "处理长文本粘贴失败: agentId 或 topicId 未提供。" };
    }
    if (typeof textContent !== 'string') {
        return { error: "处理长文本粘贴失败: 无效的文本内容。" };
    }

    try {
        const originalFileName = `pasted_text_${Date.now()}.txt`;
        const buffer = Buffer.from(textContent, 'utf8');
        const fileTypeHint = 'text/plain';
        
        console.log(`[Main - handle-text-paste-as-file] Storing long text for Agent: ${agentId}, Topic: ${topicId}, Name: ${originalFileName}`);
        const storedFileObject = await fileManager.storeFile(buffer, originalFileName, agentId, topicId, fileTypeHint);
        
        return { success: true, attachment: storedFileObject };
    } catch (error) {
        console.error('[Main - handle-text-paste-as-file] 长文本转存为文件失败:', error);
        return { error: `长文本转存为文件失败: ${error.message}` };
    }
});

// IPC Handler for dropped files
ipcMain.handle('handle-file-drop', async (event, agentId, topicId, droppedFilesData) => {
    if (!agentId || !topicId) {
        return { error: "处理文件拖放失败: agentId 或 topicId 未提供。" };
    }
    if (!Array.isArray(droppedFilesData) || droppedFilesData.length === 0) {
        return { error: "处理文件拖放失败: 未提供文件数据。" };
    }

    const storedFilesInfo = [];
    for (const fileData of droppedFilesData) {
        try {
            if (!fileData.data || !fileData.name || !fileData.type) { // Now expect 'data' (Buffer) instead of 'path'
                console.warn('[Main - handle-file-drop] Skipping a dropped file due to missing data, name, or type. fileData:', JSON.stringify(fileData));
                storedFilesInfo.push({ name: fileData.name || '未知文件（数据缺失）', error: '文件内容、名称或类型缺失' });
                continue;
            }
            
            const fileTypeHint = fileData.type; // Use the type provided by FileReader
            
            console.log(`[Main - handle-file-drop] Attempting to store dropped file: ${fileData.name} (Type: ${fileData.type}, Size: ${fileData.size}) for Agent: ${agentId}, Topic: ${topicId}`);
            // Ensure fileData.data is a Buffer before passing to fileManager.storeFile
            const fileBuffer = Buffer.isBuffer(fileData.data) ? fileData.data : Buffer.from(fileData.data);
            
            console.log(`[Main - handle-file-drop] Calling fileManager.storeFile with buffer for ${fileData.name}, size: ${fileBuffer.length}`);
            const storedFile = await fileManager.storeFile(fileBuffer, fileData.name, agentId, topicId, fileTypeHint);
            storedFilesInfo.push({ success: true, attachment: storedFile, name: fileData.name });
        } catch (error) {
            console.error(`[Main - handle-file-drop] Error storing dropped file ${fileData.name || 'unknown'}:`, error);
            console.error(`[Main - handle-file-drop] Full error details:`, error.stack);
            storedFilesInfo.push({ name: fileData.name || '未知文件', error: error.message });
        }
    }
    return storedFilesInfo; // Return array of results
});
 
 
// VCP Server Communication
ipcMain.handle('send-to-vcp', async (event, vcpUrl, vcpApiKey, messages, modelConfig, messageId) => { // Added messageId
    console.log(`[Main - sendToVCP] ***** sendToVCP HANDLER EXECUTED for messageId: ${messageId} *****`); // UNIQUE ENTRY LOG
    try {
        console.log(`发送到VCP服务器: ${vcpUrl} for messageId: ${messageId}`); // Log messageId
        console.log('VCP API Key:', vcpApiKey ? '已设置' : '未设置');
        // Log messages, abbreviating base64 data if present
        console.log('发送到VCP的消息 (messagesForVCP):', JSON.stringify(messages, (key, value) => {
            if (key === 'url' && typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,')) {
                const parts = value.split(';base64,');
                const base64Part = parts[1];
                if (base64Part.length > 200) { // Increased threshold for Data URLs
                    return `${parts[0]};base64,${base64Part.substring(0, 50)}...[Base64, length: ${base64Part.length}]...${base64Part.substring(base64Part.length - 50)}`;
                }
            } else if (key === 'data' && typeof value === 'string' && value.length > 100) { // Existing check for direct 'data' field
                return `${value.substring(0, 50)}...[Base64 Data, length: ${value.length}]...${value.substring(value.length - 50)}`;
            } else if (key === 'text_content' && typeof value === 'string' && value.length > 200) { // For potentially long extracted text
                return `${value.substring(0, 100)}...[Text, length: ${value.length}]`;
            }
            return value;
        }, 2));
        console.log('模型配置:', modelConfig);

        const response = await fetch(vcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${vcpApiKey}`
            },
            body: JSON.stringify({
                messages: messages,
                model: modelConfig.model,
                temperature: modelConfig.temperature,
                stream: modelConfig.stream === true // Explicitly pass stream preference
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Main - sendToVCP] VCP请求失败. Status: ${response.status}, Response Text:`, errorText);
            let errorData = { message: `服务器返回状态 ${response.status}`, details: errorText }; // Default error data
            try {
                const parsedError = JSON.parse(errorText);
                // If parsedError is an object and has more specific fields, use them
                if (typeof parsedError === 'object' && parsedError !== null) {
                    errorData = parsedError; // Use the parsed JSON object as the error data
                     console.error('[Main - sendToVCP] Parsed VCP Error Object:', errorData);
                }
            } catch (e) {
                console.warn('[Main - sendToVCP] VCP错误响应体不是有效的JSON:', e);
                // errorData remains as { message: ..., details: errorText }
            }
            
            const errorMessageToPropagate = `VCP请求失败: ${response.status} - ${errorData.message || errorData.error || (typeof errorData === 'string' ? errorData : '未知服务端错误')}`;
            console.error('[Main - sendToVCP] Propagating error:', errorMessageToPropagate, 'Full errorData:', errorData);

            if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('vcp-stream-chunk', { type: 'error', error: errorMessageToPropagate, details: errorData, messageId: messageId });
                return { streamError: true, errorDetail: errorData };
            }
            // For non-streaming, we will throw, but let's make sure the error object is rich
            const err = new Error(errorMessageToPropagate);
            err.details = errorData; // Attach the full error object
            err.status = response.status;
            throw err;
        }

        if (modelConfig.stream === true) {
            console.log('VCP响应: 开始流式处理');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            async function processStream() {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            console.log(`VCP流结束 for messageId: ${messageId}`);
                            event.sender.send('vcp-stream-chunk', { type: 'end', messageId: messageId });
                            break;
                        }
                        const chunkString = decoder.decode(value, { stream: true });
                        // console.log('VCP流数据块:', chunkString); // Can be very verbose
                        // VCP通常以 Server-Sent Events (SSE) 格式发送流数据
                        // 例如: data: {"id":"chatcmpl-xxxx","object":"chat.completion.chunk","created":1677652288,"model":"gpt-3.5-turbo-0613","choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}
                        // 我们需要解析这些行
                        const lines = chunkString.split('\n').filter(line => line.trim() !== '');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData === '[DONE]') {
                                    console.log(`VCP流明确[DONE] for messageId: ${messageId}`);
                                    event.sender.send('vcp-stream-chunk', { type: 'end', messageId: messageId });
                                    return; // Stream finished
                                }
                                try {
                                    const parsedChunk = JSON.parse(jsonData);
                                    event.sender.send('vcp-stream-chunk', { type: 'data', chunk: parsedChunk, messageId: messageId });
                                } catch (e) {
                                    console.error(`解析VCP流数据块JSON失败 for messageId: ${messageId}:`, e, '原始数据:', jsonData);
                                    // Send raw chunk if parsing fails but it's not [DONE]
                                    event.sender.send('vcp-stream-chunk', { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId });
                                }
                            }
                        }
                    }
                } catch (streamError) {
                    console.error(`VCP流读取错误 for messageId: ${messageId}:`, streamError);
                    event.sender.send('vcp-stream-chunk', { type: 'error', error: `VCP流读取错误: ${streamError.message}`, messageId: messageId });
                } finally {
                    reader.releaseLock();
                }
            }
            processStream(); // Don't await this, let it run in background
            return { streamingStarted: true }; // Indicate to renderer that streaming has begun
        } else {
            console.log('VCP响应: 非流式处理');
            const vcpResponse = await response.json();
            return vcpResponse;
        }

    } catch (error) {
        console.error('VCP请求错误 (catch block):', error);
        // If it's a streaming request and error occurs before stream starts (e.g., network error)
        if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
             event.sender.send('vcp-stream-chunk', { type: 'error', error: `VCP请求错误: ${error.message}`, messageId: messageId }); // Pass messageId here too
             return { streamError: true };
        }
        return { error: `VCP请求错误: ${error.message}` };
    }
});


// VCPLog WebSocket Connection
function connectVcpLog(wsUrl, wsKey) {
    if (!wsUrl || !wsKey) {
        if (mainWindow) mainWindow.webContents.send('vcp-log-status', { status: 'error', message: 'VCPLog URL或KEY未配置。' });
        return;
    }

    const fullWsUrl = `${wsUrl}/VCPlog/VCP_Key=${wsKey}`; // As per Test.Html
    
    if (vcpLogWebSocket && (vcpLogWebSocket.readyState === WebSocket.OPEN || vcpLogWebSocket.readyState === WebSocket.CONNECTING)) {
        console.log('VCPLog WebSocket 已连接或正在连接。');
        return;
    }

    console.log(`尝试连接 VCPLog WebSocket: ${fullWsUrl}`);
    if (mainWindow) mainWindow.webContents.send('vcp-log-status', { status: 'connecting', message: '连接中...' });

    vcpLogWebSocket = new WebSocket(fullWsUrl);

    vcpLogWebSocket.onopen = () => {
        console.log('[MAIN_VCP_LOG] WebSocket onopen event triggered.'); // DEBUG
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            console.log('[MAIN_VCP_LOG] Attempting to send vcp-log-status "open" to renderer.'); // DEBUG
            mainWindow.webContents.send('vcp-log-status', { status: 'open', message: '已连接' });
            console.log('[MAIN_VCP_LOG] vcp-log-status "open" sent.'); // DEBUG
            mainWindow.webContents.send('vcp-log-message', { type: 'connection_ack', message: 'VCPLog 连接成功！' });
        } else {
            console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onopen. Cannot send status.'); // DEBUG
        }
        if (vcpLogReconnectInterval) {
            clearInterval(vcpLogReconnectInterval);
            vcpLogReconnectInterval = null;
        }
    };

    vcpLogWebSocket.onmessage = (event) => {
        console.log('VCPLog 收到消息:', event.data);
        try {
            const data = JSON.parse(event.data.toString()); // Ensure buffer is converted to string
            if (mainWindow) mainWindow.webContents.send('vcp-log-message', data);
        } catch (e) {
            console.error('VCPLog 解析消息失败:', e);
            if (mainWindow) mainWindow.webContents.send('vcp-log-message', { type: 'error', data: `收到无法解析的消息: ${event.data.toString().substring(0,100)}...` });
        }
    };

    vcpLogWebSocket.onclose = (event) => {
        console.log('VCPLog WebSocket 连接已关闭:', event.code, event.reason);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-status', { status: 'closed', message: `连接已断开 (${event.code})` });
        if (!vcpLogReconnectInterval && wsUrl && wsKey) { // Only try to reconnect if not already trying and config exists
            console.log('将在5秒后尝试重连 VCPLog...');
            vcpLogReconnectInterval = setTimeout(() => connectVcpLog(wsUrl, wsKey), 5000);
        }
    };

    vcpLogWebSocket.onerror = (error) => {
        console.error('[MAIN_VCP_LOG] WebSocket onerror event:', error.message); // DEBUG
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('vcp-log-status', { status: 'error', message: `连接错误: ${error.message}` });
        } else {
            console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onerror.'); // DEBUG
        }
        // onclose will likely be called next, which will handle reconnection
    };
}

ipcMain.on('connect-vcplog', (event, { url, key }) => {
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close(); // Close existing before opening new
    }
    if (vcpLogReconnectInterval) {
        clearInterval(vcpLogReconnectInterval);
        vcpLogReconnectInterval = null;
    }
    connectVcpLog(url, key);
});

ipcMain.on('disconnect-vcplog', () => {
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close();
    }
    if (vcpLogReconnectInterval) {
        clearInterval(vcpLogReconnectInterval);
        vcpLogReconnectInterval = null;
    }
    if (mainWindow) mainWindow.webContents.send('vcp-log-status', { status: 'closed', message: '已手动断开' });
    console.log('VCPLog 已手动断开');
});

// --- Window Control IPC Handlers ---
ipcMain.on('minimize-window', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('maximize-window', () => {
    if (mainWindow) {
        mainWindow.maximize();
    }
});

ipcMain.on('unmaximize-window', () => {
    if (mainWindow) {
        mainWindow.unmaximize();
    }
});

ipcMain.on('close-window', () => {
    if (mainWindow) {
        mainWindow.close();
    }
});

ipcMain.on('open-dev-tools', () => {
    console.log('[Main Process] Received open-dev-tools event.'); // DEBUG
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        console.log('[Main Process] Attempting to open detached dev tools.'); // DEBUG
    } else {
        console.error('[Main Process] Cannot open dev tools: mainWindow or webContents is not available or destroyed.'); // DEBUG
        if (!mainWindow) console.error('[Main Process] mainWindow is null or undefined.');
        else if (!mainWindow.webContents) console.error('[Main Process] mainWindow.webContents is null or undefined.');
        else if (mainWindow.webContents.isDestroyed()) console.error('[Main Process] mainWindow.webContents is destroyed.');
    }
});

// IPC Handler for opening image in a new window
ipcMain.on('open-image-in-new-window', (event, imageUrl, imageTitle) => {
    console.log(`[Main Process] Received open-image-in-new-window for URL: ${imageUrl}, Title: ${imageTitle}`);
    const imageViewerWindow = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        title: imageTitle || '图片预览',
        parent: mainWindow, // Optional: make it a child of the main window
        modal: false, // Non-modal
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // Re-use preload for consistency if needed, or omit if not needed for viewer
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true // Enable devtools for the viewer window for debugging
        },
        icon: path.join(__dirname, 'assets', 'icon.png'), // Use the same app icon
        show: false // Don't show until ready
    });

    const viewerUrl = `file://${path.join(__dirname, 'image-viewer.html')}?src=${encodeURIComponent(imageUrl)}&title=${encodeURIComponent(imageTitle || '图片预览')}`;
    console.log(`[Main Process] Loading URL in new window: ${viewerUrl}`);
    imageViewerWindow.loadURL(viewerUrl);
    openChildWindows.push(imageViewerWindow); // Add to keep track
    
    imageViewerWindow.setMenu(null); // No menu for the image viewer window

    imageViewerWindow.once('ready-to-show', () => {
        imageViewerWindow.show();
    });

    // Optional: Handle closure, etc.
    // imageViewerWindow.on('closed', () => {
    //     // Dereference the window object
// IPC Handler for opening text in a new window (Read Mode)
    // });
});

// New IPC Handler for opening the Admin Panel (Now handled by open-external-link)
// ipcMain.handle('open-admin-panel', async (event) => {
//     console.log('[Main Process] Received request to open Admin Panel.');
//     try {
//         const settings = await fs.readJson(SETTINGS_FILE);
//         const vcpServerUrl = settings.vcpServerUrl;
//
//         if (!vcpServerUrl) {
//             dialog.showErrorBox('错误', 'VCP 服务器 URL 未设置。请在全局设置中配置。');
//             return { success: false, error: 'VCP Server URL not set.' };
//         }
//
//         // Extract base URL (protocol + host + port)
//         const urlObj = new URL(vcpServerUrl);
//         const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
//         const adminPanelUrl = `${baseUrl}/AdminPanel/`; // Assuming this is the correct path
//
//         console.log(`[Main Process] Opening Admin Panel URL: ${adminPanelUrl}`);
//
//         const adminPanelWindow = new BrowserWindow({
//             width: 1000,
//             height: 700,
//             minWidth: 800,
//             minHeight: 600,
//             title: 'VCP 服务器管理面板',
//             parent: mainWindow,
//             modal: false,
//             webPreferences: {
//                 preload: path.join(__dirname, 'preload.js'),
//                 contextIsolation: true,
//                 nodeIntegration: false,
//                 devTools: true,
//                 webviewTag: false,
//             },
//             icon: path.join(__dirname, 'assets', 'icon.png'),
//             show: false
//         });
//
//         adminPanelWindow.loadURL(adminPanelUrl)
//             .then(() => {
//                 console.log(`[Main Process] Admin Panel window successfully loaded URL: ${adminPanelUrl}`);
//             })
//             .catch((err) => {
//                 console.error(`[Main Process] Admin Panel window FAILED to load URL: ${adminPanelUrl}`, err);
//                 dialog.showErrorBox('加载失败', `无法加载服务器管理面板: ${err.message}`);
//             });
//
//         openChildWindows.push(adminPanelWindow);
//
//         adminPanelWindow.setMenu(null);
//
//         adminPanelWindow.once('ready-to-show', () => {
//             adminPanelWindow.show();
//         });
//
//         adminPanelWindow.on('closed', () => {
//             console.log('[Main Process] Admin Panel window has been closed.');
//             openChildWindows = openChildWindows.filter(win => win !== adminPanelWindow);
//         });
//
//         return { success: true };
//
//     } catch (error) {
//         console.error('[Main Process] Error opening Admin Panel:', error);
//         dialog.showErrorBox('错误', `打开服务器管理面板失败: ${error.message}`);
//         return { success: false, error: error.message };
//     }
// });


// IPC Handler for showing image context menu
ipcMain.on('show-image-context-menu', (event, imageUrl) => {
    console.log(`[Main Process] Received show-image-context-menu for URL: ${imageUrl}`);
    const template = [
        {
            label: '复制图片',
            click: async () => {
                console.log(`[Main Process] Context menu: "复制图片" clicked for ${imageUrl}`);
                if (!imageUrl || (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:'))) {
                    console.error('[Main Process] Invalid image URL for copying:', imageUrl);
                    dialog.showErrorBox('复制错误', '无效的图片URL。');
                    return;
                }

                try {
                    const request = net.request(imageUrl);
                    let chunks = [];
                    request.on('response', (response) => {
                        response.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                        response.on('end', () => {
                            if (response.statusCode === 200) {
                                const buffer = Buffer.concat(chunks);
                                const image = nativeImage.createFromBuffer(buffer);
                                if (!image.isEmpty()) {
                                    clipboard.writeImage(image);
                                    console.log('[Main Process] Image copied to clipboard successfully.');
                                    // Optionally notify renderer of success, though clipboard is usually silent
                                } else {
                                    console.error('[Main Process] Failed to create native image from buffer or image is empty.');
                                    dialog.showErrorBox('复制失败', '无法从URL创建图片对象。');
                                }
                            } else {
                                console.error(`[Main Process] Failed to download image. Status: ${response.statusCode}`);
                                dialog.showErrorBox('复制失败', `下载图片失败，服务器状态: ${response.statusCode}`);
                            }
                        });
                        response.on('error', (error) => {
                            console.error('[Main Process] Error in image download response:', error);
                            dialog.showErrorBox('复制失败', `下载图片响应错误: ${error.message}`);
                        });
                    });
                    request.on('error', (error) => {
                        console.error('[Main Process] Error making net request for image:', error);
                        dialog.showErrorBox('复制失败', `请求图片失败: ${error.message}`);
                    });
                    request.end();
                } catch (e) {
                    console.error('[Main Process] Exception during image copy process:', e);
                    dialog.showErrorBox('复制失败', `复制过程中发生意外错误: ${e.message}`);
                }
            }
        },
        { type: 'separator' },
        {
            label: '在新标签页中打开图片',
            click: () => {
                shell.openExternal(imageUrl);
            }
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    if (mainWindow) {
        menu.popup({ window: mainWindow });
    } else {
        console.error("[Main Process] Cannot popup image context menu, mainWindow is not available.");
    }
});
