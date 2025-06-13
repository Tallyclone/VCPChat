// main.js - Electron 主进程

const sharp = require('sharp'); // 确保在文件顶部引入

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, shell, clipboard, net, nativeImage, globalShortcut, screen } = require('electron'); // Added screen
// selection-hook for non-clipboard text capture on Windows
let SelectionHook = null;
try {
    if (process.platform === 'win32') {
        SelectionHook = require('selection-hook');
        console.log('selection-hook loaded successfully.');
    } else {
        console.log('selection-hook is only available on Windows, text selection feature will be disabled.');
    }
} catch (error) {
    console.error('Failed to load selection-hook:', error);
}
const path = require('path');
const fs = require('fs-extra'); // Using fs-extra for convenience
const os = require('os');
const WebSocket = require('ws'); // For VCPLog notifications
const { GlobalKeyboardListener } = require('node-global-key-listener');
const fileManager = require('./modules/fileManager'); // Import the new file manager
const groupChat = require('./Groupmodules/groupchat'); // Import the group chat module

// --- Configuration Paths ---
// Data storage will be within the project's 'AppData' directory
const PROJECT_ROOT = __dirname; // __dirname is the directory of main.js
const APP_DATA_ROOT_IN_PROJECT = path.join(PROJECT_ROOT, 'AppData');

const AGENT_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Agents');
const USER_DATA_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'UserData'); // For chat histories and attachments
const SETTINGS_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
const USER_AVATAR_FILE = path.join(USER_DATA_DIR, 'user_avatar.png'); // Standardized user avatar file

// Define a specific agent ID for notes attachments
const NOTES_AGENT_ID = 'notes_attachments_agent';

let mainWindow;
let vcpLogWebSocket;
let vcpLogReconnectInterval;
let openChildWindows = [];
let assistantWindow = null; // Keep track of the assistant window
let assistantBarWindow = null; // Keep track of the assistant bar window
let lastProcessedSelection = ''; // To avoid re-triggering on the same text
let selectionListenerActive = false;
let selectionHookInstance = null; // To hold the instance of SelectionHook
let mouseListener = null; // To hold the global mouse listener instance
let hideBarTimeout = null; // Timer for delayed hiding of the assistant bar


function processSelectedText(selectionData) {
    const selectedText = selectionData.text;
    // If selection is cleared (empty text), hide the bar and stop.
    if (!selectedText || selectedText.trim() === '') {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
        lastProcessedSelection = ''; // Also clear the last processed text
        return;
    }

    // If the same text is selected again and the bar is already visible, do nothing.
    if (selectedText === lastProcessedSelection && assistantBarWindow && assistantBarWindow.isVisible()) {
        return;
    }
    lastProcessedSelection = selectedText;
    console.log('[Main] New text captured:', selectedText);

    if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
        console.error('[Main] Assistant bar window is not available.');
        return;
    }

    let refPoint;

    // Prioritize mouse position from the hook if it's valid (not 0,0)
    if (selectionData.mousePosEnd && (selectionData.mousePosEnd.x > 0 || selectionData.mousePosEnd.y > 0)) {
        refPoint = { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y + 15 };
        console.log('[Main] Using mousePosEnd for positioning:', refPoint);
    // Fallback to the selection rectangle's bottom corner if valid
    } else if (selectionData.endBottom && (selectionData.endBottom.x > 0 || selectionData.endBottom.y > 0)) {
        refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 15 };
        console.log('[Main] Using endBottom for positioning:', refPoint);
    // If hook data is invalid or unavailable, use the global cursor position as the most reliable fallback.
    } else {
        const cursorPos = screen.getCursorScreenPoint();
        refPoint = { x: cursorPos.x, y: cursorPos.y + 15 };
        console.log('[Main] Hook position invalid, falling back to cursor position:', refPoint);
    }
    
    // Ensure the point is scaled correctly for the display
    // Ensure the point is scaled correctly for the display
    const dipPoint = screen.screenToDipPoint(refPoint);

    // Get the bar's width (which is in DIPs) to center it.
    const barWidth = 270; // The width is fixed at creation.
    const finalX = Math.round(dipPoint.x - (barWidth / 2));
    const finalY = Math.round(dipPoint.y);

    setImmediate(() => {
        assistantBarWindow.setPosition(finalX, finalY);
        assistantBarWindow.showInactive(); // Show the window without activating/focusing it

        // Start listening for a global click to hide the bar
        startGlobalMouseListener();

        (async () => {
            try {
                const settings = await fs.readJson(SETTINGS_FILE);
                if (settings.assistantEnabled && settings.assistantAgent) {
                    const agentConfig = await getAgentConfigById(settings.assistantAgent);
                    assistantBarWindow.webContents.send('assistant-bar-data', {
                        agentAvatarUrl: agentConfig.avatarUrl,
                        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                    });
                }
            } catch (error) {
                console.error('[Main] Error sending data to assistant bar:', error);
            }
        })();
    });
}

// --- Global Mouse Listener for Assistant Bar ---
function startGlobalMouseListener() {
    if (mouseListener) {
        return;
    }
    mouseListener = new GlobalKeyboardListener();

    mouseListener.addListener((e, down) => {
        if (e.state === 'DOWN') {
            // Instead of immediate hide, set a timeout.
            // This gives the 'assistant-action' a chance to cancel it if the click was inside.
            if (hideBarTimeout) clearTimeout(hideBarTimeout); // Clear previous timeout if any
            hideBarTimeout = setTimeout(() => {
                console.log(`[Main] Global mouse down triggered hide after timeout. Button: ${e.name}`);
                hideAssistantBarAndStopListener();
            }, 150); // A short delay (e.g., 150ms)
        }
    });
}

function hideAssistantBarAndStopListener() {
    // Clear any pending hide timeout
    if (hideBarTimeout) {
        clearTimeout(hideBarTimeout);
        hideBarTimeout = null;
    }

    // Hide the window
    if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
        assistantBarWindow.hide();
    }
    // Stop and kill the listener
    if (mouseListener) {
        mouseListener.kill();
        mouseListener = null;
        console.log('[Main] Global mouse listener stopped.');
    }
}

// --- Selection Listener ---
function startSelectionListener() {
    if (selectionListenerActive || !SelectionHook) {
        if (!SelectionHook) {
            console.log('[Main] SelectionHook not available on this platform. Listener not started.');
        } else {
            console.log('[Main] Selection listener is already running.');
        }
        return;
    }

    try {
        selectionHookInstance = new SelectionHook();
        selectionHookInstance.on('text-selection', processSelectedText);
        
        selectionHookInstance.on('error', (error) => {
            console.error('Error in SelectionHook:', error);
        });

        if (selectionHookInstance.start({ debug: false })) { // Set debug to true for verbose logging
            selectionListenerActive = true;
            console.log('[Main] selection-hook listener started.');
        } else {
            console.error('[Main] Failed to start selection-hook listener.');
            selectionHookInstance = null;
        }
    } catch (e) {
        console.error('[Main] Failed to instantiate or start selection-hook listener:', e);
        selectionHookInstance = null;
    }
}

function stopSelectionListener() {
    if (!selectionListenerActive || !selectionHookInstance) {
        return;
    }
    try {
        selectionHookInstance.stop();
        console.log('[Main] selection-hook listener stopped.');
    } catch (e) {
        console.error('[Main] Failed to stop selection-hook listener:', e);
    } finally {
        selectionHookInstance = null;
        selectionListenerActive = false;
    }
}


// --- Assistant Bar Window Creation ---
function createAssistantBarWindow() {
    // This function is now an initializer for a reusable, hidden window.
    // It's called once at startup.
    assistantBarWindow = new BrowserWindow({
        width: 270,
        height: 40,
        show: false, // Create hidden
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        focusable: false, // Prevent the window from taking focus
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        }
    });

    assistantBarWindow.loadFile(path.join(__dirname, 'Assistantmodules/assistant-bar.html'));

    assistantBarWindow.once('ready-to-show', async () => {
        // Don't show on ready, just load initial data
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await getAgentConfigById(settings.assistantAgent);
                assistantBarWindow.webContents.send('assistant-bar-data', {
                    agentAvatarUrl: agentConfig.avatarUrl,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                });
            }
        } catch (error) {
            console.error('[Main] Error sending initial data to assistant bar:', error);
        }
    });

    assistantBarWindow.on('blur', () => {
        // Hide the window on blur so it can be reused, instead of closing it.
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
    });

    assistantBarWindow.on('closed', () => {
        // If it's actually closed (e.g., app quit), nullify the variable.
        assistantBarWindow = null;
    });
}


