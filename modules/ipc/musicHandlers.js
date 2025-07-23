// modules/ipc/musicHandlers.js

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { Worker } = require('worker_threads');

let musicWindow = null;
let currentSongInfo = null;
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let MUSIC_PLAYLIST_FILE;
let MUSIC_COVER_CACHE_DIR;

// --- Singleton Music Window Creation Function ---
function createOrFocusMusicWindow() {
    return new Promise((resolve, reject) => {
        if (musicWindow && !musicWindow.isDestroyed()) {
            console.log('[Music] Music window already exists. Focusing it.');
            musicWindow.focus();
            resolve(musicWindow);
            return;
        }

        console.log('[Music] Creating new music window instance.');
        musicWindow = new BrowserWindow({
            width: 550,
            height: 800,
            minWidth: 400,
            minHeight: 600,
            title: '音乐播放器',
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
            show: false
        });

        musicWindow.loadFile(path.join(__dirname, '..', '..', 'Musicmodules', 'music.html'));
        
        openChildWindows.push(musicWindow);
        musicWindow.setMenu(null);

        musicWindow.once('ready-to-show', () => {
            musicWindow.show();
        });

        // Wait for the renderer to signal that it's ready
        ipcMain.once('music-renderer-ready', (event) => {
            if (event.sender === musicWindow.webContents) {
                console.log('[Music] Received "music-renderer-ready" signal. Resolving promise.');
                resolve(musicWindow);
            }
        });

        musicWindow.on('closed', () => {
            openChildWindows = openChildWindows.filter(win => win !== musicWindow);
            musicWindow = null;
        });

        musicWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[Music] Music window failed to load: ${errorDescription} (code: ${errorCode})`);
            reject(new Error(`Music window failed to load: ${errorDescription}`));
        });
    });
}

// --- Music Control Handler ---
async function handleMusicControl(args) {
    const { command, target } = args;
    console.log(`[MusicControl] Received command: ${command}, Target: ${target}`);

    try {
        const targetWindow = await createOrFocusMusicWindow();
        targetWindow.webContents.send('music-command', { command, target });
        const successMsg = `指令 '${command}' 已成功发送给播放器。`;
        console.log(`[MusicControl] ${successMsg}`);
        return { status: 'success', message: successMsg };
    } catch (error) {
        const errorMsg = `处理音乐指令失败: ${error.message}`;
        console.error(`[MusicControl] ${errorMsg}`, error);
        return { status: 'error', message: errorMsg };
    }
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    const APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
    MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');

    ipcMain.on('open-music-window', async () => {
        try {
            await createOrFocusMusicWindow();
        } catch (error) {
            console.error("[Music] Failed to open or focus music window from IPC:", error);
        }
    });

    ipcMain.on('music-track-changed', (event, songInfo) => {
        currentSongInfo = songInfo;
    });

    ipcMain.on('open-music-folder', async (event) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });

        if (result.canceled || result.filePaths.length === 0) {
            return;
        }

        const folderPath = result.filePaths[0];
        const supportedFormats = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);
        const fileList = [];

        async function collectFilePaths(dir) {
            try {
                const files = await fs.readdir(dir, { withFileTypes: true });
                for (const file of files) {
                    const fullPath = path.join(dir, file.name);
                    if (file.isDirectory()) {
                        await collectFilePaths(fullPath);
                    } else if (supportedFormats.has(path.extname(file.name).toLowerCase())) {
                        fileList.push(fullPath);
                    }
                }
            } catch (err) {
                console.error(`Error collecting file paths in ${dir}:`, err);
            }
        }

        try {
            await collectFilePaths(folderPath);
            event.sender.send('scan-started', { total: fileList.length });

            await fs.ensureDir(MUSIC_COVER_CACHE_DIR);

            const worker = new Worker(path.join(__dirname, '..', '..', 'modules', 'musicScannerWorker.js'), {
                workerData: {
                    coverCachePath: MUSIC_COVER_CACHE_DIR
                }
            });
            const finalPlaylist = [];
            let processedCount = 0;

            worker.on('message', (result) => {
                if (result.status === 'success') {
                    finalPlaylist.push(result.data);
                } else {
                    console.error(result.error);
                }
                
                processedCount++;
                event.sender.send('scan-progress');

                if (processedCount === fileList.length) {
                    event.sender.send('scan-finished', finalPlaylist);
                    worker.terminate();
                }
            });

            worker.on('error', (error) => {
                console.error('Worker thread error:', error);
                event.sender.send('scan-finished', finalPlaylist);
                worker.terminate();
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`Worker stopped with exit code ${code}`);
                }
            });

            fileList.forEach(filePath => worker.postMessage(filePath));

        } catch (err) {
            console.error("Error during music scan setup:", err);
            event.sender.send('scan-finished', []);
        }
    });

    ipcMain.handle('get-music-playlist', async () => {
        try {
            if (await fs.pathExists(MUSIC_PLAYLIST_FILE)) {
                return await fs.readJson(MUSIC_PLAYLIST_FILE);
            }
            return [];
        } catch (error) {
            console.error('Error reading music playlist:', error);
            return [];
        }
    });

    ipcMain.on('save-music-playlist', async (event, playlist) => {
        try {
            await fs.writeJson(MUSIC_PLAYLIST_FILE, playlist, { spaces: 2 });
        } catch (error) {
            console.error('Error saving music playlist:', error);
        }
    });

    ipcMain.on('share-file-to-main', (event, filePath) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            console.log(`[Music] Forwarding shared file to renderer: ${filePath}`);
            mainWindow.webContents.send('add-file-to-input', filePath);
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

module.exports = {
    initialize,
    handleMusicControl,
    getMusicState: () => ({ musicWindow, currentSongInfo })
};