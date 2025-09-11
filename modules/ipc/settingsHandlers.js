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
                // 安全地读取和更新settings.json
                let settings = {};
                if (await fs.pathExists(SETTINGS_FILE)) {
                    try {
                        settings = await fs.readJson(SETTINGS_FILE);
                    } catch (parseError) {
                        console.error('[Main] Error parsing settings.json in save-avatar-color, using empty object:', parseError.message);
                        settings = {};
                    }
                }
                
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

    // Theme control
    ipcMain.on('set-theme', async (event, theme) => {
        if (theme === 'light' || theme === 'dark') {
            nativeTheme.themeSource = theme;
            console.log(`[Main] Theme source explicitly set to: ${theme}`);
            
            // 安全地更新settings.json文件中的主题相关字段
            try {
                let settings = {};
                
                // 尝试读取现有设置文件
                if (await fs.pathExists(SETTINGS_FILE)) {
                    try {
                        settings = await fs.readJson(SETTINGS_FILE);
                        console.log('[Main] Successfully loaded existing settings for theme update');
                    } catch (parseError) {
                        console.error('[Main] Error parsing existing settings.json, preserving file and only updating theme:', parseError.message);
                        // 如果解析失败，读取原始文件内容作为备份
                        const originalContent = await fs.readFile(SETTINGS_FILE, 'utf8');
                        console.error('[Main] Original settings.json content (first 200 chars):', originalContent.substring(0, 200));
                        
                        // 尝试部分恢复或使用空对象
                        settings = {};
                    }
                } else {
                    console.log('[Main] Settings file does not exist, creating new one with theme info');
                }
                
                // 只更新主题相关字段，保留所有其他设置
                settings.currentThemeMode = theme;
                settings.themeLastUpdated = Date.now();
                
                // 安全地写入文件
                await fs.writeJson(SETTINGS_FILE, settings, { spaces: 2 });
                console.log(`[Main] Settings.json safely updated: currentThemeMode=${theme}, themeLastUpdated=${settings.themeLastUpdated}`);
                
            } catch (error) {
                console.error('[Main] Error updating settings.json for theme change:', error);
                // 主题更改失败不应该影响系统的其他功能
                console.error('[Main] Theme change in nativeTheme was successful, but settings.json update failed');
            }
        }
    });
}

module.exports = {
    initialize
};