// --- Assistant Window Creation ---
function createAssistantWindow(data) {
    if (assistantWindow && !assistantWindow.isDestroyed()) {
        assistantWindow.focus();
        // Optionally, send new data to the existing window
        assistantWindow.webContents.send('assistant-data', data);
        return;
    }

    assistantWindow = new BrowserWindow({
        width: 450,
        height: 600,
        minWidth: 350,
        minHeight: 400,
        title: '划词助手',
        parent: mainWindow,
        modal: false,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        show: false,
        resizable: true,
        alwaysOnTop: false, // Keep assistant on top
    });

    assistantWindow.loadFile(path.join(__dirname, 'Assistantmodules/assistant.html'));
    
    assistantWindow.once('ready-to-show', () => {
        assistantWindow.show();
        // Send initial data to the window
        assistantWindow.webContents.send('assistant-data', data);
    });

    assistantWindow.on('closed', () => {
        assistantWindow = null;
    });
}

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
    //mainWindow.webContents.openDevTools(); // Uncomment for debugging

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

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

    // Listen for theme changes and notify all relevant windows
    nativeTheme.on('updated', () => {
        const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        console.log(`[Main] Theme updated to: ${theme}. Notifying windows.`);
        
        // Notify main window
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('theme-updated', theme);
        }
        // Notify assistant bar
        if (assistantBarWindow && !assistantBarWindow.isDestroyed()) {
            assistantBarWindow.webContents.send('theme-updated', theme);
        }
        // Notify assistant window
        if (assistantWindow && !assistantWindow.isDestroyed()) {
            assistantWindow.webContents.send('theme-updated', theme);
        }
        // Notify any other open child windows that might need theme updates
        openChildWindows.forEach(win => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('theme-updated', theme);
            }
        });
    });
}

// --- App Lifecycle ---
app.whenReady().then(() => {
        fs.ensureDirSync(APP_DATA_ROOT_IN_PROJECT); // Ensure the main AppData directory in project exists
    fs.ensureDirSync(AGENT_DIR);
    fs.ensureDirSync(USER_DATA_DIR);
    fileManager.initializeFileManager(USER_DATA_DIR, AGENT_DIR); // Initialize FileManager
    groupChat.initializePaths({ APP_DATA_ROOT_IN_PROJECT, AGENT_DIR, USER_DATA_DIR, SETTINGS_FILE }); // Initialize GroupChat paths

// --- Group Chat IPC Handlers ---
    ipcMain.handle('create-agent-group', async (event, groupName, initialConfig) => {
        return await groupChat.createAgentGroup(groupName, initialConfig);
    });
    
    ipcMain.handle('get-agent-groups', async () => {
        return await groupChat.getAgentGroups();
    });
    
    ipcMain.handle('get-agent-group-config', async (event, groupId) => {
        return await groupChat.getAgentGroupConfig(groupId);
    });
    
    ipcMain.handle('save-agent-group-config', async (event, groupId, configData) => {
        return await groupChat.saveAgentGroupConfig(groupId, configData);
    });
    
    ipcMain.handle('delete-agent-group', async (event, groupId) => {
        return await groupChat.deleteAgentGroup(groupId);
    });
    
    ipcMain.handle('save-agent-group-avatar', async (event, groupId, avatarData) => {
        return await groupChat.saveAgentGroupAvatar(groupId, avatarData);
    });
    
    ipcMain.handle('get-group-topics', async (event, groupId, searchTerm) => {
        return await groupChat.getGroupTopics(groupId, searchTerm);
    });
    
    ipcMain.handle('create-new-topic-for-group', async (event, groupId, topicName) => {
        return await groupChat.createNewTopicForGroup(groupId, topicName);
    });
    
    ipcMain.handle('delete-group-topic', async (event, groupId, topicId) => {
        return await groupChat.deleteGroupTopic(groupId, topicId);
    });
    
    ipcMain.handle('save-group-topic-title', async (event, groupId, topicId, newTitle) => {
        return await groupChat.saveGroupTopicTitle(groupId, topicId, newTitle);
    });
    
    ipcMain.handle('get-group-chat-history', async (event, groupId, topicId) => {
        return await groupChat.getGroupChatHistory(groupId, topicId);
    });
    
    ipcMain.handle('save-group-chat-history', async (event, groupId, topicId, history) => {
        if (!groupId || !topicId || !Array.isArray(history)) {
            const errorMsg = `保存群组 ${groupId} 话题 ${topicId} 聊天历史失败: 参数无效。`;
            console.error(errorMsg);
            return { success: false, error: errorMsg };
        }
        try {
            // Construct path similar to getGroupChatHistory in groupchat.js
            const historyDir = path.join(USER_DATA_DIR, groupId, 'topics', topicId);
            await fs.ensureDir(historyDir);
            const historyFile = path.join(historyDir, 'history.json');
            await fs.writeJson(historyFile, history, { spaces: 2 });
            console.log(`[Main IPC] 群组 ${groupId} 话题 ${topicId} 聊天历史已保存到 ${historyFile}`);
            return { success: true };
        } catch (error) {
            console.error(`[Main IPC] 保存群组 ${groupId} 话题 ${topicId} 聊天历史失败:`, error);
            return { success: false, error: error.message };
        }
    });
    
    ipcMain.handle('send-group-chat-message', async (event, groupId, topicId, userMessage) => {
        // The actual VCP call and streaming will be handled within groupChat.handleGroupChatMessage
        // It needs a way to send stream chunks back to the renderer.
        // We'll pass a function to groupChat.handleGroupChatMessage that uses event.sender.send
        console.log(`[Main IPC] Received send-group-chat-message for Group: ${groupId}, Topic: ${topicId}`);
        try {
            const sendStreamChunkToRenderer = (channel, data) => {
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    mainWindow.webContents.send(channel, data);
                }
            };
    
            // Function to get agent config by ID (needed by groupChat module)
            const getAgentConfigById = async (agentId) => {
                const agentDir = path.join(AGENT_DIR, agentId);
                const configPath = path.join(agentDir, 'config.json');
                if (await fs.pathExists(configPath)) {
                    const config = await fs.readJson(configPath);
                    // Construct avatarUrl by checking for file existence, which is more robust
                    const avatarPathPng = path.join(agentDir, 'avatar.png');
                    const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(agentDir, 'avatar.gif');
                    config.avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) {
                        config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathJpg)) {
                        config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathJpeg)) {
                        config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathGif)) {
                        config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
                    }
                    config.id = agentId; // Ensure ID is part of the returned config
                    return config;
                }
                return { error: `Agent config for ${agentId} not found.` };
            };
    
            // Await the group chat handler to ensure any errors within it are caught by this try...catch block.
            await groupChat.handleGroupChatMessage(groupId, topicId, userMessage, sendStreamChunkToRenderer, getAgentConfigById);
            
            return { success: true, message: "Group chat message processing started and completed." };
        } catch (error) {
            console.error(`[Main IPC] Error in send-group-chat-message handler for Group ${groupId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('inviteAgentToSpeak', async (event, groupId, topicId, invitedAgentId) => {
        console.log(`[Main IPC] Received inviteAgentToSpeak for Group: ${groupId}, Topic: ${topicId}, Agent: ${invitedAgentId}`);
        try {
            const sendStreamChunkToRenderer = (channel, data) => {
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    mainWindow.webContents.send(channel, data);
                }
            };

            const getAgentConfigById = async (agentId) => {
                const agentDir = path.join(AGENT_DIR, agentId);
                const configPath = path.join(agentDir, 'config.json');
                if (await fs.pathExists(configPath)) {
                    const config = await fs.readJson(configPath);
                    const avatarPathPng = path.join(agentDir, 'avatar.png');
                    const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(agentDir, 'avatar.gif');
                    config.avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) {
                        config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathJpg)) {
                        config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathJpeg)) {
                        config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
                    } else if (await fs.pathExists(avatarPathGif)) {
                        config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
                    }
                    config.id = agentId;
                    return config;
                }
                return { error: `Agent config for ${agentId} not found.` };
            };

            await groupChat.handleInviteAgentToSpeak(groupId, topicId, invitedAgentId, sendStreamChunkToRenderer, getAgentConfigById);
            return { success: true, message: "Agent invitation processing started." };
        } catch (error) {
            console.error(`[Main IPC] Error in inviteAgentToSpeak handler for Group ${groupId}, Agent ${invitedAgentId}:`, error);
            return { success: false, error: error.message };
        }
    });
    // --- End of Group Chat IPC Handlers ---
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
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.focus(); // 聚焦主窗口
            }
        });
    });
    // --- End of Moved IPC Handler Registration ---

    // Translator IPC Handlers
    const TRANSLATOR_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Translatormodules');
    fs.ensureDirSync(TRANSLATOR_DIR); // Ensure the Translator directory exists

    ipcMain.handle('open-translator-window', async (event, theme) => {
        console.log(`[Main Process] Received open-translator-window. Theme: ${theme}`);
        const translatorWindow = new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            title: '翻译',
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

        let settings = {};
        try {
            if (await fs.pathExists(SETTINGS_FILE)) {
                settings = await fs.readJson(SETTINGS_FILE);
            }
        } catch (readError) {
            console.error('Failed to read settings file for translator window:', readError);
        }

        const vcpServerUrl = settings.vcpServerUrl || '';
        const vcpApiKey = settings.vcpApiKey || '';

        const translatorUrl = `file://${path.join(__dirname, 'Translatormodules', 'translator.html')}?theme=${encodeURIComponent(theme || 'dark')}&vcpServerUrl=${encodeURIComponent(vcpServerUrl)}&vcpApiKey=${encodeURIComponent(vcpApiKey)}`;
        console.log(`[Main Process] Attempting to load URL in translator window: ${translatorUrl.substring(0, 200)}...`);
        
        translatorWindow.webContents.on('did-start-loading', () => {
            console.log(`[Main Process] translatorWindow webContents did-start-loading for URL: ${translatorUrl.substring(0, 200)}`);
        });

        translatorWindow.webContents.on('dom-ready', () => {
            console.log(`[Main Process] translatorWindow webContents dom-ready for URL: ${translatorWindow.webContents.getURL()}`);
        });

        translatorWindow.webContents.on('did-finish-load', () => {
            console.log(`[Main Process] translatorWindow webContents did-finish-load for URL: ${translatorWindow.webContents.getURL()}`);
        });

        translatorWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error(`[Main Process] translatorWindow webContents did-fail-load: Code ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`);
        });

        translatorWindow.loadURL(translatorUrl)
            .then(() => {
                console.log(`[Main Process] translatorWindow successfully initiated URL loading (loadURL resolved): ${translatorUrl.substring(0, 200)}`);
            })
            .catch((err) => {
                console.error(`[Main Process] translatorWindow FAILED to initiate URL loading (loadURL rejected): ${translatorUrl.substring(0, 200)}`, err);
            });

        openChildWindows.push(translatorWindow);
        translatorWindow.setMenu(null);

        translatorWindow.once('ready-to-show', () => {
            console.log(`[Main Process] translatorWindow is ready-to-show. Window Title: "${translatorWindow.getTitle()}". Calling show().`);
            translatorWindow.show();
            console.log('[Main Process] translatorWindow show() called.');
        });

        translatorWindow.on('closed', () => {
            console.log('[Main Process] translatorWindow has been closed.');
            openChildWindows = openChildWindows.filter(win => win !== translatorWindow);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.focus(); // 聚焦主窗口
            }
        });
    });

    // Notes IPC Handlers
    const NOTES_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
    fs.ensureDirSync(NOTES_DIR); // Ensure the Notes directory exists

    ipcMain.handle('read-txt-notes', async () => {
        try {
            const files = await fs.readdir(NOTES_DIR);
            const noteFiles = files.filter(file => file.endsWith('.txt'));
            const notes = [];

            for (const fileName of noteFiles) {
                const filePath = path.join(NOTES_DIR, fileName);
                const content = await fs.readFile(filePath, 'utf8');
                
                const lines = content.split('\n');
                if (lines.length < 1) continue; 

                const header = lines[0];
                const noteContent = lines.slice(1).join('\n');

                const parts = header.split('-');
                if (parts.length >= 3) {
                    const title = parts[0];
                    const username = parts[1];
                    const timestampStr = parts[2];
                    const timestamp = parseInt(timestampStr, 10); 

                    const id = fileName.replace(/\.txt$/, '');

                    notes.push({
                        id: id, 
                        title: title,
                        username: username,
                        timestamp: timestamp,
                        content: noteContent,
                        fileName: fileName 
                    });
                } else {
                    console.warn(`跳过格式不正确的笔记文件: ${fileName}`);
                }
            }
            notes.sort((a, b) => b.timestamp - a.timestamp);
            return notes;
        } catch (error) {
            console.error('读取TXT笔记失败:', error);
            return { error: error.message };
        }
    });

