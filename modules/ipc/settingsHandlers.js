// modules/ipc/settingsHandlers.js
const { ipcMain, nativeTheme } = require('electron');
const fs = require('fs-extra');
const path = require('path');

/**
 * Initializes settings and theme related IPC handlers.
 * @param {object} paths - An object containing required paths.
 * @param {string} paths.SETTINGS_FILE - The path to the settings.json file.
 * @param {string} paths.USER_AVATAR_FILE - The path to the user_avatar.png file.
 * @param {string} paths.AGENT_DIR - The path to the agents directory.
 */
function initialize(paths) {
    const { SETTINGS_FILE, USER_AVATAR_FILE, AGENT_DIR } = paths;

    // Settings Management
    ipcMain.handle('load-settings', async () => {
        try {
            let settings = {};
            let hasChanges = false;
            
            if (await fs.pathExists(SETTINGS_FILE)) {
                try {
                    settings = await fs.readJson(SETTINGS_FILE);
                } catch (parseError) {
                    console.error('[Main] Error parsing existing settings.json, creating new settings:', parseError.message);
                    settings = {};
                    hasChanges = true;
                }
            } else {
                console.log('[Main] Settings file does not exist, creating new one');
                hasChanges = true;
            }
            
            // 确保默认字段存在
            const defaultSettings = {
                sidebarWidth: 260,
                notificationsSidebarWidth: 300,
                userName: '用户',
                vcpServerUrl: '',
                vcpApiKey: '',
                vcpLogUrl: '',
                vcpLogKey: '',
                networkNotesPaths: [],
                enableAgentBubbleTheme: false,
                enableSmoothStreaming: false,
                minChunkBufferSize: 1,
                smoothStreamIntervalMs: 25,
                assistantAgent: '',
                enableDistributedServer: true,
                agentMusicControl: false,
                enableDistributedServerLogs: false, // 修复：确保此字段始终存在
                enableVcpToolInjection: false
            };
            
            // 合并默认设置，只添加缺失的字段
            for (const [key, defaultValue] of Object.entries(defaultSettings)) {
                if (!(key in settings)) {
                    settings[key] = defaultValue;
                    hasChanges = true;
                }
            }
            
            // Check for user avatar
            if (await fs.pathExists(USER_AVATAR_FILE)) {
                settings.userAvatarUrl = `file://${USER_AVATAR_FILE}?t=${Date.now()}`;
            } else {
                settings.userAvatarUrl = null; // Or a default path
            }
            
            // 如果有变化，保存设置文件
            if (hasChanges) {
                try {
                    const { userAvatarUrl, ...settingsToSave } = settings;
                    await fs.writeJson(SETTINGS_FILE, settingsToSave, { spaces: 2 });
                    console.log('[Main] Settings file updated with missing default fields');
                } catch (writeError) {
                    console.error('[Main] Error writing updated settings:', writeError.message);
                }
            }
            
            return settings;
        } catch (error) {
            console.error('加载设置失败:', error);
            return { 
                error: error.message,
                sidebarWidth: 260,
                notificationsSidebarWidth: 300,
                userAvatarUrl: null,
                enableDistributedServerLogs: false // 修复：确保错误情况下也有默认值
            };
        }
    });

    ipcMain.handle('save-settings', async (event, settings) => {
        try {
            // User avatar URL is handled by 'save-user-avatar', remove it from general settings to avoid saving a file path
            const { userAvatarUrl, ...settingsToSave } = settings;
            
            // 确保必需的默认字段存在
            if (settingsToSave.enableDistributedServerLogs === undefined) {
                settingsToSave.enableDistributedServerLogs = false;
            }
            
            // 使用安全的文件写入方式
            const tempFile = SETTINGS_FILE + '.tmp';
            await fs.writeJson(tempFile, settingsToSave, { spaces: 2 });
            
            // 验证写入的文件是否正确
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent); // 检查JSON格式是否正确
            
            // 如果验证成功，再重命名为正式文件
            await fs.move(tempFile, SETTINGS_FILE, { overwrite: true });
            
            return { success: true };
        } catch (error) {
            console.error('保存设置失败:', error);
            
            // 清理可能存在的临时文件
            const tempFile = SETTINGS_FILE + '.tmp';
            if (await fs.pathExists(tempFile)) {
                await fs.remove(tempFile).catch(() => {});
            }
            
            return { error: error.message };
        }
    });

    // New IPC Handler to save calculated avatar color
    ipcMain.handle('save-avatar-color', async (event, { type, id, color }) => {
        try {
            if (type === 'user') {
                // 安全地读取和更新settings.json
                let settings = {};
                if (await fs.pathExists(SETTINGS_FILE)) {
                    try {
                        settings = await fs.readJson(SETTINGS_FILE);
                    } catch (parseError) {
                        console.error('[Main] Error parsing settings.json in save-avatar-color, attempting recovery:', parseError.message);
                        const originalContent = await fs.readFile(SETTINGS_FILE, 'utf8').catch(() => null);
                        settings = await recoverSettingsFromCorruptedFile(originalContent);
                    }
                }
                
                settings.userAvatarCalculatedColor = color;
                
                // 使用安全的文件写入方式
                const tempFile = SETTINGS_FILE + '.tmp';
                const { userAvatarUrl, ...settingsToSave } = settings; // 移除临时字段
                await fs.writeJson(tempFile, settingsToSave, { spaces: 2 });
                
                // 验证写入的文件是否正确
                const verifyContent = await fs.readFile(tempFile, 'utf8');
                JSON.parse(verifyContent);
                
                // 如果验证成功，再重命名为正式文件
                await fs.move(tempFile, SETTINGS_FILE, { overwrite: true });
                
                console.log(`[Main] User avatar color saved: ${color}`);
                return { success: true };
            } else if (type === 'agent' && id) {
                const configPath = path.join(AGENT_DIR, id, 'config.json');
                if (await fs.pathExists(configPath)) {
                    let agentConfig;
                    try {
                        agentConfig = await fs.readJson(configPath);
                    } catch (parseError) {
                        console.error(`[Main] Error parsing agent config for ${id}, using basic structure:`, parseError.message);
                        agentConfig = { id: id };
                    }
                    
                    agentConfig.avatarCalculatedColor = color;
                    
                    // 使用安全的文件写入方式
                    const tempConfigPath = configPath + '.tmp';
                    await fs.writeJson(tempConfigPath, agentConfig, { spaces: 2 });
                    
                    // 验证写入的文件是否正确
                    const verifyContent = await fs.readFile(tempConfigPath, 'utf8');
                    JSON.parse(verifyContent);
                    
                    // 如果验证成功，再重命名为正式文件
                    await fs.move(tempConfigPath, configPath, { overwrite: true });
                    
                    console.log(`[Main] Agent ${id} avatar color saved: ${color}`);
                    return { success: true };
                } else {
                    return { success: false, error: `Agent config for ${id} not found.` };
                }
            }
            return { success: false, error: 'Invalid type or missing ID for saving avatar color.' };
        } catch (error) {
            console.error('Error saving avatar color:', error);
            
            // 清理可能存在的临时文件
            const tempFile = SETTINGS_FILE + '.tmp';
            const tempConfigPath = type === 'agent' && id ? path.join(AGENT_DIR, id, 'config.json') + '.tmp' : null;
            
            try {
                if (await fs.pathExists(tempFile)) {
                    await fs.remove(tempFile);
                }
                if (tempConfigPath && await fs.pathExists(tempConfigPath)) {
                    await fs.remove(tempConfigPath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up temporary files:', cleanupError.message);
            }
            
            return { success: false, error: error.message };
        }
    });

    // Theme control
    ipcMain.on('set-theme', async (event, theme) => {
        if (theme === 'light' || theme === 'dark') {
            nativeTheme.themeSource = theme;
            console.log(`[Main] Theme source explicitly set to: ${theme}`);
            
            // 安全地更新settings.json文件中的主题相关字段
            try {
                let settings = {};
                let originalContent = null;
                
                // 尝试读取现有设置文件
                if (await fs.pathExists(SETTINGS_FILE)) {
                    try {
                        const fileContent = await fs.readFile(SETTINGS_FILE, 'utf8');
                        originalContent = fileContent; // 保存原始内容作为备份
                        settings = JSON.parse(fileContent);
                        console.log('[Main] Successfully loaded existing settings for theme update');
                    } catch (parseError) {
                        console.error('[Main] Error parsing existing settings.json, attempting recovery:', parseError.message);
                        
                        // 记录原始文件内容
                        if (originalContent) {
                            console.error('[Main] Original settings.json content (first 500 chars):', originalContent.substring(0, 500));
                        }
                        
                        // 尝试从损坏的文件中恢复部分设置
                        settings = await recoverSettingsFromCorruptedFile(originalContent);
                        console.log('[Main] Recovered settings:', Object.keys(settings));
                    }
                } else {
                    console.log('[Main] Settings file does not exist, creating new one with theme info');
                    // 使用与 load-settings 中相同的默认设置
                    settings = {
                        sidebarWidth: 260,
                        notificationsSidebarWidth: 300,
                        userName: '用户',
                        vcpServerUrl: '',
                        vcpApiKey: '',
                        vcpLogUrl: '',
                        vcpLogKey: '',
                        networkNotesPaths: [],
                        enableAgentBubbleTheme: false,
                        enableSmoothStreaming: false,
                        minChunkBufferSize: 1,
                        smoothStreamIntervalMs: 25,
                        assistantAgent: '',
                        enableDistributedServer: true,
                        agentMusicControl: false,
                        enableDistributedServerLogs: false,
                        enableVcpToolInjection: false
                    };
                }
                
                // 只更新主题相关字段，保留所有其他设置
                settings.currentThemeMode = theme;
                settings.themeLastUpdated = Date.now();
                
                // 安全地写入文件 - 先写入临时文件，再重命名
                const tempFile = SETTINGS_FILE + '.tmp';
                try {
                    await fs.writeJson(tempFile, settings, { spaces: 2 });
                    
                    // 验证临时文件是否正确
                    const verifyContent = await fs.readFile(tempFile, 'utf8');
                    JSON.parse(verifyContent); // 检查JSON格式是否正确
                    
                    // 如果验证成功，再重命名为正式文件
                    await fs.move(tempFile, SETTINGS_FILE, { overwrite: true });
                    console.log(`[Main] Settings.json safely updated: currentThemeMode=${theme}, themeLastUpdated=${settings.themeLastUpdated}`);
                    
                } catch (tempWriteError) {
                    console.error('[Main] Error writing temporary settings file:', tempWriteError.message);
                    // 清理临时文件
                    if (await fs.pathExists(tempFile)) {
                        await fs.remove(tempFile).catch(() => {});
                    }
                    throw tempWriteError;
                }
                
            } catch (error) {
                console.error('[Main] Error updating settings.json for theme change:', error);
                console.error('[Main] Theme change in nativeTheme was successful, but settings.json update failed');
                
                // 在发生错误时，尝试将主题更新传送给渲染进程
                // 这样即使设置文件更新失败，用户界面也可以正确显示主题
                if (event && event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('theme-updated', { theme, timestamp: Date.now() });
                }
            }
        }
    });
    
    // 帮助函数：从损坏的设置文件中恢复数据
    async function recoverSettingsFromCorruptedFile(originalContent) {
        const recovered = {
            sidebarWidth: 260,
            notificationsSidebarWidth: 300,
            userName: '用户',
            vcpServerUrl: '',
            vcpApiKey: '',
            vcpLogUrl: '',
            vcpLogKey: '',
            networkNotesPaths: [],
            enableAgentBubbleTheme: false,
            enableSmoothStreaming: false,
            minChunkBufferSize: 1,
            smoothStreamIntervalMs: 25,
            assistantAgent: '',
            enableDistributedServer: true,
            agentMusicControl: false,
            enableDistributedServerLogs: false,
            enableVcpToolInjection: false
        };
        
        if (!originalContent) {
            return recovered;
        }
        
        try {
            // 尝试使用正则表达式提取可能的字段值
            const patterns = {
                userName: /"userName"\s*:\s*"([^"]*)"/,
                vcpServerUrl: /"vcpServerUrl"\s*:\s*"([^"]*)"/,
                vcpApiKey: /"vcpApiKey"\s*:\s*"([^"]*)"/,
                vcpLogUrl: /"vcpLogUrl"\s*:\s*"([^"]*)"/,
                vcpLogKey: /"vcpLogKey"\s*:\s*"([^"]*)"/,
                sidebarWidth: /"sidebarWidth"\s*:\s*(\d+)/,
                notificationsSidebarWidth: /"notificationsSidebarWidth"\s*:\s*(\d+)/,
                enableDistributedServer: /"enableDistributedServer"\s*:\s*(true|false)/,
                agentMusicControl: /"agentMusicControl"\s*:\s*(true|false)/,
                enableDistributedServerLogs: /"enableDistributedServerLogs"\s*:\s*(true|false)/,
                enableVcpToolInjection: /"enableVcpToolInjection"\s*:\s*(true|false)/,
                enableAgentBubbleTheme: /"enableAgentBubbleTheme"\s*:\s*(true|false)/,
                enableSmoothStreaming: /"enableSmoothStreaming"\s*:\s*(true|false)/,
                minChunkBufferSize: /"minChunkBufferSize"\s*:\s*(\d+)/,
                smoothStreamIntervalMs: /"smoothStreamIntervalMs"\s*:\s*(\d+)/,
                assistantAgent: /"assistantAgent"\s*:\s*"([^"]*)"/
            };
            
            for (const [key, pattern] of Object.entries(patterns)) {
                const match = originalContent.match(pattern);
                if (match) {
                    const value = match[1];
                    if (key === 'sidebarWidth' || key === 'notificationsSidebarWidth' || 
                        key === 'minChunkBufferSize' || key === 'smoothStreamIntervalMs') {
                        recovered[key] = parseInt(value, 10);
                    } else if (key === 'enableDistributedServer' || key === 'agentMusicControl' || 
                              key === 'enableDistributedServerLogs' || key === 'enableVcpToolInjection' ||
                              key === 'enableAgentBubbleTheme' || key === 'enableSmoothStreaming') {
                        recovered[key] = value === 'true';
                    } else {
                        recovered[key] = value;
                    }
                    console.log(`[Main] Recovered ${key}: ${recovered[key]}`);
                }
            }
            
            // 尝试恢复 networkNotesPaths 数组
            const networkPathsMatch = originalContent.match(/"networkNotesPaths"\s*:\s*\[([^\]]*)/s);
            if (networkPathsMatch) {
                try {
                    const arrayContent = '[' + networkPathsMatch[1] + ']';
                    const parsedArray = JSON.parse(arrayContent.replace(/,$/, ''));
                    if (Array.isArray(parsedArray)) {
                        recovered.networkNotesPaths = parsedArray;
                        console.log(`[Main] Recovered networkNotesPaths:`, recovered.networkNotesPaths);
                    }
                } catch (arrayParseError) {
                    console.warn('[Main] Could not recover networkNotesPaths array, using default');
                }
            }
            
        } catch (recoverError) {
            console.error('[Main] Error during settings recovery:', recoverError.message);
        }
        
        return recovered;
    }
}

module.exports = {
    initialize
};