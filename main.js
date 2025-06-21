// main.js - Electron 主进程

const sharp = require('sharp'); // 确保在文件顶部引入

const { app, BrowserWindow, ipcMain, nativeTheme, globalShortcut, screen } = require('electron'); // Added screen
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
const DistributedServer = require('./VCPDistributedServer/VCPDistributedServer.js'); // Import the new distributed server
const windowHandlers = require('./modules/ipc/windowHandlers'); // Import window IPC handlers
const settingsHandlers = require('./modules/ipc/settingsHandlers'); // Import settings IPC handlers
const fileDialogHandlers = require('./modules/ipc/fileDialogHandlers'); // Import file dialog handlers
const agentHandlers = require('./modules/ipc/agentHandlers'); // Import agent handlers
const chatHandlers = require('./modules/ipc/chatHandlers'); // Import chat handlers
const groupChatHandlers = require('./modules/ipc/groupChatHandlers'); // Import group chat handlers

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
let distributedServer = null; // To hold the distributed server instance


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
    const barWidth = 330; // The width is fixed at creation.
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
        width: 360,
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

    // The 'ready-to-show' logic that sent data prematurely has been removed.
    // The renderer will now request this data when it's ready.

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

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.setMenu(null); // 移除应用程序菜单栏

    // Set theme source to 'system' by default. The renderer will send the saved preference on launch.
    nativeTheme.themeSource = 'system';

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
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // 有人试图运行第二个实例，我们应该聚焦于我们的窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => { // Make the function async
    fs.ensureDirSync(APP_DATA_ROOT_IN_PROJECT); // Ensure the main AppData directory in project exists
    fs.ensureDirSync(AGENT_DIR);
    fs.ensureDirSync(USER_DATA_DIR);
    fileManager.initializeFileManager(USER_DATA_DIR, AGENT_DIR); // Initialize FileManager
    groupChat.initializePaths({ APP_DATA_ROOT_IN_PROJECT, AGENT_DIR, USER_DATA_DIR, SETTINGS_FILE }); // Initialize GroupChat paths
    settingsHandlers.initialize({ SETTINGS_FILE, USER_AVATAR_FILE, AGENT_DIR }); // Initialize settings handlers


    // Group Chat IPC Handlers are now in modules/ipc/groupChatHandlers.js

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
    windowHandlers.initialize(mainWindow);
    fileDialogHandlers.initialize(mainWindow, {
        selectionListenerActive,
        stopSelectionListener,
        startSelectionListener,
        openChildWindows
    });
    groupChatHandlers.initialize(mainWindow, {
        AGENT_DIR,
        USER_DATA_DIR,
        selectionListenerActive,
        stopSelectionListener,
        startSelectionListener
    });
    agentHandlers.initialize({
        AGENT_DIR,
        USER_DATA_DIR,
        SETTINGS_FILE,
        USER_AVATAR_FILE,
        selectionListenerActive,
        stopSelectionListener,
        startSelectionListener
    });
    chatHandlers.initialize(mainWindow, {
        AGENT_DIR,
        USER_DATA_DIR,
        APP_DATA_ROOT_IN_PROJECT,
        NOTES_AGENT_ID,
        selectionListenerActive,
        stopSelectionListener,
        startSelectionListener
    });
    createAssistantBarWindow(); // Pre-create the assistant bar window for performance

    // --- Distributed Server Initialization ---
    (async () => {
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.enableDistributedServer) {
                console.log('[Main] Distributed server is enabled. Initializing...');
                const config = {
                    mainServerUrl: settings.vcpLogUrl, // Assuming the distributed server connects to the same base URL as VCPLog
                    vcpKey: settings.vcpLogKey,
                    serverName: 'VCP-Desktop-Client-Distributed-Server',
                    debugMode: true, // Or read from settings if you add this option
                    rendererProcess: mainWindow.webContents // Pass the renderer process object
                };
                distributedServer = new DistributedServer(config);
                distributedServer.initialize();
            } else {
                console.log('[Main] Distributed server is disabled in settings.');
            }
        } catch (error) {
            console.error('[Main] Failed to read settings or initialize distributed server:', error);
        }
    })();
    // --- End of Distributed Server Initialization ---

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


    // --- Assistant IPC Handlers ---
    ipcMain.handle('get-assistant-bar-initial-data', async () => {
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await getAgentConfigById(settings.assistantAgent);
                return {
                    agentAvatarUrl: agentConfig.avatarUrl,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                };
            }
        } catch (error) {
            console.error('[Main] Error getting initial data for assistant bar:', error);
            return { error: error.message };
        }
        // Return default/empty data if not enabled
        return {
            agentAvatarUrl: null,
            theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
        };
    });

    ipcMain.on('toggle-selection-listener', (event, enable) => {
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

});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    // 1. 停止所有底层监听器
    console.log('[Main] App is quitting. Stopping all listeners...');
    stopSelectionListener();
    if (mouseListener) {
        try {
            mouseListener.kill();
            console.log('[Main] Global mouse listener killed.');
        } catch (e) {
            console.error('[Main] Error killing mouse listener on quit:', e);
        } finally {
            mouseListener = null;
        }
    }

    // 2. 注销所有全局快捷键
    globalShortcut.unregisterAll();
    console.log('[Main] All global shortcuts unregistered.');

    // 3. 关闭WebSocket连接
    if (vcpLogWebSocket && vcpLogWebSocket.readyState === WebSocket.OPEN) {
        vcpLogWebSocket.close();
    }
    if (vcpLogReconnectInterval) {
        clearInterval(vcpLogReconnectInterval);
    }
    
    // 4. Stop the distributed server
    if (distributedServer) {
        console.log('[Main] Stopping distributed server...');
        distributedServer.stop();
        distributedServer = null;
    }

    // 5. 强制销毁所有窗口
    console.log('[Main] Destroying all open windows...');
    BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
            win.destroy();
        }
    });
});

// --- IPC Handlers ---
// open-external-link handler is now in modules/ipc/fileDialogHandlers.js

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

// VCP Server Communication is now handled in modules/ipc/chatHandlers.js

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
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-message', data);
        } catch (e) {
            console.error('VCPLog 解析消息失败:', e);
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-message', { type: 'error', data: `收到无法解析的消息: ${event.data.toString().substring(0,100)}...` });
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
}