function formatTimestampForFilename(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}_${milliseconds}`;
}

    ipcMain.handle('write-txt-note', async (event, noteData) => {
        try {
            const { id, title, username, timestamp, content, oldFileName } = noteData;
            const formattedTimestamp = formatTimestampForFilename(timestamp);
            const newFileName = `${title}-${username}-${formattedTimestamp}.txt`;
            const newFilePath = path.join(NOTES_DIR, newFileName);

            console.log(`[Main Process - write-txt-note] oldFileName: ${oldFileName}, newFileName: ${newFileName}`);
            if (oldFileName && oldFileName !== newFileName) {
                const oldFilePath = path.join(NOTES_DIR, oldFileName);
                if (await fs.pathExists(oldFilePath)) {
                    try {
                        await fs.remove(oldFilePath);
                        console.log(`[Main Process - write-txt-note] 旧笔记文件已成功删除: ${oldFilePath}`);
                    } catch (removeError) {
                        console.error(`[Main Process - write-txt-note] 删除旧笔记文件失败: ${oldFilePath}`, removeError);
                    }
                } else {
                    console.log(`[Main Process - write-txt-note] 旧笔记文件不存在，无需删除: ${oldFilePath}`);
                }
            }

            const fileContent = `${title}-${username}-${timestamp}\n${content}`;
            await fs.writeFile(newFilePath, fileContent, 'utf8');
            console.log(`[Main Process - write-txt-note] 笔记已保存到: ${newFilePath}`);
            return { success: true, fileName: newFileName };
        } catch (error) {
            console.error('[Main Process - write-txt-note] 保存TXT笔记失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-txt-note', async (event, fileName) => {
        try {
            const filePath = path.join(NOTES_DIR, fileName);
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                console.log(`笔记文件已删除: ${filePath}`);
                return { success: true };
            }
            return { success: false, error: '文件不存在或已被删除。' };
        } catch (error) {
            console.error('删除TXT笔记失败:', error);
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

        const notesUrl = `file://${path.join(__dirname, 'Notemodules', 'notes.html')}?theme=${encodeURIComponent(theme || 'dark')}`;
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
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.focus(); // 聚焦主窗口
            }
        });
    });

    ipcMain.handle('open-notes-with-content', async (event, data) => {
        const { title, content, theme } = data;
        console.log(`[Main Process] Received open-notes-with-content. Title: ${title}, Theme: ${theme}, Content Length: ${content ? content.length : 0}`);
        const notesWindow = new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            title: title || '我的笔记 (分享)',
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

        const queryParams = new URLSearchParams({
            action: 'newFromShare',
            title: encodeURIComponent(title || '来自分享的笔记'),
            content: encodeURIComponent(content || ''),
            theme: encodeURIComponent(theme || 'dark')
        });
        const notesUrl = `file://${path.join(__dirname, 'Notemodules', 'notes.html')}?${queryParams.toString()}`;
        
        console.log(`[Main Process] Attempting to load URL in new notes window: ${notesUrl.substring(0, 250)}...`);
        
        notesWindow.loadURL(notesUrl)
            .then(() => {
                console.log(`[Main Process] New notesWindow successfully initiated URL loading: ${notesUrl.substring(0, 200)}`);
            })
            .catch((err) => {
                console.error(`[Main Process] New notesWindow FAILED to initiate URL loading: ${notesUrl.substring(0, 200)}`, err);
            });

        openChildWindows.push(notesWindow);
        notesWindow.setMenu(null);

        notesWindow.once('ready-to-show', () => {
            console.log(`[Main Process] New notesWindow is ready-to-show. Window Title: "${notesWindow.getTitle()}". Calling show().`);
            notesWindow.show();
        });

        notesWindow.on('closed', () => {
            console.log('[Main Process] New notesWindow (from share) has been closed.');
            openChildWindows = openChildWindows.filter(win => win !== notesWindow);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.focus(); // 聚焦主窗口
            }
        });
    });

    createWindow();
    createAssistantBarWindow(); // Pre-create the assistant bar window for performance

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    globalShortcut.register('Control+Shift+I', () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow && focusedWindow.webContents && !focusedWindow.webContents.isDestroyed()) {
            focusedWindow.webContents.toggleDevTools();
        }
    });

    globalShortcut.register('Control+Shift+A', () => {
        console.log('[Main] Assistant shortcut (Ctrl+Shift+A) pressed.');
        // Reset lastProcessedSelection to allow shortcut to work after a mouse selection
        // lastProcessedSelection = '';
        // grabSelectedText(); // grabSelectedText is removed.
        console.log('[Main] Assistant shortcut (Ctrl+Shift+A) is currently disabled as it relied on clipboard grabbing.');
    });

    // --- Assistant IPC Handlers ---
    ipcMain.on('toggle-clipboard-listener', (event, enable) => {
        if (enable) {
            startSelectionListener();
        } else {
            stopSelectionListener();
        }
        });

    ipcMain.on('assistant-action', async (event, action) => {
        // IMPORTANT: The click on the bar has happened.
        // First, cancel any pending hide operation from the global listener.
        if (hideBarTimeout) {
            clearTimeout(hideBarTimeout);
            hideBarTimeout = null;
            console.log('[Main] Assistant action cancelled pending hide.');
        }
    
        // When an action is taken, hide the bar and stop the listener
        hideAssistantBarAndStopListener();
        
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            // No longer pass the full agent config. Just the ID.
            createAssistantWindow({
                selectedText: lastProcessedSelection,
                action: action,
                agentId: settings.assistantAgent, // Pass only the ID
                theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
            });
        } catch (error) {
            console.error('[Main] Error creating assistant window from action:', error);
        }
    });

    ipcMain.on('close-assistant-bar', () => {
        // This is triggered by mouseleave on the bar, which is a good reason to hide it.
        hideAssistantBarAndStopListener();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    // 优先停止底层IO监听，防止它阻塞退出
    stopSelectionListener();
    if (mouseListener) {
        mouseListener.kill();
        mouseListener = null;
        console.log('[Main] Global mouse listener stopped on quit.');
    }

    // 注销所有全局快捷键
    globalShortcut.unregisterAll();

    // 关闭WebSocket连接
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close();
    }
    if (vcpLogReconnectInterval) {
        clearInterval(vcpLogReconnectInterval);
    }

    // 确保所有子窗口都被关闭
    if (assistantWindow && !assistantWindow.isDestroyed()) {
        assistantWindow.close();
    }
    if (assistantBarWindow && !assistantBarWindow.isDestroyed()) {
        assistantBarWindow.close();
    }
    openChildWindows.forEach(win => {
        if (win && !win.isDestroyed()) {
            win.close();
        }
    });
});

