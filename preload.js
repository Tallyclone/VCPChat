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
    saveUserAvatar: (avatarData) => ipcRenderer.invoke('save-user-avatar', avatarData), // New for user avatar

    // Agents
    getAgents: () => ipcRenderer.invoke('get-agents'),
    getAgentConfig: (agentId) => ipcRenderer.invoke('get-agent-config', agentId),
    saveAgentConfig: (agentId, config) => ipcRenderer.invoke('save-agent-config', agentId, config),
    selectAvatar: () => ipcRenderer.invoke('select-avatar'), // This can be used for both, or make a specific one for user
    saveAvatar: (agentId, avatarData) => ipcRenderer.invoke('save-avatar', agentId, avatarData), // For agent avatar
    createAgent: (agentName, initialConfig) => ipcRenderer.invoke('create-agent', agentName, initialConfig),
    deleteAgent: (agentId) => ipcRenderer.invoke('delete-agent', agentId),

    // Topic related
    getAgentTopics: (agentId) => ipcRenderer.invoke('get-agent-topics', agentId),
    createNewTopicForAgent: (agentId, topicName, refreshTimestamp) => ipcRenderer.invoke('create-new-topic-for-agent', agentId, topicName, refreshTimestamp),
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

    // Notes
    readTxtNotes: () => ipcRenderer.invoke('read-txt-notes'),
    writeTxtNote: (noteData) => ipcRenderer.invoke('write-txt-note', noteData),
    deleteTxtNote: (fileName) => ipcRenderer.invoke('delete-txt-note', fileName),
    savePastedImageToFile: (imageData, noteId) => ipcRenderer.invoke('save-pasted-image-to-file', imageData, noteId),

    // Open Notes Window
    openNotesWindow: (theme) => ipcRenderer.invoke('open-notes-window', theme),
    // For sharing content to a new notes window
    openNotesWithContent: (data) => ipcRenderer.invoke('open-notes-with-content', data), // data: { title, content, theme }
 
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
        console.log('[Preload - readTextFromClipboard] Function called. Invoking main process handler.');
        try {
            const result = await ipcRenderer.invoke('read-text-from-clipboard-main');
            if (result && result.success) {
                console.log('[Preload - readTextFromClipboard] Received text from main process.');
                return result.text;
            } else {
                console.error('[Preload - readTextFromClipboard] Main process failed to read text:', result ? result.error : 'Unknown error from main');
                return ""; // Return empty string on failure
            }
        } catch (error) {
            console.error('[Preload - readTextFromClipboard] Error invoking "read-text-from-clipboard-main":', error);
            return ""; // Return empty string on error
        }
    },

    // Window Controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    openDevTools: () => ipcRenderer.send('open-dev-tools'),
    sendToggleNotificationsSidebar: () => ipcRenderer.send('toggle-notifications-sidebar'), 
    onDoToggleNotificationsSidebar: (callback) => ipcRenderer.on('do-toggle-notifications-sidebar', (_event) => callback()), 
    openAdminPanel: () => ipcRenderer.invoke('open-admin-panel'), 
    onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', (_event) => callback()),
    onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', (_event) => callback()),

    // Image Context Menu
    showImageContextMenu: (imageUrl) => ipcRenderer.send('show-image-context-menu', imageUrl),
    // Open Image in New Window
    openImageInNewWindow: (imageUrl, imageTitle) => ipcRenderer.send('open-image-in-new-window', imageUrl, imageTitle),
    // Open Text in New Window (Read Mode)
    openTextInNewWindow: async (textContent, windowTitle, theme) => { 
        console.log('[Preload] openTextInNewWindow called (invoke with new channel). Title:', windowTitle, 'Content length:', textContent.length, 'Theme:', theme);
        try {
            await ipcRenderer.invoke('display-text-content-in-viewer', textContent, windowTitle, theme); 
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
    handleFileDrop: "function",
    readTxtNotes: "function", 
    writeTxtNote: "function", 
    deleteTxtNote: "function", 
    openNotesWindow: "function",
    openNotesWithContent: "function", 
    saveAgentOrder: "function", 
    saveTopicOrder: "function", 
    sendToVCP: "function", onVCPStreamChunk: "function",
    connectVCPLog: "function", disconnectVCPLog: "function", onVCPLogMessage: "function",
    onVCPLogStatus: "function", readImageFromClipboard: "function", readTextFromClipboard: "function",
    minimizeWindow: "function", maximizeWindow: "function", unmaximizeWindow: "function", closeWindow: "function",
    openDevTools: "function",
    openAdminPanel: "function",
    onWindowMaximized: "function", onWindowUnmaximized: "function",
    showImageContextMenu: "function",
    openImageInNewWindow: "function",
    saveUserAvatar: "function" // Added
};
console.log('[Preload] electronAPI object that *should* be exposed (structure check):', electronAPIForLogging);
console.log('preload.js loaded and contextBridge exposure attempted.');