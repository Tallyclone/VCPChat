// preload.js
const { contextBridge, ipcRenderer, clipboard: topLevelClipboard } = require('electron'); // topLevelClipboard 仍可用于 readText

console.log('[Preload TOP LEVEL] typeof topLevelClipboard:', typeof topLevelClipboard);
if (topLevelClipboard) {
    console.log('[Preload TOP LEVEL] topLevelClipboard keys:', Object.keys(topLevelClipboard));
    console.log('[Preload TOP LEVEL] typeof topLevelClipboard.readImage:', typeof topLevelClipboard.readImage); // 这行日志预期会显示 function，但实际调用时可能出问题
    console.log('[Preload TOP LEVEL] typeof topLevelClipboard.readText:', typeof topLevelClipboard.readText);
} else {
    console.error('[Preload TOP LEVEL] topLevelClipboard is undefined or null at top level even after direct destructuring!');
}

contextBridge.exposeInMainWorld('electronAPI', {
    // Settings
    loadSettings: () => ipcRenderer.invoke('load-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // Agents
    getAgents: () => ipcRenderer.invoke('get-agents'),
    getAgentConfig: (agentId) => ipcRenderer.invoke('get-agent-config', agentId),
    saveAgentConfig: (agentId, config) => ipcRenderer.invoke('save-agent-config', agentId, config),
    selectAvatar: () => ipcRenderer.invoke('select-avatar'),
    saveAvatar: (agentId, avatarData) => ipcRenderer.invoke('save-avatar', agentId, avatarData), // avatarData is { name, type, buffer }
    createAgent: (agentName, initialConfig) => ipcRenderer.invoke('create-agent', agentName, initialConfig),
    deleteAgent: (agentId) => ipcRenderer.invoke('delete-agent', agentId),

    // Topic related
    getAgentTopics: (agentId) => ipcRenderer.invoke('get-agent-topics', agentId),
    createNewTopicForAgent: (agentId, topicName) => ipcRenderer.invoke('create-new-topic-for-agent', agentId, topicName),
    saveAgentTopicTitle: (agentId, topicId, newTitle) => ipcRenderer.invoke('save-agent-topic-title', agentId, topicId, newTitle),
    deleteTopic: (agentId, topicId) => ipcRenderer.invoke('delete-topic', agentId, topicId),

    // Chat History
    getChatHistory: (agentId, topicId) => ipcRenderer.invoke('get-chat-history', agentId, topicId),
    saveChatHistory: (agentId, topicId, history) => ipcRenderer.invoke('save-chat-history', agentId, topicId, history),

    // File Handling
    handleFilePaste: (agentId, topicId, fileData) => ipcRenderer.invoke('handle-file-paste', agentId, topicId, fileData),
    selectFilesToSend: (agentId, topicId) => ipcRenderer.invoke('select-files-to-send', agentId, topicId),
    getFileAsBase64: (filePath) => ipcRenderer.invoke('get-file-as-base64', filePath),
    getTextContent: (filePath, fileType) => ipcRenderer.invoke('get-text-content', filePath, fileType),
    handleTextPasteAsFile: (agentId, topicId, textContent) => ipcRenderer.invoke('handle-text-paste-as-file', agentId, topicId, textContent),
    handleFileDrop: (agentId, topicId, droppedFilesData) => ipcRenderer.invoke('handle-file-drop', agentId, topicId, droppedFilesData),
 
    // Agent and Topic Order
    saveAgentOrder: (orderedAgentIds) => ipcRenderer.invoke('save-agent-order', orderedAgentIds),
    saveTopicOrder: (agentId, orderedTopicIds) => ipcRenderer.invoke('save-topic-order', agentId, orderedTopicIds),

    // VCP Communication
    sendToVCP: (vcpUrl, vcpApiKey, messages, modelConfig, messageId) => ipcRenderer.invoke('send-to-vcp', vcpUrl, vcpApiKey, messages, modelConfig, messageId),
    onVCPStreamChunk: (callback) => ipcRenderer.on('vcp-stream-chunk', (_event, eventData) => callback(eventData)),

    // VCPLog Notifications
    connectVCPLog: (url, key) => ipcRenderer.send('connect-vcplog', { url, key }),
    disconnectVCPLog: () => ipcRenderer.send('disconnect-vcplog'),
    onVCPLogMessage: (callback) => ipcRenderer.on('vcp-log-message', (_event, value) => callback(value)),
    onVCPLogStatus: (callback) => ipcRenderer.on('vcp-log-status', (_event, value) => callback(value)),

    // Clipboard functions
    readImageFromClipboard: async () => {
        console.log('[Preload - readImageFromClipboard] Function called. Invoking main process handler.');
        try {
            const result = await ipcRenderer.invoke('read-image-from-clipboard-main');
            if (result && result.success) {
                console.log('[Preload - readImageFromClipboard] Received image data from main process.');
                return { data: result.data, extension: result.extension }; // Pass along data and extension
            } else {
                console.error('[Preload - readImageFromClipboard] Main process failed to read image:', result ? result.error : 'Unknown error from main');
                return null;
            }
        } catch (error) {
            console.error('[Preload - readImageFromClipboard] Error invoking "read-image-from-clipboard-main":', error);
            return null;
        }
    },

    readTextFromClipboard: async () => {
        console.log('[Preload - readTextFromClipboard] Function called.');
        // 继续使用 topLevelClipboard 读取文本，如果这个之前是好的话。
        // 如果 readText 也存在类似问题，也可以改成 IPC 调用主进程。
        // 为保持一致性和健壮性，我们也可以将 readText 也移到主进程：
        // 1. 在 main.js 添加 ipcMain.handle('read-text-from-clipboard-main', async () => clipboard.readText());
        // 2. 此处修改为: return ipcRenderer.invoke('read-text-from-clipboard-main');
        // 这里暂时保留原来的方式，如果图片读取通过主进程解决了，可以再考虑是否统一。

        if (typeof topLevelClipboard === 'undefined' || topLevelClipboard === null) {
            console.error('[Preload - readTextFromClipboard] topLevelClipboard (from preload top scope) is undefined or null INSIDE function.');
            // 可以添加紧急备用方案，或者也改成IPC
            return "";
        }

        if (typeof topLevelClipboard.readText !== 'function') {
            console.error('[Preload - readTextFromClipboard]: topLevelClipboard.readText method is not available! topLevelClipboard keys:', Object.keys(topLevelClipboard));
            return "";
        }
        try {
            return topLevelClipboard.readText();
        } catch(e) {
            console.error('[Preload - readTextFromClipboard] Error using topLevelClipboard for text:', e);
            return "";
        }
    },

    // Window Controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    openDevTools: () => ipcRenderer.send('open-dev-tools'), // Add this line
    onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', (_event) => callback()),
    onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', (_event) => callback()),

    // Image Context Menu
    showImageContextMenu: (imageUrl) => ipcRenderer.send('show-image-context-menu', imageUrl),
    // Open Image in New Window
    openImageInNewWindow: (imageUrl, imageTitle) => ipcRenderer.send('open-image-in-new-window', imageUrl, imageTitle),
    // Open Text in New Window (Read Mode)
    openTextInNewWindow: async (textContent, windowTitle, theme) => { // Added theme parameter
        console.log('[Preload] openTextInNewWindow called (invoke with new channel). Title:', windowTitle, 'Content length:', textContent.length, 'Theme:', theme);
        try {
            await ipcRenderer.invoke('display-text-content-in-viewer', textContent, windowTitle, theme); // Pass theme parameter
            console.log('[Preload] ipcRenderer.invoke("display-text-content-in-viewer") was CALLED and awaited.');
        } catch (e) {
            console.error('[Preload] Error during ipcRenderer.invoke("display-text-content-in-viewer"):', e);
        }
    },

    // Open External Link
    sendOpenExternalLink: (url) => ipcRenderer.send('open-external-link', url)
});

// Log the electronAPI object as it's defined in preload.js right after exposing it
const electronAPIForLogging = {
    loadSettings: "function", saveSettings: "function", getAgents: "function", getAgentConfig: "function",
    saveAgentConfig: "function", selectAvatar: "function", saveAvatar: "function", createAgent: "function",
    deleteAgent: "function", getAgentTopics: "function", createNewTopicForAgent: "function",
    saveAgentTopicTitle: "function", deleteTopic: "function", getChatHistory: "function",
    saveChatHistory: "function", handleFilePaste: "function", selectFilesToSend: "function",
    getFileAsBase64: "function", getTextContent: "function", handleTextPasteAsFile: "function",
    handleFileDrop: "function", sendToVCP: "function", onVCPStreamChunk: "function",
    connectVCPLog: "function", disconnectVCPLog: "function", onVCPLogMessage: "function",
    onVCPLogStatus: "function", readImageFromClipboard: "function", readTextFromClipboard: "function",
    minimizeWindow: "function", maximizeWindow: "function", unmaximizeWindow: "function", closeWindow: "function",
    onWindowMaximized: "function", onWindowUnmaximized: "function",
    showImageContextMenu: "function", // Added for logging
    openImageInNewWindow: "function" // Added for logging
};
console.log('[Preload] electronAPI object that *should* be exposed (structure check):', electronAPIForLogging);
console.log('preload.js loaded and contextBridge exposure attempted.');