// --- IPC Handlers ---

ipcMain.on('open-external-link', (event, url) => {
  if (url) {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external link:', err);
      });
    } else if (url.startsWith('file:')) {
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
        let settings = {};
        if (await fs.pathExists(SETTINGS_FILE)) {
            settings = await fs.readJson(SETTINGS_FILE);
        }
        // Check for user avatar
        if (await fs.pathExists(USER_AVATAR_FILE)) {
            settings.userAvatarUrl = `file://${USER_AVATAR_FILE}?t=${Date.now()}`;
        } else {
            settings.userAvatarUrl = null; // Or a default path
        }
        return settings;
    } catch (error) {
        console.error('加载设置失败:', error);
        return { 
            error: error.message,
            sidebarWidth: 260,
            notificationsSidebarWidth: 300,
            userAvatarUrl: null
        };
    }
});

ipcMain.handle('save-settings', async (event, settings) => {
    try {
        // User avatar URL is handled by 'save-user-avatar', remove it from general settings to avoid saving a file path
        const { userAvatarUrl, ...settingsToSave } = settings;
        await fs.writeJson(SETTINGS_FILE, settingsToSave, { spaces: 2 });
        return { success: true };
    } catch (error) {
        console.error('保存设置失败:', error);
        return { error: error.message };
    }
});

// New IPC Handler to save calculated avatar color
ipcMain.handle('save-avatar-color', async (event, { type, id, color }) => {
    try {
        if (type === 'user') {
            const settings = await fs.pathExists(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
            settings.userAvatarCalculatedColor = color;
            await fs.writeJson(SETTINGS_FILE, settings, { spaces: 2 });
            console.log(`[Main] User avatar color saved: ${color}`);
            return { success: true };
        } else if (type === 'agent' && id) {
            const configPath = path.join(AGENT_DIR, id, 'config.json');
            if (await fs.pathExists(configPath)) {
                const agentConfig = await fs.readJson(configPath);
                agentConfig.avatarCalculatedColor = color;
                await fs.writeJson(configPath, agentConfig, { spaces: 2 });
                console.log(`[Main] Agent ${id} avatar color saved: ${color}`);
                return { success: true };
            } else {
                return { success: false, error: `Agent config for ${id} not found.` };
            }
        }
        return { success: false, error: 'Invalid type or missing ID for saving avatar color.' };
    } catch (error) {
        console.error('Error saving avatar color:', error);
        return { success: false, error: error.message };
    }
});

// User Avatar Management
ipcMain.handle('save-user-avatar', async (event, avatarData) => {
    try {
        if (!avatarData || !avatarData.buffer) {
            return { error: '保存用户头像失败：未提供有效的头像数据。' };
        }
        await fs.ensureDir(USER_DATA_DIR);
        const nodeBuffer = Buffer.from(avatarData.buffer);
        await fs.writeFile(USER_AVATAR_FILE, nodeBuffer);
        console.log(`用户头像已保存到: ${USER_AVATAR_FILE}`);
        return { success: true, avatarUrl: `file://${USER_AVATAR_FILE}?t=${Date.now()}`, needsColorExtraction: true };
    } catch (error) {
        console.error(`保存用户头像失败:`, error);
        return { error: `保存用户头像失败: ${error.message}` };
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
                const avatarPathJpeg = path.join(agentPath, 'avatar.jpeg'); 
                const avatarPathGif = path.join(agentPath, 'avatar.gif');
                
                let agentData = { id: folderName, name: folderName, avatarUrl: null, config: {} };

                if (await fs.pathExists(configPath)) {
                    const config = await fs.readJson(configPath);
                    agentData.name = config.name || folderName;
                    agentData.config.avatarCalculatedColor = config.avatarCalculatedColor || null; // Load persisted color
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
                        avatarCalculatedColor: null, // Add placeholder
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
                } else if (await fs.pathExists(avatarPathJpeg)) {
                    agentData.avatarUrl = `file://${avatarPathJpeg}`;
                } else if (await fs.pathExists(avatarPathGif)) {
                    agentData.avatarUrl = `file://${avatarPathGif}`;
                }
                agents.push(agentData);
            }
        }

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
                    agentMap.delete(id); 
                }
            });
            orderedAgents.push(...agentMap.values());
            agents = orderedAgents;
        } else {
            agents.sort((a, b) => a.name.localeCompare(b.name));
        }
        return agents;
    } catch (error) {
        console.error('获取Agent列表失败:', error);
        return { error: error.message };
    }
});

// IPC handler for saving the combined order of agents and groups
ipcMain.handle('save-combined-item-order', async (event, orderedItemsWithTypes) => {
    console.log('[Main IPC] Received save-combined-item-order:', orderedItemsWithTypes);
    try {
        let settings = {};
        try {
            if (await fs.pathExists(SETTINGS_FILE)) {
                const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
                settings = JSON.parse(data);
            }
        } catch (readError) {
            if (readError.code !== 'ENOENT') {
                console.error('Failed to read settings file for saving combined item order:', readError);
                return { success: false, error: '读取设置文件失败' };
            }
            console.log('Settings file not found, will create a new one for combined item order.');
        }

        settings.combinedItemOrder = orderedItemsWithTypes; // Save the array of {id, type}

        await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        console.log('Combined item order saved successfully to:', SETTINGS_FILE);
        return { success: true };
    } catch (error) {
        console.error('Error saving combined item order:', error);
        return { success: false, error: error.message || '保存项目顺序时发生未知错误' };
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

        settings.agentOrder = orderedAgentIds; 

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
                topicMap.delete(id); 
            } else {
                console.warn(`Topic ID ${id} from ordered list not found in agent ${agentId}'s config.topics.`);
            }
        });
        
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

// IPC handler for saving the topic order for a specific group
ipcMain.handle('save-group-topic-order', async (event, groupId, orderedTopicIds) => {
    console.log(`[Main IPC] Received save-group-topic-order for group ${groupId} with Topic IDs:`, orderedTopicIds);
    if (!groupId || !Array.isArray(orderedTopicIds)) {
        return { success: false, error: '无效的 groupId 或 topic IDs' };
    }

    // Reconstruct the path to AGENT_GROUPS_DIR as mainAppPaths is not directly accessible here.
    const AGENT_GROUPS_DIR_LOCAL = path.join(APP_DATA_ROOT_IN_PROJECT, 'AgentGroups');
    const groupConfigPath = path.join(AGENT_GROUPS_DIR_LOCAL, groupId, 'config.json');

    try {
        let groupConfig = {};
        try {
            const data = await fs.readFile(groupConfigPath, 'utf-8');
            groupConfig = JSON.parse(data);
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                 console.error(`Group config file not found for ID ${groupId} at ${groupConfigPath}`);
                return { success: false, error: `群组配置文件 ${groupId} 未找到` };
            }
            console.error(`Failed to read group config file ${groupConfigPath}:`, readError);
            return { success: false, error: '读取群组配置文件失败' };
        }

        if (!Array.isArray(groupConfig.topics)) {
            groupConfig.topics = []; // Should not happen if group creation is correct
        }

        const newTopicsArray = [];
        const topicMap = new Map(groupConfig.topics.map(topic => [topic.id, topic]));

        orderedTopicIds.forEach(id => {
            if (topicMap.has(id)) {
                newTopicsArray.push(topicMap.get(id));
                topicMap.delete(id);
            } else {
                console.warn(`Topic ID ${id} from ordered list not found in group ${groupId}'s config.topics.`);
            }
        });
        
        newTopicsArray.push(...topicMap.values()); // Add any topics not in the ordered list (e.g., newly created)
        
        groupConfig.topics = newTopicsArray;

        await fs.writeFile(groupConfigPath, JSON.stringify(groupConfig, null, 2));
        console.log(`Topic order for group ${groupId} saved successfully to: ${groupConfigPath}`);
        return { success: true };
    } catch (error) {
        console.error(`Error saving topic order for group ${groupId}:`, error);
        return { success: false, error: error.message || `保存群组 ${groupId} 的话题顺序时发生未知错误` };
    }
});

// IPC handler for searching topic content
ipcMain.handle('search-topics-by-content', async (event, itemId, itemType, searchTerm) => {
    if (!itemId || !itemType || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
        return { success: false, error: 'Invalid arguments for topic content search.', matchedTopicIds: [] };
    }
    const searchTermLower = searchTerm.toLowerCase();
    const matchedTopicIds = [];

    try {
        let itemConfig;
        if (itemType === 'agent') {
            // Directly call the logic of 'get-agent-config' handler if possible,
            // or re-implement parts of it if direct call is problematic.
            // For simplicity, we'll assume direct call or similar logic.
            const agentDir = path.join(AGENT_DIR, itemId);
            const configPath = path.join(agentDir, 'config.json');
            if (await fs.pathExists(configPath)) {
                itemConfig = await fs.readJson(configPath);
            }
        } else if (itemType === 'group') {
            const groupDir = path.join(APP_DATA_ROOT_IN_PROJECT, 'AgentGroups', itemId);
            const configPath = path.join(groupDir, 'config.json');
            if (await fs.pathExists(configPath)) {
                itemConfig = await fs.readJson(configPath);
            }
        }

        if (!itemConfig || !itemConfig.topics || !Array.isArray(itemConfig.topics)) {
            console.warn(`[search-topics-by-content] No topics found for ${itemType} ${itemId}`);
            return { success: true, matchedTopicIds: [] };
        }

        for (const topic of itemConfig.topics) {
            let history = [];
            const historyFilePath = path.join(USER_DATA_DIR, itemId, 'topics', topic.id, 'history.json');
            if (await fs.pathExists(historyFilePath)) {
                try {
                    history = await fs.readJson(historyFilePath);
                } catch (e) {
                    console.error(`Error reading history for ${itemType} ${itemId}, topic ${topic.id}:`, e);
                }
            }

            if (Array.isArray(history)) {
                for (const message of history) {
                    if (message.content && typeof message.content === 'string' && message.content.toLowerCase().includes(searchTermLower)) {
                        matchedTopicIds.push(topic.id);
                        break;
                    }
                }
            }
        }
        return { success: true, matchedTopicIds: [...new Set(matchedTopicIds)] };
    } catch (error) {
        console.error(`Error searching topic content for ${itemType} ${itemId} with term "${searchTerm}":`, error);
        return { success: false, error: error.message, matchedTopicIds: [] };
    }
});


ipcMain.handle('get-agent-config', async (event, agentId) => {
    try {
        const agentDir = path.join(AGENT_DIR, agentId);
        const configPath = path.join(agentDir, 'config.json');
        if (await fs.pathExists(configPath)) {
            const config = await fs.readJson(configPath);
            // Construct avatarUrl similar to get-agents
            const avatarPathPng = path.join(agentDir, 'avatar.png');
            const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
            const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
            const avatarPathGif = path.join(agentDir, 'avatar.gif');
            config.avatarUrl = null;
            if (await fs.pathExists(avatarPathPng)) {
                config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
            } else if (await fs.pathExists(avatarPathJpg)) {
                config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
            } else if (await fs.pathExists(avatarPathJpeg)) {
                config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
            } else if (await fs.pathExists(avatarPathGif)) {
                config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
            }
            config.id = agentId; // Add the agent's ID to the config object
            return config;
        }
        return { error: `Agent config for ${agentId} not found.` }; // Return error object if not found
    } catch (error) {
        console.error(`获取Agent ${agentId} 配置失败:`, error);
        return { error: error.message };
    }
});

// Helper function to get agent config, needed by assistant bar
async function getAgentConfigById(agentId) {
    const agentDir = path.join(AGENT_DIR, agentId);
    const configPath = path.join(agentDir, 'config.json');
    if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        const avatarPathPng = path.join(agentDir, 'avatar.png');
        const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
        const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
        const avatarPathGif = path.join(agentDir, 'avatar.gif');
        config.avatarUrl = null;
        if (await fs.pathExists(avatarPathPng)) {
            config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpg)) {
            config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpeg)) {
            config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathGif)) {
            config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
        }
        config.id = agentId;
        return config;
    }
    return { error: `Agent config for ${agentId} not found.` };
}


ipcMain.handle('save-agent-config', async (event, agentId, config) => {
    try {
        const agentDir = path.join(AGENT_DIR, agentId);
        await fs.ensureDir(agentDir);
        const configPath = path.join(agentDir, 'config.json');
        
        let existingConfig = {};
        if (await fs.pathExists(configPath)) {
            existingConfig = await fs.readJson(configPath);
        }
        
        const newConfigData = { ...existingConfig, ...config }; 
        
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
        return { success: true, topics: config.topics }; 
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

ipcMain.handle('save-avatar', async (event, agentId, avatarData) => { 
    try {
        if (!avatarData || !avatarData.name || !avatarData.type || !avatarData.buffer) {
            console.error(`保存Agent ${agentId} 头像失败: avatarData 无效 (值为: ${JSON.stringify(avatarData)})`);
            return { error: '保存头像失败：未提供有效的头像数据。' };
        }

        const agentDir = path.join(AGENT_DIR, agentId);
        await fs.ensureDir(agentDir);

        let ext = path.extname(avatarData.name).toLowerCase();
        if (!ext) { 
            if (avatarData.type === 'image/png') ext = '.png';
            else if (avatarData.type === 'image/jpeg') ext = '.jpg';
            else if (avatarData.type === 'image/gif') ext = '.gif';
            else if (avatarData.type === 'image/webp') ext = '.webp';
            else {
                console.warn(`无法从类型 ${avatarData.type} 和名称 ${avatarData.name} 推断头像扩展名。默认为 .png`);
                ext = '.png'; // Default to png if cropper always outputs png
            }
        }

        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        if (!allowedExtensions.includes(ext)) {
            return { error: `保存头像失败：不支持的文件类型/扩展名 "${ext}"。` };
        }

        const oldAvatarPng = path.join(agentDir, 'avatar.png');
        const oldAvatarJpg = path.join(agentDir, 'avatar.jpg');
        const oldAvatarGif = path.join(agentDir, 'avatar.gif');
        const oldAvatarWebp = path.join(agentDir, 'avatar.webp');
        const oldAvatars = [oldAvatarPng, oldAvatarJpg, oldAvatarGif, oldAvatarWebp];

        // Delete old avatars regardless of new extension, to ensure only one exists.
        for (const oldAvatarPath of oldAvatars) {
            if (await fs.pathExists(oldAvatarPath)) {
                await fs.remove(oldAvatarPath);
            }
        }

        const newAvatarPath = path.join(agentDir, `avatar${ext}`);
        const nodeBuffer = Buffer.from(avatarData.buffer); 

        await fs.writeFile(newAvatarPath, nodeBuffer);
        console.log(`Agent ${agentId} 的头像已保存到: ${newAvatarPath}`);
        // Return success and URL, color will be calculated and saved by renderer via 'save-avatar-color'
        return { success: true, avatarUrl: `file://${newAvatarPath}?t=${Date.now()}`, needsColorExtraction: true };
    } catch (error) {
        console.error(`保存Agent ${agentId} 头像失败:`, error);
        return { error: `保存头像失败: ${error.message}` };
    }
});

ipcMain.handle('create-agent', async (event, agentName, initialConfig = null) => {
    try {
        const baseName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const agentId = `${baseName}_${Date.now()}`;
        const agentDir = path.join(AGENT_DIR, agentId);

        if (await fs.pathExists(agentDir)) {
            return { error: 'Agent文件夹已存在（ID冲突）。' };
        }
        await fs.ensureDir(agentDir);

        let configToSave;
        if (initialConfig) {
            configToSave = { ...initialConfig, name: agentName }; 
        } else {
            configToSave = {
                name: agentName,
                systemPrompt: `你是 ${agentName}。`,
                model: 'gemini-2.5-flash-preview-05-20', 
                temperature: 0.7,
                contextTokenLimit: 1000000, 
                maxOutputTokens: 60000, 
                topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }] 
            };
        }
        if (initialConfig) {
            if (!initialConfig.topics || !Array.isArray(initialConfig.topics) || initialConfig.topics.length === 0) {
                configToSave.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
            } else {
                configToSave.topics = initialConfig.topics; 
            }
        }

        await fs.writeJson(path.join(agentDir, 'config.json'), configToSave, { spaces: 2 });
        
        if (configToSave.topics && configToSave.topics.length > 0) {
            const firstTopicId = configToSave.topics[0].id || "default";
            const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', firstTopicId);
            await fs.ensureDir(topicHistoryDir);
            const historyFilePath = path.join(topicHistoryDir, 'history.json');
            if (!await fs.pathExists(historyFilePath)) {
                 await fs.writeJson(historyFilePath, [], { spaces: 2 });
            }
        }
        
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

ipcMain.handle('read-image-from-clipboard-main', async () => {
    console.log('[Main Process] Received request to read image from clipboard.');
    try {
        const nativeImage = clipboard.readImage(); 
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

ipcMain.handle('read-text-from-clipboard-main', async () => {
    console.log('[Main Process] Received request to read text from clipboard.');
    try {
        const text = clipboard.readText();
        return { success: true, text: text };
    } catch (error) {
        console.error('[Main Process] Error reading text from clipboard:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('save-pasted-image-to-file', async (event, imageData, noteId) => {
    console.log(`[Main Process] Received save-pasted-image-to-file for noteId: ${noteId}, image type: ${imageData.extension}`);
    if (!imageData || !imageData.data || !imageData.extension) {
        return { success: false, error: 'Invalid image data provided.' };
    }
    if (!noteId) {
        return { success: false, error: 'Note ID is required to save image.' };
    }

    try {
        const notesAgentDir = path.join(USER_DATA_DIR, NOTES_AGENT_ID);
        await fs.ensureDir(notesAgentDir);

        const originalFileName = `pasted_image_${Date.now()}.${imageData.extension}`;
        const buffer = Buffer.from(imageData.data, 'base64');
        const fileTypeHint = `image/${imageData.extension}`; 

        const storedFileObject = await fileManager.storeFile(
            buffer,
            originalFileName,
            NOTES_AGENT_ID, 
            noteId,         
            fileTypeHint
        );
        console.log('[Main Process] Image saved successfully:', storedFileObject.internalPath);
        return { success: true, attachment: storedFileObject };
    } catch (error) {
        console.error('[Main Process] Error saving pasted image for note:', error);
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
        if (agentId === NOTES_AGENT_ID) {
            const notesAgentTopicDir = path.join(USER_DATA_DIR, NOTES_AGENT_ID, 'topics', topicId);
            await fs.ensureDir(notesAgentTopicDir); 
        }

        const historyFile = path.join(USER_DATA_DIR, agentId, 'topics', topicId, 'history.json');
        await fs.ensureDir(path.dirname(historyFile)); 

        if (await fs.pathExists(historyFile)) {
            const history = await fs.readJson(historyFile);
            return history;
        }
        return []; 
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

ipcMain.handle('get-agent-topics', async (event, agentId) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (await fs.pathExists(configPath)) {
            const config = await fs.readJson(configPath);
            if (config.topics && Array.isArray(config.topics) && config.topics.length > 0) {
                return config.topics;
            } else { 
                const defaultTopics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                config.topics = defaultTopics;
                await fs.writeJson(configPath, config, { spaces: 2 });
                return defaultTopics;
            }
        } else { 
            console.warn(`Config file not found for agent ${agentId} in get-agent-topics. Attempting to use default.`);
            return [{ id: "default", name: "主要对话", createdAt: Date.now() }];
        }
    } catch (error) {
        console.error(`获取Agent ${agentId} 话题列表失败:`, error);
        return [{ id: "default", name: "主要对话", createdAt: Date.now(), error: error.message }];
    }
});

ipcMain.handle('create-new-topic-for-agent', async (event, agentId, topicName, refreshTimestamp = false) => {
    try {
        const configPath = path.join(AGENT_DIR, agentId, 'config.json');
        if (!await fs.pathExists(configPath)) {
            return { error: `Agent ${agentId} 的配置文件不存在。` };
        }
        const config = await fs.readJson(configPath);
        if (!config.topics || !Array.isArray(config.topics)) {
            config.topics = []; 
        }

        const newTopicId = `topic_${Date.now()}`;
        const createdAt = refreshTimestamp ? Date.now() : Date.now(); 
        const newTopic = { id: newTopicId, name: topicName || `新话题 ${config.topics.length + 1}`, createdAt: createdAt };
        config.topics.push(newTopic);
        await fs.writeJson(configPath, config, { spaces: 2 });

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
            console.warn(`Attempted to delete non-existent topic ${topicIdToDelete} from agent ${agentId}`);
            return { error: `未找到要删除的话题 ID: ${topicIdToDelete}` };
        }

        if (config.topics.length === 0) {
            const defaultTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
            config.topics.push(defaultTopic);
            const defaultTopicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', defaultTopic.id);
            await fs.ensureDir(defaultTopicHistoryDir);
            await fs.writeJson(path.join(defaultTopicHistoryDir, 'history.json'), [], { spaces: 2 });
        }

        await fs.writeJson(configPath, config, { spaces: 2 });

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
    try {
        let storedFileObject;
        if (fileData.type === 'path') {
            const originalFileName = path.basename(fileData.path);
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
        return { success: true, attachment: storedFileObject };
    } catch (error) {
        console.error('处理粘贴文件失败:', error);
        return { error: error.message };
    }
});

ipcMain.handle('select-files-to-send', async (event, agentId, topicId) => { 
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
                const ext = path.extname(filePath).toLowerCase();
                let fileTypeHint = 'application/octet-stream';
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileTypeHint = `image/${ext.substring(1)}`;
                else if (['.mp3', '.wav', '.ogg'].includes(ext)) fileTypeHint = `audio/${ext.substring(1)}`;

                const storedFile = await fileManager.storeFile(filePath, originalName, agentId, topicId, fileTypeHint);
                storedFilesInfo.push(storedFile);
            } catch (error) {
                console.error(`[Main - select-files-to-send] Error storing file ${filePath}:`, error);
                storedFilesInfo.push({ name: path.basename(filePath), error: error.message });
            }
        }
        return { success: true, attachments: storedFilesInfo };
    }
    return { success: false, attachments: [] }; 
});

ipcMain.handle('get-file-as-base64', async (event, filePath) => {
    try {
        console.log(`[Main - get-file-as-base64] ===== REQUEST START ===== Received raw filePath: "${filePath}"`);
        if (!filePath || typeof filePath !== 'string') {
            console.error('[Main - get-file-as-base64] Invalid file path received:', filePath);
            return { error: 'Invalid file path provided.', base64String: null };
        }
        
        const cleanPath = filePath.startsWith('file://') ? decodeURIComponent(filePath.substring(7)) : decodeURIComponent(filePath);
        console.log(`[Main - get-file-as-base64] Cleaned path: "${cleanPath}"`);
        
        if (!await fs.pathExists(cleanPath)) {
            console.error(`[Main - get-file-as-base64] File not found at path: ${cleanPath}`);
            return { error: `File not found at path: ${cleanPath}`, base64String: null };
        }
        
        let originalFileBuffer = await fs.readFile(cleanPath); // 读取原始文件
        let processedFileBuffer = originalFileBuffer; // 默认使用原始buffer

        const fileExtension = path.extname(cleanPath).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.svg'].includes(fileExtension); // 扩展支持的图片类型

        if (isImage) {
            console.log(`[Main - get-file-as-base64] Processing image: ${cleanPath}`);
            const MAX_DIMENSION = 800; // 进一步减小目标尺寸，例如800px
            const JPEG_QUALITY = 70;   // 稍微降低JPEG质量以减小体积
            const PNG_COMPRESSION_LEVEL = 7; // 增加PNG压缩级别

            try {
                let image = sharp(originalFileBuffer);
                const metadata = await image.metadata();
                console.log(`[Main Sharp] Original: ${metadata.format}, ${metadata.width}x${metadata.height}, size: ${originalFileBuffer.length} bytes`);

                let needsResize = false;
                if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
                    console.log(`[Main Sharp] Resizing image to fit within ${MAX_DIMENSION}x${MAX_DIMENSION}`);
                    image = image.resize({
                        width: MAX_DIMENSION,
                        height: MAX_DIMENSION,
                        fit: sharp.fit.inside,
                        withoutEnlargement: true
                    });
                    needsResize = true;
                }

                // 目标格式：优先JPEG，除非是需要保留透明的PNG/GIF且VCP支持良好
                // 考虑到503问题，目前所有图片都尝试转为JPEG以最大化压缩
                let targetFormat = 'jpeg';
                let encodeOptions = { quality: JPEG_QUALITY };

                // 如果是GIF，sharp默认会处理第一帧。如果需要动画GIF，处理方式会更复杂。
                // 目前简单处理，也转为静态JPEG。
                if (metadata.format === 'gif') {
                    console.log('[Main Sharp] GIF detected, will be converted to static JPEG.');
                }
                
                // 如果原始是PNG且有透明通道，并且你确认VCP能处理且你需要保留透明度
                // if (metadata.format === 'png' && metadata.hasAlpha) {
                //    targetFormat = 'png';
                //    encodeOptions = { compressionLevel: PNG_COMPRESSION_LEVEL, adaptiveFiltering: true };
                //    console.log(`[Main Sharp] Encoding as PNG to preserve alpha.`);
                // } else {
                //    console.log(`[Main Sharp] Encoding as JPEG.`);
                // }
                // 为了解决503，我们先强制都转JPEG
                console.log(`[Main Sharp] Forcing encoding to JPEG with quality ${JPEG_QUALITY}.`);


                if (targetFormat === 'jpeg') {
                    processedFileBuffer = await image.jpeg(encodeOptions).toBuffer();
                } else if (targetFormat === 'png') {
                    processedFileBuffer = await image.png(encodeOptions).toBuffer();
                }
                // 如果未来支持WEBP等其他格式，可以在这里添加 else if

                const finalMetadata = await sharp(processedFileBuffer).metadata();
                console.log(`[Main Sharp] Processed: ${finalMetadata.format}, ${finalMetadata.width}x${finalMetadata.height}, final buffer length: ${processedFileBuffer.length} bytes`);

            } catch (sharpError) {
                console.error(`[Main Sharp] Error processing image with sharp: ${sharpError.message}. Using original image buffer.`, sharpError);
                // 如果sharp处理失败，回退到使用原始buffer（但仍然可能导致503）
                // 或者你可以选择在这里返回一个错误
                // return { error: `图片处理失败: ${sharpError.message}`, base64String: null };
                // 为简单起见，我们先尝试用原始buffer，但这意味着优化未生效
                processedFileBuffer = originalFileBuffer; // 回退
                console.warn('[Main Sharp] Sharp processing failed. Will attempt to send original image data.');
            }
        } else {
            console.log(`[Main - get-file-as-base64] Non-image file. Buffer length: ${originalFileBuffer.length}`);
            // processedFileBuffer 已经是 originalFileBuffer
        }

        const base64String = processedFileBuffer.toString('base64');
        console.log(`[Main - get-file-as-base64] Successfully converted "${cleanPath}" to Base64. Final Base64 length: ${base64String.length}`);
        console.log(`[Main - get-file-as-base64] ===== REQUEST END (SUCCESS) =====`);
        return base64String; // 成功时直接返回 base64 字符串

    } catch (error) {
        console.error(`[Main - get-file-as-base64] Outer catch: Error processing path "${filePath}":`, error.message, error.stack);
        console.log(`[Main - get-file-as-base64] ===== REQUEST END (ERROR) =====`);
        return { error: `获取/处理文件Base64失败: ${error.message}`, base64String: null };
    }
});


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
            if (!fileData.data || !fileData.name || !fileData.type) { 
                console.warn('[Main - handle-file-drop] Skipping a dropped file due to missing data, name, or type. fileData:', JSON.stringify(fileData));
                storedFilesInfo.push({ name: fileData.name || '未知文件（数据缺失）', error: '文件内容、名称或类型缺失' });
                continue;
            }
            
            const fileTypeHint = fileData.type; 
            
            console.log(`[Main - handle-file-drop] Attempting to store dropped file: ${fileData.name} (Type: ${fileData.type}, Size: ${fileData.size}) for Agent: ${agentId}, Topic: ${topicId}`);
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
    return storedFilesInfo; 
});
 
 
// VCP Server Communication
ipcMain.handle('send-to-vcp', async (event, vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall = false, groupContext = null) => {
    console.log(`[Main - sendToVCP] ***** sendToVCP HANDLER EXECUTED for messageId: ${messageId}, isGroupCall: ${isGroupCall} *****`);
    const streamChannel = isGroupCall ? 'vcp-group-stream-chunk' : 'vcp-stream-chunk';
    try {
        console.log(`发送到VCP服务器: ${vcpUrl} for messageId: ${messageId}`);
        console.log('VCP API Key:', vcpApiKey ? '已设置' : '未设置');
        // console.log('发送到VCP的消息 (messagesForVCP):', JSON.stringify(messages, null, 2)); // 完整日志
        console.log('模型配置:', modelConfig);
        if (isGroupCall) console.log('群聊上下文:', groupContext);

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
                stream: modelConfig.stream === true
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Main - sendToVCP] VCP请求失败. Status: ${response.status}, Response Text:`, errorText);
            let errorData = { message: `服务器返回状态 ${response.status}`, details: errorText };
            try {
                const parsedError = JSON.parse(errorText);
                if (typeof parsedError === 'object' && parsedError !== null) {
                    errorData = parsedError;
                }
            } catch (e) { /* Not JSON, use raw text */ }
            
            const errorMessageToPropagate = `VCP请求失败: ${response.status} - ${errorData.message || errorData.error || (typeof errorData === 'string' ? errorData : '未知服务端错误')}`;
            
            if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                // 构造更详细的错误信息
                let detailedErrorMessage = `服务器返回状态 ${response.status}.`;
                if (errorData && errorData.message) detailedErrorMessage += ` 错误: ${errorData.message}`;
                else if (errorData && errorData.error && errorData.error.message) detailedErrorMessage += ` 错误: ${errorData.error.message}`;
                else if (typeof errorData === 'string' && errorData.length < 200) detailedErrorMessage += ` 响应: ${errorData}`;
                else if (errorData && errorData.details && typeof errorData.details === 'string' && errorData.details.length < 200) detailedErrorMessage += ` 详情: ${errorData.details}`;

                const errorPayload = { type: 'error', error: `VCP请求失败: ${detailedErrorMessage}`, details: errorData, messageId: messageId }; // details 字段保持原始 errorData
                if (isGroupCall && groupContext) {
                    Object.assign(errorPayload, groupContext); // Add agentId, agentName, groupId, topicId
                }
                event.sender.send(streamChannel, errorPayload);
                // 为函数返回值构造统一的 errorDetail.message
                const finalErrorMessageForReturn = `VCP请求失败: ${response.status} - ${errorData.message || (errorData.error && errorData.error.message) || (typeof errorData === 'string' ? errorData : '详细错误请查看控制台')}`;
                return { streamError: true, error: `VCP请求失败 (${response.status})`, errorDetail: { message: finalErrorMessageForReturn, originalData: errorData } };
            }
            const err = new Error(errorMessageToPropagate);
            err.details = errorData;
            err.status = response.status;
            throw err;
        }

        if (modelConfig.stream === true) {
            console.log(`VCP响应: 开始流式处理 for ${messageId} on channel ${streamChannel}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            async function processStream() {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            console.log(`VCP流结束 for messageId: ${messageId}`);
                            const endPayload = { type: 'end', messageId: messageId };
                            if (isGroupCall && groupContext) {
                                Object.assign(endPayload, groupContext);
                            }
                            event.sender.send(streamChannel, endPayload);
                            break;
                        }
                        const chunkString = decoder.decode(value, { stream: true });
                        const lines = chunkString.split('\n').filter(line => line.trim() !== '');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData === '[DONE]') {
                                    console.log(`VCP流明确[DONE] for messageId: ${messageId}`);
                                    const donePayload = { type: 'end', messageId: messageId }; // Treat [DONE] as end
                                    if (isGroupCall && groupContext) {
                                        Object.assign(donePayload, groupContext);
                                    }
                                    event.sender.send(streamChannel, donePayload);
                                    return;
                                }
                                try {
                                    const parsedChunk = JSON.parse(jsonData);
                                    const dataPayload = { type: 'data', chunk: parsedChunk, messageId: messageId };
                                    if (isGroupCall && groupContext) {
                                        Object.assign(dataPayload, groupContext);
                                    }
                                    event.sender.send(streamChannel, dataPayload);
                                } catch (e) {
                                    console.error(`解析VCP流数据块JSON失败 for messageId: ${messageId}:`, e, '原始数据:', jsonData);
                                    const errorChunkPayload = { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId };
                                    if (isGroupCall && groupContext) {
                                        Object.assign(errorChunkPayload, groupContext);
                                    }
                                    event.sender.send(streamChannel, errorChunkPayload);
                                }
                            }
                        }
                    }
                } catch (streamError) {
                    console.error(`VCP流读取错误 for messageId: ${messageId}:`, streamError);
                    const streamErrPayload = { type: 'error', error: `VCP流读取错误: ${streamError.message}`, messageId: messageId };
                    if (isGroupCall && groupContext) {
                        Object.assign(streamErrPayload, groupContext);
                    }
                    event.sender.send(streamChannel, streamErrPayload);
                } finally {
                    reader.releaseLock();
                }
            }
            processStream();
            return { streamingStarted: true };
        } else { // Non-streaming
            console.log('VCP响应: 非流式处理');
            const vcpResponse = await response.json();
            return vcpResponse; // Return full response for non-streaming
        }

    } catch (error) {
        console.error('VCP请求错误 (catch block):', error);
        if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
            const catchErrorPayload = { type: 'error', error: `VCP请求错误: ${error.message}`, messageId: messageId };
            if (isGroupCall && groupContext) {
                Object.assign(catchErrorPayload, groupContext);
            }
            event.sender.send(streamChannel, catchErrorPayload);
            return { streamError: true, error: `VCP客户端请求错误`, errorDetail: { message: error.message, stack: error.stack } };
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

    const fullWsUrl = `${wsUrl}/VCPlog/VCP_Key=${wsKey}`; 
    
    if (vcpLogWebSocket && (vcpLogWebSocket.readyState === WebSocket.OPEN || vcpLogWebSocket.readyState === WebSocket.CONNECTING)) {
        console.log('VCPLog WebSocket 已连接或正在连接。');
        return;
    }

    console.log(`尝试连接 VCPLog WebSocket: ${fullWsUrl}`);
    if (mainWindow) mainWindow.webContents.send('vcp-log-status', { status: 'connecting', message: '连接中...' });

    vcpLogWebSocket = new WebSocket(fullWsUrl);

    vcpLogWebSocket.onopen = () => {
        console.log('[MAIN_VCP_LOG] WebSocket onopen event triggered.'); 
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            console.log('[MAIN_VCP_LOG] Attempting to send vcp-log-status "open" to renderer.'); 
            mainWindow.webContents.send('vcp-log-status', { status: 'open', message: '已连接' });
            console.log('[MAIN_VCP_LOG] vcp-log-status "open" sent.'); 
            mainWindow.webContents.send('vcp-log-message', { type: 'connection_ack', message: 'VCPLog 连接成功！' });
        } else {
            console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onopen. Cannot send status.'); 
        }
        if (vcpLogReconnectInterval) {
            clearInterval(vcpLogReconnectInterval);
            vcpLogReconnectInterval = null;
        }
    };

    vcpLogWebSocket.onmessage = (event) => {
        console.log('VCPLog 收到消息:', event.data);
        try {
            const data = JSON.parse(event.data.toString()); 
            if (mainWindow) mainWindow.webContents.send('vcp-log-message', data);
        } catch (e) {
            console.error('VCPLog 解析消息失败:', e);
            if (mainWindow) mainWindow.webContents.send('vcp-log-message', { type: 'error', data: `收到无法解析的消息: ${event.data.toString().substring(0,100)}...` });
        }
    };

    vcpLogWebSocket.onclose = (event) => {
        console.log('VCPLog WebSocket 连接已关闭:', event.code, event.reason);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-status', { status: 'closed', message: `连接已断开 (${event.code})` });
        if (!vcpLogReconnectInterval && wsUrl && wsKey) { 
            console.log('将在5秒后尝试重连 VCPLog...');
            vcpLogReconnectInterval = setTimeout(() => connectVcpLog(wsUrl, wsKey), 5000);
        }
    };

    vcpLogWebSocket.onerror = (error) => {
        console.error('[MAIN_VCP_LOG] WebSocket onerror event:', error.message); 
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('vcp-log-status', { status: 'error', message: `连接错误: ${error.message}` });
        } else {
            console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onerror.'); 
        }
    };
}

ipcMain.on('connect-vcplog', (event, { url, key }) => {
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close(); 
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

// Theme control
ipcMain.on('set-theme', (event, theme) => {
    if (theme === 'light' || theme === 'dark') {
        nativeTheme.themeSource = theme;
        console.log(`[Main] Theme source explicitly set to: ${theme}`);
    }
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
    // Directly quit the app. This will trigger the 'will-quit' event
    // which handles closing all windows and cleaning up resources.
    app.quit();
});

ipcMain.on('toggle-notifications-sidebar', () => {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('do-toggle-notifications-sidebar');
    }
});

ipcMain.on('open-dev-tools', () => {
    console.log('[Main Process] Received open-dev-tools event.'); 
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        console.log('[Main Process] Attempting to open detached dev tools.'); 
    } else {
        console.error('[Main Process] Cannot open dev tools: mainWindow or webContents is not available or destroyed.'); 
        if (!mainWindow) console.error('[Main Process] mainWindow is null or undefined.');
        else if (!mainWindow.webContents) console.error('[Main Process] mainWindow.webContents is null or undefined.');
        else if (mainWindow.webContents.isDestroyed()) console.error('[Main Process] mainWindow.webContents is destroyed.');
    }
});

ipcMain.on('open-image-in-new-window', (event, imageUrl, imageTitle) => {
    console.log(`[Main Process] Received open-image-in-new-window for URL: ${imageUrl}, Title: ${imageTitle}`);
    const imageViewerWindow = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        title: imageTitle || '图片预览',
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

    const viewerUrl = `file://${path.join(__dirname, 'image-viewer.html')}?src=${encodeURIComponent(imageUrl)}&title=${encodeURIComponent(imageTitle || '图片预览')}`;
    console.log(`[Main Process] Loading URL in new window: ${viewerUrl}`);
    imageViewerWindow.loadURL(viewerUrl);
    openChildWindows.push(imageViewerWindow); 
    
    imageViewerWindow.setMenu(null); 

    imageViewerWindow.once('ready-to-show', () => {
        imageViewerWindow.show();
    });

    imageViewerWindow.on('closed', () => {
        console.log('[Main Process] imageViewerWindow has been closed.');
        openChildWindows = openChildWindows.filter(win => win !== imageViewerWindow); // Remove from track
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus(); // 聚焦主窗口
        }
    });
});

ipcMain.on('show-image-context-menu', (event, imageUrl) => {
    console.log(`[Main Process] Received show-image-context-menu for URL: ${imageUrl}`);
    const template = [
        {
            label: '复制图片',
            click: async () => {
                console.log(`[Main Process] Context menu: "复制图片" clicked for ${imageUrl}`);
                if (!imageUrl || (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:') && !imageUrl.startsWith('file:'))) { // Allow file URLs
                    console.error('[Main Process] Invalid image URL for copying:', imageUrl);
                    dialog.showErrorBox('复制错误', '无效的图片URL。');
                    return;
                }

                try {
                    if (imageUrl.startsWith('file:')) {
                        const filePath = decodeURIComponent(imageUrl.substring(7)); // Remove file:// and decode
                        const image = nativeImage.createFromPath(filePath);
                        if (!image.isEmpty()) {
                            clipboard.writeImage(image);
                            console.log('[Main Process] Local image copied to clipboard successfully.');
                        } else {
                             console.error('[Main Process] Failed to create native image from local file path or image is empty.');
                             dialog.showErrorBox('复制失败', '无法从本地文件创建图片对象。');
                        }
                    } else { // http or https
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
                    }
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
