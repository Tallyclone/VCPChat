// --- Globals ---
let globalSettings = {
    sidebarWidth: 260,
    notificationsSidebarWidth: 300,
    userName: '用户', // Default username
};
// Unified selected item state
let currentSelectedItem = {
    id: null, // Can be agentId or groupId
    type: null, // 'agent' or 'group'
    name: null,
    avatarUrl: null,
    config: null // Store full config object for the selected item
};
let currentTopicId = null;
let currentChatHistory = [];
let attachedFiles = [];
// let activeStreamingMessageId = null; // REMOVED

// --- DOM Elements ---
const itemListUl = document.getElementById('agentList'); // Renamed from agentListUl to itemListUl
const currentChatNameH3 = document.getElementById('currentChatAgentName'); // Will show Agent or Group name
const chatMessagesDiv = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const attachmentPreviewArea = document.getElementById('attachmentPreviewArea');

const globalSettingsBtn = document.getElementById('globalSettingsBtn');
const globalSettingsModal = document.getElementById('globalSettingsModal');
const globalSettingsForm = document.getElementById('globalSettingsForm');
const userAvatarInput = document.getElementById('userAvatarInput');
const userAvatarPreview = document.getElementById('userAvatarPreview');

const createNewAgentBtn = document.getElementById('createNewAgentBtn'); // Text will change
const createNewGroupBtn = document.getElementById('createNewGroupBtn'); // New button

const itemSettingsContainerTitle = document.getElementById('agentSettingsContainerTitle'); // Will be itemSettingsContainerTitle
const selectedItemNameForSettingsSpan = document.getElementById('selectedAgentNameForSettings'); // Will show Agent or Group name

// Agent specific settings elements (will be hidden if a group is selected)
const agentSettingsContainer = document.getElementById('agentSettingsContainer');
const agentSettingsForm = document.getElementById('agentSettingsForm');
const editingAgentIdInput = document.getElementById('editingAgentId');
const agentNameInput = document.getElementById('agentNameInput');
const agentAvatarInput = document.getElementById('agentAvatarInput');
const agentAvatarPreview = document.getElementById('agentAvatarPreview');
const agentSystemPromptTextarea = document.getElementById('agentSystemPrompt');
const agentModelInput = document.getElementById('agentModel');
const agentTemperatureInput = document.getElementById('agentTemperature');
const agentContextTokenLimitInput = document.getElementById('agentContextTokenLimit');
const agentMaxOutputTokensInput = document.getElementById('agentMaxOutputTokens');

// Group specific settings elements (placeholder, grouprenderer.js will populate)
const groupSettingsContainer = document.getElementById('groupSettingsContainer'); // This should be the div renderer creates

const selectItemPromptForSettings = document.getElementById('selectAgentPromptForSettings'); // Will be "Select an item..."
console.log('[Renderer EARLY CHECK] selectItemPromptForSettings element:', selectItemPromptForSettings); // 添加日志
const deleteItemBtn = document.getElementById('deleteAgentBtn'); // Will be deleteItemBtn for agent or group

const currentItemActionBtn = document.getElementById('currentAgentSettingsBtn'); // Text will change (e.g. "New Topic" / "New Group Topic")
const clearCurrentChatBtn = document.getElementById('clearCurrentChatBtn');
const openAdminPanelBtn = document.getElementById('openAdminPanelBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const toggleNotificationsBtn = document.getElementById('toggleNotificationsBtn');

const notificationsSidebar = document.getElementById('notificationsSidebar');
const vcpLogConnectionStatusDiv = document.getElementById('vcpLogConnectionStatus');
const notificationsListUl = document.getElementById('notificationsList');
const clearNotificationsBtn = document.getElementById('clearNotificationsBtn');

const sidebarTabButtons = document.querySelectorAll('.sidebar-tab-button');
const sidebarTabContents = document.querySelectorAll('.sidebar-tab-content');
const tabContentTopics = document.getElementById('tabContentTopics');
const tabContentSettings = document.getElementById('tabContentSettings');

const topicSearchInput = document.getElementById('topicSearchInput'); // Should be in tabContentTopics

const leftSidebar = document.querySelector('.sidebar');
const rightNotificationsSidebar = document.getElementById('notificationsSidebar');
const resizerLeft = document.getElementById('resizerLeft');
const resizerRight = document.getElementById('resizerRight');

const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const restoreBtn = document.getElementById('restore-btn');
const closeBtn = document.getElementById('close-btn');
const settingsBtn = document.getElementById('settings-btn'); // DevTools button

let croppedAgentAvatarFile = null; // For agent avatar
let croppedUserAvatarFile = null; // For user avatar
let croppedGroupAvatarFile = null; // For group avatar, to be managed by GroupRenderer or centrally

const notificationTitleElement = document.getElementById('notificationTitle');
const digitalClockElement = document.getElementById('digitalClock');
const dateDisplayElement = document.getElementById('dateDisplay');

// UI Helper functions to be passed to modules
const uiHelperFunctions = {
    openModal: openModal,
    closeModal: closeModal,
    autoResizeTextarea: autoResizeTextarea,
    showToastNotification: (message, duration = 3000) => {
        const toast = document.getElementById('toastNotification');
        if (toast) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, duration);
        } else {
            console.warn("Toast notification element not found.");
            alert(message); // Fallback
        }
    },
    showSaveFeedback: (buttonElement, success, tempText, originalText) => {
        if (!buttonElement) return;
        buttonElement.textContent = tempText;
        buttonElement.disabled = true;
        if (!success) buttonElement.classList.add('error-feedback');

        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.disabled = false;
            if (!success) buttonElement.classList.remove('error-feedback');
        }, success ? 2000 : 3000);
    },
    openAvatarCropper: openAvatarCropper, // Make cropper available
    // Add other common UI helpers if needed
    scrollToBottom: scrollToBottom,
    showTopicContextMenu: showTopicContextMenu, // Make topic context menu generic
};


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // 确保在GroupRenderer初始化之前，其容器已准备好
    prepareGroupSettingsDOM();

    if (window.GroupRenderer) {
        const mainRendererElementsForGroupRenderer = {
            topicListUl: document.getElementById('topicList'),
            messageInput: messageInput,
            sendMessageBtn: sendMessageBtn,
            attachFileBtn: attachFileBtn,
            currentChatNameH3: currentChatNameH3,
            currentItemActionBtn: currentItemActionBtn,
            clearCurrentChatBtn: clearCurrentChatBtn,
            agentSettingsContainer: agentSettingsContainer,
            groupSettingsContainer: document.getElementById('groupSettingsContainer'),
            selectItemPromptForSettings: selectItemPromptForSettings, // 这个是我们关心的
            selectedItemNameForSettingsSpan: selectedItemNameForSettingsSpan, // 新增：传递这个引用
            itemListUl: itemListUl,
        };
        console.log('[Renderer PRE-INIT GroupRenderer] mainRendererElements to be passed:', mainRendererElementsForGroupRenderer);
        console.log('[Renderer PRE-INIT GroupRenderer] selectItemPromptForSettings within that object:', mainRendererElementsForGroupRenderer.selectItemPromptForSettings);

        window.GroupRenderer.init({
            electronAPI: window.electronAPI,
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
            currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
            messageRenderer: window.messageRenderer, // Will be initialized later, pass ref
            uiHelper: uiHelperFunctions,
            mainRendererElements: mainRendererElementsForGroupRenderer, // 使用构造好的对象
            mainRendererFunctions: { // Pass shared functions
                loadItems: loadItems,
                selectItem: selectItem,
                highlightActiveItem: highlightActiveItem,
                displaySettingsForItem: displaySettingsForItem,
                loadTopicList: loadTopicList,
                getAttachedFiles: () => attachedFiles,
                clearAttachedFiles: () => { attachedFiles.length = 0; },
                updateAttachmentPreview: updateAttachmentPreview,
                setCroppedFile: (type, file) => {
                    if (type === 'agent') croppedAgentAvatarFile = file;
                    else if (type === 'group') croppedGroupAvatarFile = file;
                    else if (type === 'user') croppedUserAvatarFile = file;
                },
                getCroppedFile: (type) => {
                    if (type === 'agent') return croppedAgentAvatarFile;
                    if (type === 'group') return croppedGroupAvatarFile;
                    if (type === 'user') return croppedUserAvatarFile;
                    return null;
                },
                setCurrentChatHistory: (history) => currentChatHistory = history,
                displayTopicTimestampBubble: displayTopicTimestampBubble,
                initializeTopicSortable: initializeTopicSortable,
                switchToTab: switchToTab,
                saveItemOrder: saveItemOrder,
            }
        });
        console.log('[Renderer POST-INIT GroupRenderer] window.GroupRenderer.init has been called.');
    } else {
        console.error('[RENDERER_INIT] GroupRenderer module not found!');
    }

    // Initialize other modules after GroupRenderer, in case they depend on its setup
    if (window.messageRenderer) {
        window.messageRenderer.initializeMessageRenderer({
            currentChatHistoryRef: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
            currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
            currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            chatMessagesDiv: chatMessagesDiv,
            electronAPI: window.electronAPI,
            markedInstance: markedInstance, // Assuming marked.js is loaded
            uiHelper: uiHelperFunctions,
            summarizeTopicFromMessages: summarizeTopicFromMessages,
            handleCreateBranch: handleCreateBranch
        });
    } else {
        console.error('[RENDERER_INIT] messageRenderer module not found!');
    }

    if (window.inputEnhancer) {
        window.inputEnhancer.initializeInputEnhancer({
            messageInput: messageInput,
            electronAPI: window.electronAPI,
            attachedFiles: { get: () => attachedFiles, set: (val) => attachedFiles = val }, // Corrected: pass as attachedFiles
            updateAttachmentPreview: updateAttachmentPreview,
            getCurrentAgentId: () => currentSelectedItem.id, // Corrected: pass a function that returns the ID
            getCurrentTopicId: () => currentTopicId,
            uiHelper: uiHelperFunctions,
        });
    } else {
        console.error('[RENDERER_INIT] inputEnhancer module not found!');
    }


    window.electronAPI.onVCPLogStatus((statusUpdate) => {
        if (window.notificationRenderer) {
            window.notificationRenderer.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv);
        }
    });
    window.electronAPI.onVCPLogMessage((logData, originalRawMessage) => {
        if (window.notificationRenderer) {
            const computedStyle = getComputedStyle(document.body);
            const themeColors = {
                notificationBg: computedStyle.getPropertyValue('--notification-bg').trim(),
                accentBg: computedStyle.getPropertyValue('--accent-bg').trim(),
                highlightText: computedStyle.getPropertyValue('--highlight-text').trim(),
                borderColor: computedStyle.getPropertyValue('--border-color').trim(),
                primaryText: computedStyle.getPropertyValue('--primary-text').trim(),
                secondaryText: computedStyle.getPropertyValue('--secondary-text').trim()
            };
            window.notificationRenderer.renderVCPLogNotification(logData, originalRawMessage, notificationsListUl, themeColors);
        }
    });

    // Listener for agent chat stream chunks
    window.electronAPI.onVCPStreamChunk(async (eventData) => {
        if (!window.messageRenderer) {
            console.error("VCPStreamChunk: messageRenderer not available.");
            return;
        }
        const streamMessageId = eventData.messageId;
        if (!streamMessageId) {
            console.error("VCPStreamChunk: Received chunk/event without a messageId. Cannot process.", eventData);
            // if (activeStreamingMessageId && window.messageRenderer) { // REMOVED activeStreamingMessageId check
            //     window.messageRenderer.finalizeStreamedMessage(activeStreamingMessageId, 'error_missing_id');
            //     const errorMsgItem = document.querySelector(`.message-item[data-message-id="${activeStreamingMessageId}"] .md-content`);
            //     if (errorMsgItem) errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: 响应中缺少messageId</strong></p>`;
            //     activeStreamingMessageId = null;
            // }
            return;
        }
        if (eventData.type === 'data') {
            window.messageRenderer.appendStreamChunk(streamMessageId, eventData.chunk);
        } else if (eventData.type === 'end') {
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, eventData.finish_reason || 'completed');
            if (currentSelectedItem.type === 'agent') { // Only summarize for agents
                await attemptTopicSummarizationIfNeeded();
            }
            // if (activeStreamingMessageId === streamMessageId) { // REMOVED
            //     activeStreamingMessageId = null;
            // }
        } else if (eventData.type === 'error') {
            console.error('VCP Stream Error on ID', streamMessageId, ':', eventData.error);
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, 'error');
            const errorMsgItem = document.querySelector(`.message-item[data-message-id="${streamMessageId}"] .md-content`);
            if (errorMsgItem) {
                errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: ${eventData.error}</strong></p>`;
            } else {
                 window.messageRenderer.renderMessage({
                    role: 'system',
                    content: `流处理错误 (ID: ${streamMessageId}): ${eventData.error}`,
                    timestamp: Date.now(),
                    id: `err_${streamMessageId}`
                });
            }
            // if (activeStreamingMessageId === streamMessageId) { // REMOVED
            //     activeStreamingMessageId = null;
            // }
        }
    });
    
    // Listener for group chat stream chunks
    window.electronAPI.onVCPGroupStreamChunk(async (eventData) => {
        if (!window.messageRenderer) {
            console.error("VCPGroupStreamChunk: messageRenderer not available.");
            return;
        }
        const streamMessageId = eventData.messageId;
        // agentName, agentId, groupId, topicId are now part of eventData directly from main.js
        const { agentName = '群成员', agentId, groupId, topicId, chunk, fullResponse, error, type } = eventData;

        if (!streamMessageId) {
            console.error("VCPGroupStreamChunk: Received chunk/event without a messageId.", eventData);
            return;
        }

        if (type === 'agent_thinking') {
            const { agentName, agentId, groupId, topicId, avatarUrl, avatarColor } = eventData;
            console.log(`[Renderer onVCPGroupStreamChunk AGENT_THINKING] Received for ${agentName} (msgId: ${streamMessageId})`);
            window.messageRenderer.renderMessage({
                id: streamMessageId,
                role: 'assistant',
                name: agentName,
                agentId: agentId,
                avatarUrl: avatarUrl,
                avatarColor: avatarColor,
                content: '思考中...',
                timestamp: Date.now(),
                isThinking: true,
                isGroupMessage: true,
                groupId: groupId,
                topicId: topicId
            });
        } else if (type === 'start') {
            // No need to call getAgentConfig anymore, avatarUrl is in the eventData
            const { agentName, agentId, groupId, topicId, avatarUrl, avatarColor } = eventData;
            console.log(`[Renderer onVCPGroupStreamChunk START] Received start event for ${agentName} with avatarUrl: ${avatarUrl}`);

            window.messageRenderer.startStreamingMessage({
                id: streamMessageId,
                role: 'assistant',
                name: agentName,
                agentId: agentId,
                avatarUrl: avatarUrl, // Use directly from eventData
                avatarColor: avatarColor, // Use directly from eventData
                content: '', // Start with empty content
                timestamp: Date.now(),
                isThinking: false, // Stream has started, not just thinking
                isGroupMessage: true,
                groupId: groupId,
                topicId: topicId
            });
        } else if (type === 'data') {
            window.messageRenderer.appendStreamChunk(streamMessageId, chunk, agentName, agentId);
        } else if (type === 'end') {
            // When the stream ends, finalize the message and save it to history
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, 'completed', fullResponse, agentName, agentId);
            // The history saving logic is now handled by groupchat.js in the main process.
            // The renderer's responsibility is to finalize the UI display.
        } else if (type === 'error') {
            console.error('VCP Group Stream Error on ID', streamMessageId, 'for agent', agentName, ':', error);
            window.messageRenderer.finalizeStreamedMessage(streamMessageId, 'error', `[错误] ${error}`, agentName, agentId);
        } else if (type === 'no_ai_response') {
            console.log(`[Group Chat Flow] No AI response needed for messageId: ${streamMessageId}. Message: ${eventData.message}`);
        }
    });

    // Listener for group topic title updates
    window.electronAPI.onVCPGroupTopicUpdated(async (eventData) => {
        const { groupId, topicId, newTitle, topics } = eventData;
        console.log(`[Renderer] Received topic update for group ${groupId}, topic ${topicId}: "${newTitle}"`);
        if (currentSelectedItem.id === groupId && currentSelectedItem.type === 'group') {
            // Update the currentSelectedItem's config if it's the active group
            if (currentSelectedItem.config && currentSelectedItem.config.topics) {
                const topicIndex = currentSelectedItem.config.topics.findIndex(t => t.id === topicId);
                if (topicIndex !== -1) {
                    currentSelectedItem.config.topics[topicIndex].name = newTitle;
                } else { // Topic might be new or ID changed, replace topics array
                    currentSelectedItem.config.topics = topics;
                }
            } else if (currentSelectedItem.config) {
                currentSelectedItem.config.topics = topics;
            }


            // If the topics tab is active, reload the list
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                await loadTopicList();
            }
            // Removed toast notification as per user feedback
            // if (uiHelperFunctions && uiHelperFunctions.showToastNotification) {
            //      uiHelperFunctions.showToastNotification(`群组 "${currentSelectedItem.name}" 的话题 "${newTitle}" 已自动总结并更新。`);
            // }
            console.log(`群组 "${currentSelectedItem.name}" 的话题 "${newTitle}" 已自动总结并更新 (通知已移除).`);
        }
    });


    try {
        await loadAndApplyGlobalSettings();
        await loadItems(); // Load both agents and groups

        setupEventListeners();
        setupSidebarTabs();
        initializeResizers();
        setupTitleBarControls();
        setupTopicSearch(); // Ensure this is called after DOM for topic search input is ready
        if(messageInput) autoResizeTextarea(messageInput);
        loadAndApplyThemePreference();
        initializeDigitalClock();

        // Set default view if no item is selected
        if (!currentSelectedItem.id) {
            displayNoItemSelected();
        }


    } catch (error) {
        console.error('Error during DOMContentLoaded initialization:', error);
        chatMessagesDiv.innerHTML = `<div class="message-item system">初始化失败: ${error.message}</div>`;
    }
    console.log('[Renderer DOMContentLoaded END] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
});

function displayNoItemSelected() {
    currentChatNameH3.textContent = '选择一个 Agent 或群组开始聊天';
    // Updated to a single line welcome message, ensuring no extra whitespace in the template literal
    chatMessagesDiv.innerHTML = `<div class="message-item system welcome-bubble"><p>欢迎！请从左侧选择AI助手/群组，或创建新的开始对话。</p></div>`;
    currentItemActionBtn.style.display = 'none';
    clearCurrentChatBtn.style.display = 'none';
    messageInput.disabled = true;
    sendMessageBtn.disabled = true;
    attachFileBtn.disabled = true;
    displaySettingsForItem(); // This will show "select item" prompt in settings tab
    loadTopicList(); // This will show "select item" in topics tab
}


function prepareGroupSettingsDOM() {
    // This function is called early in DOMContentLoaded.
    // It ensures the container for group settings exists.
    // The actual content (form fields) will be managed by GroupRenderer.
    if (!document.getElementById('groupSettingsContainer')) {
        const settingsTab = document.getElementById('tabContentSettings');
        if (settingsTab) {
            const groupContainerHTML = `<div id="groupSettingsContainer" style="display: none;"></div>`;
            settingsTab.insertAdjacentHTML('beforeend', groupContainerHTML);
            console.log("[Renderer] groupSettingsContainer placeholder created.");
        } else {
            console.error("[Renderer] Could not find tabContentSettings to append group settings DOM placeholder.");
        }
    }
     // Ensure createNewGroupBtn has its text updated
    if (createNewAgentBtn) {
        createNewAgentBtn.textContent = '创建 Agent';
        createNewAgentBtn.style.width = 'calc(50% - 5px)'; // Adjust width to make space
        createNewAgentBtn.style.marginRight = '5px';
    }
    if (createNewGroupBtn) {
        createNewGroupBtn.textContent = '创建 Group';
        console.log('[Renderer prepareGroupSettingsDOM] createNewGroupBtn textContent set to:', createNewGroupBtn.textContent);
        createNewGroupBtn.style.display = 'inline-block'; // Make it visible
        createNewGroupBtn.style.width = 'calc(50% - 5px)';
    }
}


function initializeDigitalClock() {
    if (digitalClockElement && notificationTitleElement && dateDisplayElement) {
        notificationTitleElement.style.display = 'none';
        updateDateTimeDisplay();
        setInterval(updateDateTimeDisplay, 1000);
    } else {
        console.error('Digital clock, notification title, or date display element not found.');
    }
}

function updateDateTimeDisplay() {
    const now = new Date();
    if (digitalClockElement) {
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        if (!digitalClockElement.querySelector('.colon')) {
            digitalClockElement.innerHTML = `<span class="hours">${hours}</span><span class="colon">:</span><span class="minutes">${minutes}</span>`;
        } else {
            const hoursSpan = digitalClockElement.querySelector('.hours');
            const minutesSpan = digitalClockElement.querySelector('.minutes');
            if (hoursSpan) hoursSpan.textContent = hours;
            if (minutesSpan) minutesSpan.textContent = minutes;
        }
    }
    if (dateDisplayElement) {
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
        dateDisplayElement.textContent = `${month}-${day} ${dayOfWeek}`;
    }
}

function loadAndApplyThemePreference() {
    const currentTheme = localStorage.getItem('theme');
    const sunIcon = document.getElementById('sun-icon');
    const moonIcon = document.getElementById('moon-icon');
    if (currentTheme === 'light') {
        document.body.classList.add('light-theme');
        if (sunIcon) sunIcon.style.display = 'none';
        if (moonIcon) moonIcon.style.display = 'inline-block';
    } else { // Default to dark
        document.body.classList.remove('light-theme');
        if (sunIcon) sunIcon.style.display = 'inline-block';
        if (moonIcon) moonIcon.style.display = 'none';
    }
}

async function loadAndApplyGlobalSettings() {
    const settings = await window.electronAPI.loadSettings();
    if (settings && !settings.error) {
        globalSettings = { ...globalSettings, ...settings }; // Merge with defaults
        document.getElementById('userName').value = globalSettings.userName || '用户';
        document.getElementById('vcpServerUrl').value = globalSettings.vcpServerUrl || '';
        document.getElementById('vcpApiKey').value = globalSettings.vcpApiKey || '';
        document.getElementById('vcpLogUrl').value = globalSettings.vcpLogUrl || '';
        document.getElementById('vcpLogKey').value = globalSettings.vcpLogKey || '';

        if (globalSettings.userAvatarUrl && userAvatarPreview) {
            userAvatarPreview.src = globalSettings.userAvatarUrl; // Already has timestamp from main
            userAvatarPreview.style.display = 'block';
        } else if (userAvatarPreview) {
            userAvatarPreview.src = '#';
            userAvatarPreview.style.display = 'none';
        }
        if (window.messageRenderer) { // Update messageRenderer with user avatar info
            window.messageRenderer.setUserAvatar(globalSettings.userAvatarUrl);
            window.messageRenderer.setUserAvatarColor(globalSettings.userAvatarCalculatedColor);
        }


        if (globalSettings.sidebarWidth && leftSidebar) {
            leftSidebar.style.width = `${globalSettings.sidebarWidth}px`;
        }
        if (globalSettings.notificationsSidebarWidth && rightNotificationsSidebar) {
            if (rightNotificationsSidebar.classList.contains('active')) {
                rightNotificationsSidebar.style.width = `${globalSettings.notificationsSidebarWidth}px`;
            }
        }

        if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'connecting', message: '连接中...' }, vcpLogConnectionStatusDiv);
            window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
        } else {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
        }
    } else {
        console.warn('加载全局设置失败或无设置:', settings?.error);
        if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
    }
}

// --- Item (Agent/Group) Management ---
async function loadItems() {
    console.log('[Renderer loadItems START] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
    itemListUl.innerHTML = '<li><div class="loading-spinner-small"></div>加载列表中...</li>';
    const agentsResult = await window.electronAPI.getAgents();
    const groupsResult = await window.electronAPI.getAgentGroups(); // Fetch groups
    itemListUl.innerHTML = '';

    let items = [];
    if (agentsResult && !agentsResult.error) {
        items.push(...agentsResult.map(a => ({ ...a, type: 'agent', id: a.id, avatarUrl: a.avatarUrl || 'assets/default_avatar.png' })));
    } else if (agentsResult && agentsResult.error) { // Check agentsResult exists before accessing error
        itemListUl.innerHTML += `<li>加载Agent失败: ${agentsResult.error}</li>`;
    }

    if (groupsResult && !groupsResult.error) {
        items.push(...groupsResult.map(g => ({ ...g, type: 'group', id: g.id, avatarUrl: g.avatarUrl || 'assets/default_group_avatar.png' }))); // Default group avatar
    } else if (groupsResult && groupsResult.error) { // Check groupsResult exists
        itemListUl.innerHTML += `<li>加载群组失败: ${groupsResult.error}</li>`;
    }
    
    let combinedOrderFromSettings = [];
    try {
        const settings = await window.electronAPI.loadSettings();
        if (settings && settings.combinedItemOrder && Array.isArray(settings.combinedItemOrder)) {
            combinedOrderFromSettings = settings.combinedItemOrder;
        }
    } catch (e) {
        console.warn("Could not load combinedItemOrder from settings:", e);
    }

    if (combinedOrderFromSettings.length > 0 && items.length > 0) {
        const itemMap = new Map(items.map(item => [`${item.type}_${item.id}`, item]));
        const orderedItems = [];
        combinedOrderFromSettings.forEach(orderedItemInfo => {
            const key = `${orderedItemInfo.type}_${orderedItemInfo.id}`;
            if (itemMap.has(key)) {
                orderedItems.push(itemMap.get(key));
                itemMap.delete(key);
            }
        });
        orderedItems.push(...itemMap.values()); // Add any new items not in the saved order
        items = orderedItems;
    } else {
        // Default sort if no order saved or no items
        items.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'group' ? -1 : 1; // Groups first
            }
            return (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
        });
    }


    if (items.length === 0 && !(agentsResult && agentsResult.error) && !(groupsResult && groupsResult.error)) {
        itemListUl.innerHTML = '<li>没有找到Agent或群组。请创建一个。</li>';
    } else {
        items.forEach(item => {
            const li = document.createElement('li');
            li.dataset.itemId = item.id;
            li.dataset.itemType = item.type;

            const avatarImg = document.createElement('img');
            avatarImg.classList.add('avatar');
            avatarImg.src = item.avatarUrl ? `${item.avatarUrl}${item.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
            avatarImg.alt = `${item.name} 头像`;
            avatarImg.onerror = () => { avatarImg.src = (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

            const nameSpan = document.createElement('span');
            nameSpan.classList.add('agent-name'); // Keep class for consistent styling
            nameSpan.textContent = item.name;
            if (item.type === 'group') {
                nameSpan.textContent += " (群)";
            }

            li.appendChild(avatarImg);
            li.appendChild(nameSpan);
            li.addEventListener('click', () => selectItem(item.id, item.type, item.name, item.avatarUrl, item.config || item)); // Pass full item as config for groups
            itemListUl.appendChild(li);
        });

        if (currentSelectedItem.id) {
            highlightActiveItem(currentSelectedItem.id, currentSelectedItem.type);
        }

        if (typeof Sortable !== 'undefined' && itemListUl) {
            initializeItemSortable();
        } else {
            console.warn('SortableJS library not found or itemListUl not ready. Item list drag-and-drop ordering will not be available.');
        }
    }
    console.log('[Renderer loadItems END] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
}

function initializeItemSortable() {
    if (!itemListUl) {
        console.warn("[initializeItemSortable] itemListUl (agentList) element not found. Skipping Sortable initialization.");
        return;
    }
    if (itemListUl.sortableInstance) {
        itemListUl.sortableInstance.destroy();
    }
    itemListUl.sortableInstance = new Sortable(itemListUl, {
        animation: 150,
        ghostClass: 'sortable-ghost-main', // Distinct ghost class for main list
        chosenClass: 'sortable-chosen-main',
        dragClass: 'sortable-drag-main',
        onEnd: async function (evt) {
            const allListItems = Array.from(evt.to.children);
            const orderedItems = allListItems.map(item => ({
                id: item.dataset.itemId,
                type: item.dataset.itemType // Crucial for combined list
            }));
            await saveItemOrder(orderedItems);
        }
    });
}

async function saveItemOrder(orderedItemsWithTypes) {
    console.log('[Renderer] Saving combined item order:', orderedItemsWithTypes);
    try {
        const result = await window.electronAPI.saveCombinedItemOrder(orderedItemsWithTypes);
        if (result && result.success) {
            // uiHelperFunctions.showToastNotification("项目顺序已保存。"); // Removed successful save notification
        } else {
            uiHelperFunctions.showToastNotification(`保存项目顺序失败: ${result?.error || '未知错误'}`, 'error');
            // Consider reloading items to revert to the last saved order if save failed
            // await loadItems();
        }
    } catch (error) {
        console.error('Error saving combined item order:', error);
        uiHelperFunctions.showToastNotification(`保存项目顺序出错: ${error.message}`, 'error');
    }
}


async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) {
    console.log('[Renderer selectItem START] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
    if (currentSelectedItem.id === itemId && currentSelectedItem.type === itemType && currentTopicId) {
        console.log(`Item ${itemType} ${itemId} already selected with topic ${currentTopicId}. No change.`);
        return;
    }

    currentSelectedItem = { id: itemId, type: itemType, name: itemName, avatarUrl: itemAvatarUrl, config: itemFullConfig };
    currentTopicId = null; // Reset topic when selecting a new item
    currentChatHistory = [];

    document.querySelectorAll('.topic-list .topic-item.active-topic-glowing').forEach(item => {
        item.classList.remove('active-topic-glowing');
    });

    if (window.messageRenderer) {
        window.messageRenderer.setCurrentSelectedItem(currentSelectedItem);
        window.messageRenderer.setCurrentTopicId(null);
        messageRenderer.setCurrentItemAvatar(itemAvatarUrl); // Use item's avatar (generic)
        messageRenderer.setCurrentItemAvatarColor(itemFullConfig?.avatarCalculatedColor || null);
    }
    
    currentChatNameH3.textContent = `与 ${itemName} ${itemType === 'group' ? '(群组)' : ''} 聊天中`;
    currentItemActionBtn.textContent = itemType === 'group' ? '新建群聊话题' : '新建聊天话题';
    currentItemActionBtn.title = `为 ${itemName} 新建${itemType === 'group' ? '群聊话题' : '聊天话题'}`;
    currentItemActionBtn.style.display = 'inline-block';
    clearCurrentChatBtn.style.display = 'inline-block';

    highlightActiveItem(itemId, itemType);
    displaySettingsForItem(); // Show correct settings panel (agent or group)

    try {
        let topics;
        if (itemType === 'agent') {
            topics = await window.electronAPI.getAgentTopics(itemId);
        } else if (itemType === 'group') {
            topics = await window.electronAPI.getGroupTopics(itemId); // API for group topics
        }

        if (topics && !topics.error && topics.length > 0) {
            let topicToLoadId = topics[0].id; // Default to first topic
            const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${itemId}_${itemType}`);
            if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                topicToLoadId = rememberedTopicId;
            }
            currentTopicId = topicToLoadId;
            if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
            await loadChatHistory(itemId, itemType, currentTopicId);
        } else if (topics && topics.error) {
            console.error(`加载 ${itemType} ${itemId} 的话题列表失败:`, topics.error);
            if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
            await loadChatHistory(itemId, itemType, null); // Show "no topic" state
        } else { // No topics exist
            if (itemType === 'agent') {
                 // For agents, create a default topic if none exist
                const agentConfig = await window.electronAPI.getAgentConfig(itemId);
                if (agentConfig && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                    const defaultTopicResult = await window.electronAPI.createNewTopicForAgent(itemId, "主要对话");
                    if (defaultTopicResult.success) {
                        currentTopicId = defaultTopicResult.topicId;
                        if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
                        await loadChatHistory(itemId, itemType, currentTopicId);
                    } else {
                        if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                        await loadChatHistory(itemId, itemType, null);
                    }
                } else {
                     await loadChatHistory(itemId, itemType, null); // No topics, show "no topic" state
                }
            } else if (itemType === 'group') { // For groups, also create a default topic
                const defaultTopicResult = await window.electronAPI.createNewTopicForGroup(itemId, "主要群聊");
                if (defaultTopicResult.success) {
                    currentTopicId = defaultTopicResult.topicId;
                    if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
                    await loadChatHistory(itemId, itemType, currentTopicId);
                } else {
                    if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `创建默认群聊话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                    await loadChatHistory(itemId, itemType, null);
                }
            }
        }
    } catch (e) {
        console.error(`选择 ${itemType} ${itemId} 时发生错误: `, e);
        if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `选择${itemType === 'group' ? '群组' : '助手'}时出错: ${e.message}`, timestamp: Date.now() });
    }

    messageInput.disabled = false;
    sendMessageBtn.disabled = false;
    attachFileBtn.disabled = false;
    messageInput.focus();
    loadTopicList(); // Refresh topic list for the selected item
    console.log('[Renderer selectItem END] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
}


function highlightActiveItem(itemId, itemType) {
    document.querySelectorAll('#agentList li').forEach(item => { // Ensure selector targets the correct list
        item.classList.toggle('active', item.dataset.itemId === itemId && item.dataset.itemType === itemType);
    });
    if (!currentTopicId && window.messageRenderer) { // If no topic is active, clear topic highlights
        document.querySelectorAll('.topic-list .topic-item.active-topic-glowing').forEach(item => {
            item.classList.remove('active-topic-glowing');
            item.classList.remove('active');
        });
    }
}

// --- Chat Functionality ---
async function loadChatHistory(itemId, itemType, topicId) {
    if (window.messageRenderer) window.messageRenderer.clearChat();
    currentChatHistory = [];

    document.querySelectorAll('.topic-list .topic-item').forEach(item => {
        const isCurrent = item.dataset.topicId === topicId && item.dataset.itemId === itemId && item.dataset.itemType === itemType;
        item.classList.toggle('active', isCurrent);
        item.classList.toggle('active-topic-glowing', isCurrent);
    });

    if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(topicId);

    if (!itemId) { // topicId can be null if no topics exist yet for an item
        const errorMsg = `错误：无法加载聊天记录，${itemType === 'group' ? '群组' : '助手'}ID (${itemId}) 缺失。`;
        console.error(errorMsg);
        if (window.messageRenderer) {
            window.messageRenderer.renderMessage({ role: 'system', content: errorMsg, timestamp: Date.now() });
        }
        await displayTopicTimestampBubble(null, null, null); // Clear timestamp bubble
        return;
    }
    
    if (!topicId) { // Item selected, but no topic (e.g., new item or all topics deleted)
        if (window.messageRenderer) {
            window.messageRenderer.renderMessage({ role: 'system', content: '请选择或创建一个话题以开始聊天。', timestamp: Date.now() });
        }
        await displayTopicTimestampBubble(itemId, itemType, null);
        return;
    }


    if (window.messageRenderer) {
        window.messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });
    }


    let historyResult;
    if (itemType === 'agent') {
        historyResult = await window.electronAPI.getChatHistory(itemId, topicId);
    } else if (itemType === 'group') {
        historyResult = await window.electronAPI.getGroupChatHistory(itemId, topicId);
    }
    
    if (window.messageRenderer) window.messageRenderer.removeMessageById('loading_history');

    await displayTopicTimestampBubble(itemId, itemType, topicId);

    if (historyResult && historyResult.error) { // Check historyResult exists
        if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录失败: ${historyResult.error}`, timestamp: Date.now() });
    } else if (historyResult) { // Ensure historyResult is not undefined
        currentChatHistory = historyResult;
        if (window.messageRenderer) {
            currentChatHistory.forEach(msg => window.messageRenderer.renderMessage(msg, true));
        }
    } else {
         if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录时返回了无效数据。`, timestamp: Date.now() });
    }
    scrollToBottom();
    if (itemId && topicId && !(historyResult && historyResult.error)) { // Check historyResult for error
        localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, topicId);
    }
}

function scrollToBottom() {
    if (chatMessagesDiv) { // Check if element exists
        chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    }
    const parentContainer = document.querySelector('.chat-messages-container');
    if (parentContainer) {
        parentContainer.scrollTop = parentContainer.scrollHeight;
    }
}

async function displayTopicTimestampBubble(itemId, itemType, topicId) {
    const chatMessagesContainer = document.querySelector('.chat-messages-container');
    const chatMessagesDivElement = document.getElementById('chatMessages');

    if (!chatMessagesDivElement || !chatMessagesContainer) {
        console.warn('[displayTopicTimestampBubble] Missing chatMessagesDivElement or chatMessagesContainer.');
        const existingBubble = document.getElementById('topicTimestampBubble');
        if (existingBubble) existingBubble.style.display = 'none';
        return;
    }

    let timestampBubble = document.getElementById('topicTimestampBubble');
    if (!timestampBubble) {
        timestampBubble = document.createElement('div');
        timestampBubble.id = 'topicTimestampBubble';
        timestampBubble.className = 'topic-timestamp-bubble';
        if (chatMessagesDivElement.firstChild) {
            chatMessagesDivElement.insertBefore(timestampBubble, chatMessagesDivElement.firstChild);
        } else {
            chatMessagesDivElement.appendChild(timestampBubble);
        }
    } else {
        // Ensure it's the first child if it exists
        if (chatMessagesDivElement.firstChild !== timestampBubble) {
            chatMessagesDivElement.insertBefore(timestampBubble, chatMessagesDivElement.firstChild);
        }
    }

    if (!itemId || !topicId) {
        timestampBubble.style.display = 'none';
        return;
    }

    try {
        let itemConfigFull;
        if (itemType === 'agent') {
            itemConfigFull = await window.electronAPI.getAgentConfig(itemId);
        } else if (itemType === 'group') {
            itemConfigFull = await window.electronAPI.getAgentGroupConfig(itemId);
        }

        if (itemConfigFull && !itemConfigFull.error && itemConfigFull.topics) {
            const currentTopicObj = itemConfigFull.topics.find(t => t.id === topicId);
            if (currentTopicObj && currentTopicObj.createdAt) {
                const date = new Date(currentTopicObj.createdAt);
                const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                timestampBubble.textContent = `话题创建于: ${formattedDate}`;
                timestampBubble.style.display = 'block';
            } else {
                console.warn(`[displayTopicTimestampBubble] Topic ${topicId} not found or has no createdAt for ${itemType} ${itemId}.`);
                timestampBubble.style.display = 'none';
            }
        } else {
            console.error('[displayTopicTimestampBubble] Could not load config or topics for', itemType, itemId, 'Error:', itemConfigFull?.error);
            timestampBubble.style.display = 'none';
        }
    } catch (error) {
        console.error('[displayTopicTimestampBubble] Error fetching topic creation time for', itemType, itemId, 'topic', topicId, ':', error);
        timestampBubble.style.display = 'none';
    }
}


async function attemptTopicSummarizationIfNeeded() {
    if (currentSelectedItem.type !== 'agent' || currentChatHistory.length < 4 || !currentTopicId) return;

    try {
        const agentConfigForSummary = currentSelectedItem.config; // Use the already loaded config
        if (!agentConfigForSummary || agentConfigForSummary.error) {
            console.error('[TopicSummary] Failed to get agent config for summarization:', agentConfigForSummary?.error);
            return;
        }
        const topics = agentConfigForSummary.topics || [];
        const currentTopicObject = topics.find(t => t.id === currentTopicId);
        const existingTopicTitle = currentTopicObject ? currentTopicObject.name : "主要对话";
        const currentAgentName = agentConfigForSummary.name || 'AI';

        if (existingTopicTitle === "主要对话" || existingTopicTitle.startsWith("新话题")) {
            if (typeof summarizeTopicFromMessages === 'function' && window.messageRenderer) { // Check messageRenderer for summarizeTopicFromMessages
                const summarizedTitle = await window.messageRenderer.summarizeTopicFromMessages(currentChatHistory.filter(m => !m.isThinking), currentAgentName);
                if (summarizedTitle) {
                    const saveResult = await window.electronAPI.saveAgentTopicTitle(currentSelectedItem.id, currentTopicId, summarizedTitle);
                    if (saveResult.success) {
                        if (document.getElementById('tabContentTopics').classList.contains('active')) {
                            loadTopicList(); // Refresh topic list in UI
                        }
                    } else {
                        console.error(`[TopicSummary] Failed to save new topic title "${summarizedTitle}":`, saveResult.error);
                    }
                }
            } else {
                console.error('[TopicSummary] summarizeTopicFromMessages function is not defined or not accessible via messageRenderer.');
            }
        }
    } catch (error) {
        console.error('[TopicSummary] Error during attemptTopicSummarizationIfNeeded:', error);
    }
}

async function handleSendMessage() {
    const content = messageInput.value.trim();
    if (!content && attachedFiles.length === 0) return;
    if (!currentSelectedItem.id || !currentTopicId) {
        uiHelperFunctions.showToastNotification('请先选择一个项目和话题！', 'error');
        return;
    }
    if (!globalSettings.vcpServerUrl) {
        uiHelperFunctions.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
        openModal('globalSettingsModal');
        return;
    }

    if (currentSelectedItem.type === 'group') {
        if (window.GroupRenderer && typeof window.GroupRenderer.handleSendGroupMessage === 'function') {
            // Pass necessary parameters to handleSendGroupMessage
            window.GroupRenderer.handleSendGroupMessage(
                currentSelectedItem.id,
                currentTopicId,
                { text: content, attachments: attachedFiles.map(af => ({ type: af.file.type, src: af.localPath, name: af.originalName, size: af.file.size })) },
                globalSettings.userName || '用户'
            );
        } else {
            uiHelperFunctions.showToastNotification("群聊功能模块未加载，无法发送消息。", 'error');
        }
        // Clear input and attachments after handing off to GroupRenderer
        messageInput.value = '';
        attachedFiles.length = 0;
        updateAttachmentPreview();
        autoResizeTextarea(messageInput);
        messageInput.focus();
        return;
    }

    // --- Standard Agent Message Sending ---
    let contentForVCP = content; // Start with user's typed text

    const uiAttachments = []; // For UI rendering
    if (attachedFiles.length > 0) {
        for (const af of attachedFiles) {
            uiAttachments.push({
                type: af.file.type,
                src: af.localPath,
                name: af.originalName,
                size: af.file.size,
            });
            // Append extracted text to contentForVCP
            if (af._fileManagerData && af._fileManagerData.extractedText) {
                contentForVCP += `\n\n[附加文件: ${af.originalName}]\n${af._fileManagerData.extractedText}\n[/附加文件结束: ${af.originalName}]`;
            } else if (af._fileManagerData && af._fileManagerData.type && !af._fileManagerData.type.startsWith('image/')) {
                contentForVCP += `\n\n[附加文件: ${af.originalName} (无法预览文本内容)]`;
            }
        }
    }

    const userMessage = {
        role: 'user',
        name: globalSettings.userName || '用户',
        content: content, // Original content for UI display and history if not modified below
        timestamp: Date.now(),
        id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
        attachments: uiAttachments // Attachments for UI rendering
    };
    
    // Optionally, if you want the history to also store the combined content:
    // userMessage.content = contentForVCP; // This would make the history show the appended text.

    if (window.messageRenderer) {
        window.messageRenderer.renderMessage(userMessage); // Renders the message with original text + UI attachments
    }

    messageInput.value = '';
    attachedFiles.length = 0; // Clear attached files
    updateAttachmentPreview(); // Update UI
    autoResizeTextarea(messageInput);
    messageInput.focus();

    const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
    const thinkingMessage = {
        role: 'assistant',
        name: currentSelectedItem.name || 'AI', // Agent's name
        content: '思考中...',
        timestamp: Date.now(),
        id: thinkingMessageId,
        isThinking: true,
        avatarUrl: currentSelectedItem.avatarUrl, // Agent's avatar
        avatarColor: currentSelectedItem.config?.avatarCalculatedColor
    };

    if (window.messageRenderer) {
        window.messageRenderer.renderMessage(thinkingMessage);
    }

    try {
        const agentConfig = currentSelectedItem.config; // Already have this from selectItem
        // Filter out the thinking message itself and any other transient messages if necessary
        const historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);

        const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
            let vcpImageAttachmentsPayload = []; // For VCP's multi-modal image content array
            let currentMessageTextContent = msg.content; // Start with the base text content from history

            if (msg.role === 'user' && msg.id === userMessage.id) {
                // This is the current user message being sent
                currentMessageTextContent = contentForVCP; // contentForVCP already has new attachments' text
            } else if (msg.attachments && msg.attachments.length > 0) {
                // This is a historical message, append its attachments' text.
                // We assume msg.content from history is the original user input without appended texts.
                let historicalAppendedText = "";
                for (const att of msg.attachments) {
                    // Ensure _fileManagerData exists and has extractedText
                    if (att._fileManagerData && typeof att._fileManagerData.extractedText === 'string' && att._fileManagerData.extractedText.trim() !== '') {
                        historicalAppendedText += `\n\n[附加文件: ${att.name || '未知文件'}]\n${att._fileManagerData.extractedText}\n[/附加文件结束: ${att.name || '未知文件'}]`;
                    } else if (att._fileManagerData && att.type && !att.type.startsWith('image/')) {
                        // If it's not an image and no text was extracted, note it.
                        historicalAppendedText += `\n\n[附加文件: ${att.name || '未知文件'} (无法预览文本内容)]`;
                    }
                }
                currentMessageTextContent += historicalAppendedText; // Append to the original historical content
            }
            // Note: Image attachments are handled separately below for VCP's image_url format.
            // The text content (currentMessageTextContent) will now include appended texts from non-image files.

            if (msg.attachments && msg.attachments.length > 0) {
                const imageAttachments = await Promise.all(msg.attachments
                    .filter(att => att.type.startsWith('image/')) // Only process images for VCP's image_url part
                    .map(async att => {
                        try {
                            const base64Data = await window.electronAPI.getFileAsBase64(att.src); // att.src 对应 af.localPath
                            if (base64Data && typeof base64Data === 'string') { // 成功获取到 base64 字符串
                                console.log(`[Renderer - handleSendMessage] Image ${att.name} - Base64 length: ${base64Data.length}`);
                                return {
                                    type: 'image_url', // Gemini-style
                                    image_url: {
                                        url: `data:${att.type};base64,${base64Data}`
                                    }
                                };
                            } else if (base64Data && base64Data.error) { // IPC 调用返回了错误对象
                                console.error(`[Renderer - handleSendMessage] Failed to get Base64 for ${att.name}: ${base64Data.error}`);
                                uiHelperFunctions.showToastNotification(`处理图片 ${att.name} 失败: ${base64Data.error}`, 'error');
                                return null; // 不将此图片添加到 vcpImageAttachmentsPayload
                            } else {
                                // 返回的不是字符串也不是错误对象，这不应该发生
                                console.error(`[Renderer - handleSendMessage] Unexpected return from getFileAsBase64 for ${att.name}:`, base64Data);
                                return null;
                            }
                        } catch (processingError) {
                            console.error(`[Renderer - handleSendMessage] Exception during getBase64 for ${att.name} (internal: ${att.src}):`, processingError);
                            uiHelperFunctions.showToastNotification(`处理图片 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                            return null;
                        }
                    })
                );
                vcpImageAttachmentsPayload.push(...imageAttachments.filter(Boolean));
            }

            let finalContentPartsForVCP = [];
            // Add the text part (which now includes appended file texts for the current user message)
            if (currentMessageTextContent && currentMessageTextContent.trim() !== '') {
                finalContentPartsForVCP.push({ type: 'text', text: currentMessageTextContent });
            }
            // Add image parts
            finalContentPartsForVCP.push(...vcpImageAttachmentsPayload);

            // Ensure user messages always have at least a text part if all else fails
            if (finalContentPartsForVCP.length === 0 && msg.role === 'user') {
                 finalContentPartsForVCP.push({ type: 'text', text: '(用户发送了附件，但无文本或图片内容)' });
            }
            
            // If finalContentPartsForVCP is still empty (e.g. system message with no content), use original msg.content as fallback
            return { role: msg.role, content: finalContentPartsForVCP.length > 0 ? finalContentPartsForVCP : msg.content };
        }));

        if (agentConfig && agentConfig.systemPrompt) { // Check agentConfig exists
            const systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentSelectedItem.id);
            messagesForVCP.unshift({ role: 'system', content: systemPromptContent });
        }

        const useStreaming = (agentConfig && agentConfig.streamOutput !== undefined) ? (agentConfig.streamOutput === true || agentConfig.streamOutput === 'true') : true; // Default to true
        const modelConfigForVCP = {
            model: (agentConfig && agentConfig.model) ? agentConfig.model : 'gemini-pro', // Default model
            temperature: (agentConfig && agentConfig.temperature !== undefined) ? parseFloat(agentConfig.temperature) : 0.7,
            ...(agentConfig && agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
            stream: useStreaming
        };

        if (useStreaming) {
            // activeStreamingMessageId = thinkingMessage.id; // Set active stream ID - REMOVED
            if (window.messageRenderer) { // Update the existing "thinking" message to be the stream target
                // 添加延迟以确保 "思考中" 动画有时间显示
                await new Promise(resolve => setTimeout(resolve, 500));
                window.messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" });
            }
        }

        const vcpResponse = await window.electronAPI.sendToVCP(
            globalSettings.vcpServerUrl,
            globalSettings.vcpApiKey,
            messagesForVCP,
            modelConfigForVCP,
            thinkingMessage.id // Pass the ID of the "thinking" message for stream association
        );

        if (!useStreaming) { // Handle non-streaming response
            if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id); // Remove "thinking" message

            if (vcpResponse.error) {
                if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${vcpResponse.error}`, timestamp: Date.now() });
            } else if (vcpResponse.choices && vcpResponse.choices.length > 0) {
                const assistantMessageContent = vcpResponse.choices[0].message.content;
                if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'assistant', name: currentSelectedItem.name, avatarUrl: currentSelectedItem.avatarUrl, avatarColor: currentSelectedItem.config?.avatarCalculatedColor, content: assistantMessageContent, timestamp: Date.now() });
            } else {
                if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: 'VCP返回了未知格式的响应。', timestamp: Date.now() });
            }
            await window.electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
            await attemptTopicSummarizationIfNeeded();
        } else { // Streaming started (or failed to start)
            if (vcpResponse && vcpResponse.streamError) {
                console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                // Error already handled by onVCPStreamChunk if it sends an error event
            } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                // This case means main process did not initiate streaming as expected
                console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                // activeStreamingMessageId = null; // Clear active stream ID - REMOVED
                if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id);
                if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                await window.electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
                await attemptTopicSummarizationIfNeeded();
            }
            // Successful streaming start is implicit; chunks will arrive via onVCPStreamChunk
        }
    } catch (error) {
        console.error('发送消息或处理VCP响应时出错:', error);
        // activeStreamingMessageId = null; // Clear active stream ID on error - REMOVED
        if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id); // Remove "thinking" message
        if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
        if(currentSelectedItem.id && currentTopicId) { // Save history even on error if possible
            await window.electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
        }
    }
}

function setupSidebarTabs() {
    sidebarTabButtons.forEach(button => {
        button.addEventListener('click', () => {
            switchToTab(button.dataset.tab);
        });
    });
    // Default to 'agents' tab (or your preferred default)
    switchToTab('agents');
}

function switchToTab(targetTab) {
    sidebarTabButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === targetTab);
    });
    sidebarTabContents.forEach(content => {
        const isActive = content.id === `tabContent${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`;
        content.classList.toggle('active', isActive);
        if (isActive) {
            if (targetTab === 'topics') {
                loadTopicList(); // This might create/re-render the topic list and search input
                setupTopicSearch(); // Explicitly set up search listeners after the tab is active and list loaded
            } else if (targetTab === 'settings') {
                displaySettingsForItem();
            } else if (targetTab === 'agents') { // Assuming 'agents' is the ID for the items list tab content
                // The items list (agents & groups) is always visible in a way,
                // but this ensures other tab contents are hidden.
                // loadItems() is usually called on init or after create/delete.
            }
        }
    });
}


async function loadTopicList() {
    const topicListContainer = document.getElementById('tabContentTopics'); // The main container for topics tab
    if (!topicListContainer) {
        console.error("Topic list container (tabContentTopics) not found.");
        return;
    }

    // Clear previous content, but preserve header and search if they exist
    let topicListUl = topicListContainer.querySelector('.topic-list');
    if (topicListUl) {
        topicListUl.innerHTML = ''; // Clear existing items
    } else { // Create UL if it doesn't exist
        const topicsHeader = topicListContainer.querySelector('.topics-header') || document.createElement('div');
        if (!topicsHeader.classList.contains('topics-header')) {
            topicsHeader.className = 'topics-header';
            topicsHeader.innerHTML = `<h2>话题列表</h2><div class="topic-search-container"><input type="text" id="topicSearchInput" placeholder="搜索话题..." class="topic-search-input"></div>`;
            topicListContainer.prepend(topicsHeader); // Add header to the top
            const newTopicSearchInput = topicsHeader.querySelector('#topicSearchInput');
            if (newTopicSearchInput) setupTopicSearchListener(newTopicSearchInput);
        }
        
        topicListUl = document.createElement('ul');
        topicListUl.className = 'topic-list';
        topicListUl.id = 'topicList'; // Ensure it has the ID for other functions
        topicListContainer.appendChild(topicListUl);
    }


    let topicsToProcess = [];
    if (!currentSelectedItem.id) {
        topicListUl.innerHTML = '<li><p>请先在“助手与群组”列表选择一个项目以查看其相关话题。</p></li>';
        return;
    }

    const itemNameForLoading = currentSelectedItem.name || '当前项目';
    const searchInput = document.getElementById('topicSearchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

    let itemConfigFull;

    // Always fetch fresh config when loading topic list to ensure UI is up-to-date
    if (!searchTerm) { // Only show loading spinner if not actively searching
        topicListUl.innerHTML = `<li><div class="loading-spinner-small"></div>正在加载 ${itemNameForLoading} 的话题...</li>`;
    } else {
        topicListUl.innerHTML = ''; // Clear immediately for filtering
    }
    
    if (currentSelectedItem.type === 'agent') {
        itemConfigFull = await window.electronAPI.getAgentConfig(currentSelectedItem.id);
    } else if (currentSelectedItem.type === 'group') {
        itemConfigFull = await window.electronAPI.getAgentGroupConfig(currentSelectedItem.id);
    }
    // Store the fetched config back to currentSelectedItem if successfully fetched
    if (itemConfigFull && !itemConfigFull.error) {
        currentSelectedItem.config = itemConfigFull;
    }
    // No 'else' block needed here, as we always fetch fresh config.
    
    if (!itemConfigFull || itemConfigFull.error) {
        topicListUl.innerHTML = `<li><p>无法加载 ${itemNameForLoading} 的配置信息: ${itemConfigFull?.error || '未知错误'}</p></li>`;
    } else {
        topicsToProcess = itemConfigFull.topics || [];
        // Ensure default topic for agent if none exist (groups handle this in getGroupTopics if needed)
        if (currentSelectedItem.type === 'agent' && topicsToProcess.length === 0) {
             const defaultAgentTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
             topicsToProcess.push(defaultAgentTopic);
             // Optionally save this back to agent's config if it was truly missing
             // await window.electronAPI.saveAgentConfig(currentSelectedItem.id, { ...itemConfigFull, topics: topicsToProcess });
        }


        // Sort topics by creation date, newest first
        topicsToProcess.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        
        // Filter topics if search term exists
        const searchInput = document.getElementById('topicSearchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        if (searchTerm) {
            // 1. Frontend filter (name and date)
            let frontendFilteredTopics = topicsToProcess.filter(topic => {
                const nameMatch = topic.name.toLowerCase().includes(searchTerm);
                let dateMatch = false;
                if (topic.createdAt) {
                    const date = new Date(topic.createdAt);
                    const fullDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    const shortDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                    dateMatch = fullDateStr.toLowerCase().includes(searchTerm) || shortDateStr.toLowerCase().includes(searchTerm);
                }
                return nameMatch || dateMatch;
            });

            // 2. Backend content search
            let contentMatchedTopicIds = [];
            try {
                const contentSearchResult = await window.electronAPI.searchTopicsByContent(currentSelectedItem.id, currentSelectedItem.type, searchTerm);
                if (contentSearchResult && contentSearchResult.success && Array.isArray(contentSearchResult.matchedTopicIds)) {
                    contentMatchedTopicIds = contentSearchResult.matchedTopicIds;
                } else if (contentSearchResult && !contentSearchResult.success) {
                    console.warn("Topic content search failed:", contentSearchResult.error);
                }
            } catch (e) {
                console.error("Error calling searchTopicsByContent:", e);
            }

            // 3. Combine results: a topic is included if it matches frontend criteria OR its ID is in contentMatchedTopicIds
            const finalFilteredTopicIds = new Set(frontendFilteredTopics.map(t => t.id));
            contentMatchedTopicIds.forEach(id => finalFilteredTopicIds.add(id));
            
            topicsToProcess = topicsToProcess.filter(topic => finalFilteredTopicIds.has(topic.id));

        }


        if (topicsToProcess.length === 0) {
            topicListUl.innerHTML = `<li><p>${itemNameForLoading} 还没有任何话题${searchTerm ? '匹配当前搜索' : ''}。您可以点击上方的“新建${currentSelectedItem.type === 'group' ? '群聊话题' : '聊天话题'}”按钮创建一个。</p></li>`;
        } else {
            topicListUl.innerHTML = ''; // Clear loading message
            for (const topic of topicsToProcess) {
                const li = document.createElement('li');
                li.classList.add('topic-item');
                li.dataset.itemId = currentSelectedItem.id;
                li.dataset.itemType = currentSelectedItem.type;
                li.dataset.topicId = topic.id;
                const isCurrentActiveTopic = topic.id === currentTopicId;
                li.classList.toggle('active', isCurrentActiveTopic);
                li.classList.toggle('active-topic-glowing', isCurrentActiveTopic);

                const avatarImg = document.createElement('img');
                avatarImg.classList.add('avatar');
                // Use currentSelectedItem's avatar for topic list items
                avatarImg.src = currentSelectedItem.avatarUrl ? `${currentSelectedItem.avatarUrl}${currentSelectedItem.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
                avatarImg.alt = `${currentSelectedItem.name} - ${topic.name}`;
                avatarImg.onerror = () => { avatarImg.src = (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

                const topicTitleDisplay = document.createElement('span');
                topicTitleDisplay.classList.add('topic-title-display');
                topicTitleDisplay.textContent = topic.name || `话题 ${topic.id}`;

                const messageCountSpan = document.createElement('span');
                messageCountSpan.classList.add('message-count');
                messageCountSpan.textContent = '...'; // Placeholder for count

                li.appendChild(avatarImg);
                li.appendChild(topicTitleDisplay);
                li.appendChild(messageCountSpan);

                // Asynchronously fetch and display message count
                let historyPromise;
                if (currentSelectedItem.type === 'agent') {
                    historyPromise = window.electronAPI.getChatHistory(currentSelectedItem.id, topic.id);
                } else if (currentSelectedItem.type === 'group') {
                    historyPromise = window.electronAPI.getGroupChatHistory(currentSelectedItem.id, topic.id);
                }
                if (historyPromise) {
                    historyPromise.then(historyResult => {
                        if (historyResult && !historyResult.error && Array.isArray(historyResult)) {
                            messageCountSpan.textContent = `${historyResult.length}`;
                        } else {
                            messageCountSpan.textContent = 'N/A';
                        }
                    }).catch(() => messageCountSpan.textContent = 'ERR');
                }


                li.addEventListener('click', async () => {
                    if (currentTopicId !== topic.id) {
                        currentTopicId = topic.id;
                        if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
                        document.querySelectorAll('#topicList .topic-item').forEach(item => {
                            const isClickedItem = item.dataset.topicId === currentTopicId && item.dataset.itemId === currentSelectedItem.id;
                            item.classList.toggle('active', isClickedItem);
                            item.classList.toggle('active-topic-glowing', isClickedItem);
                        });
                        await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId);
                        localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_${currentSelectedItem.type}`, currentTopicId);
                    }
                });

                li.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    // Pass itemConfigFull to context menu so it has all topic details
                    showTopicContextMenu(e, li, itemConfigFull, topic, currentSelectedItem.type);
                });
                topicListUl.appendChild(li);
            }
        }
    }
    // Initialize sortable for the topics list if conditions are met
    if (currentSelectedItem.id && topicsToProcess && topicsToProcess.length > 0 && typeof Sortable !== 'undefined') {
       initializeTopicSortable(currentSelectedItem.id, currentSelectedItem.type);
    }
}

function setupTopicSearch() {
    // The input might be created dynamically by loadTopicList if not present initially
    // So, we try to get it. If not found, loadTopicList will set it up.
    let searchInput = document.getElementById('topicSearchInput');
    if (searchInput) {
        setupTopicSearchListener(searchInput);
    }
}

function setupTopicSearchListener(inputElement) {
    inputElement.addEventListener('input', filterTopicList);
    inputElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            filterTopicList(); // Trigger filter on Enter key
        }
    });
}

function filterTopicList() {
    loadTopicList(); // Re-loadTopicList will apply the filter based on current search input value
}


function initializeTopicSortable(itemId, itemType) {
    const topicListUl = document.getElementById('topicList');
    if (!topicListUl) {
        console.warn("[initializeTopicSortable] topicListUl element not found. Skipping Sortable initialization.");
        return;
    }

    if (topicListUl.sortableInstance) {
        topicListUl.sortableInstance.destroy();
    }

    topicListUl.sortableInstance = new Sortable(topicListUl, {
        animation: 150,
        ghostClass: 'sortable-ghost-topic', // Distinct ghost class for topics
        chosenClass: 'sortable-chosen-topic',
        dragClass: 'sortable-drag-topic',
        onEnd: async function (evt) {
            const topicItems = Array.from(evt.to.children);
            const orderedTopicIds = topicItems.map(item => item.dataset.topicId);
            try {
                let result;
                if (itemType === 'agent') {
                    result = await window.electronAPI.saveTopicOrder(itemId, orderedTopicIds);
                } else if (itemType === 'group') {
                    result = await window.electronAPI.saveGroupTopicOrder(itemId, orderedTopicIds); // Use the new dedicated IPC call
                }

                if (result && result.success) {
                    // No need to reload here, order is saved. UI reflects sort.
                    // If backend reorders, then reload: await loadTopicList();
                    // uiHelperFunctions.showToastNotification("话题顺序已保存。"); // Removed successful save notification
                } else {
                    console.error(`Failed to save topic order for ${itemType} ${itemId}:`, result?.error);
                    uiHelperFunctions.showToastNotification(`保存话题顺序失败: ${result?.error || '未知错误'}`, 'error');
                    loadTopicList(); // Revert to saved order on error
                }
            } catch (error) {
                console.error(`Error calling saveTopicOrder for ${itemType} ${itemId}:`, error);
                uiHelperFunctions.showToastNotification(`调用保存话题顺序API时出错: ${error.message}`, 'error');
                loadTopicList(); // Revert on error
            }
        }
    });
}


function showTopicContextMenu(event, topicItemElement, itemFullConfig, topic, itemType) { // itemFullConfig has all topics
    closeContextMenu(); // General context menu closer
    closeTopicContextMenu(); // Specific topic context menu closer

    const menu = document.createElement('div');
    menu.id = 'topicContextMenu';
    menu.classList.add('context-menu');
    menu.style.top = `${event.clientY}px`;
    menu.style.left = `${event.clientX}px`;

    const editTitleOption = document.createElement('div');
    editTitleOption.classList.add('context-menu-item');
    editTitleOption.innerHTML = `<i class="fas fa-edit"></i> 编辑话题标题`;
    editTitleOption.onclick = () => {
        closeTopicContextMenu();
        const titleDisplayElement = topicItemElement.querySelector('.topic-title-display');
        if (!titleDisplayElement) return;

        const originalTitle = topic.name;
        titleDisplayElement.style.display = 'none';

        const inputWrapper = document.createElement('div');
        inputWrapper.style.display = 'flex';
        inputWrapper.style.alignItems = 'center';

        const inputField = document.createElement('input');
        inputField.type = 'text';
        inputField.value = originalTitle;
        inputField.classList.add('topic-title-edit-input'); // Add class for styling
        inputField.style.flexGrow = '1';
        inputField.onclick = (e) => e.stopPropagation(); // Prevent li click

        const confirmButton = document.createElement('button');
        confirmButton.innerHTML = '✓';
        confirmButton.classList.add('topic-title-edit-confirm');
        confirmButton.onclick = async (e) => {
            e.stopPropagation();
            const newTitle = inputField.value.trim();
            if (newTitle && newTitle !== originalTitle) {
                let saveResult;
                if (itemType === 'agent') {
                    saveResult = await window.electronAPI.saveAgentTopicTitle(itemFullConfig.id, topic.id, newTitle);
                } else if (itemType === 'group') {
                    saveResult = await window.electronAPI.saveGroupTopicTitle(itemFullConfig.id, topic.id, newTitle);
                }
                if (saveResult && saveResult.success) {
                    topic.name = newTitle; // Update local topic object (important for UI update)
                    titleDisplayElement.textContent = newTitle;
                    if (itemFullConfig.topics) { // Update the name in the full config's topic list
                        const topicInFullConfig = itemFullConfig.topics.find(t => t.id === topic.id);
                        if (topicInFullConfig) topicInFullConfig.name = newTitle;
                    }
                } else {
                    uiHelperFunctions.showToastNotification(`更新话题标题失败: ${saveResult?.error || '未知错误'}`, 'error');
                }
            }
            titleDisplayElement.style.display = '';
            inputWrapper.replaceWith(titleDisplayElement);
        };

        const cancelButton = document.createElement('button');
        cancelButton.innerHTML = '✗';
        cancelButton.classList.add('topic-title-edit-cancel');
        cancelButton.onclick = (e) => {
            e.stopPropagation();
            titleDisplayElement.style.display = '';
            inputWrapper.replaceWith(titleDisplayElement);
        };

        inputWrapper.appendChild(inputField);
        inputWrapper.appendChild(confirmButton);
        inputWrapper.appendChild(cancelButton);
        topicItemElement.insertBefore(inputWrapper, titleDisplayElement.nextSibling); // Insert after avatar if title was first
        inputField.focus();
        inputField.select();

        inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmButton.click();
            } else if (e.key === 'Escape') {
                cancelButton.click();
            }
        });
    };
    menu.appendChild(editTitleOption);

    const deleteTopicPermanentlyOption = document.createElement('div');
    deleteTopicPermanentlyOption.classList.add('context-menu-item', 'danger-item');
    deleteTopicPermanentlyOption.innerHTML = `<i class="fas fa-trash-alt"></i> 删除此话题`;
    deleteTopicPermanentlyOption.onclick = async () => {
        closeTopicContextMenu();
        if (confirm(`确定要永久删除话题 "${topic.name}" 吗？此操作不可撤销。`)) {
            let result;
            if (itemType === 'agent') {
                result = await window.electronAPI.deleteTopic(itemFullConfig.id, topic.id);
            } else if (itemType === 'group') {
                result = await window.electronAPI.deleteGroupTopic(itemFullConfig.id, topic.id);
            }

            if (result && result.success) {
                // uiHelperFunctions.showToastNotification(`话题 "${topic.name}" 已删除。`); // 移除成功提示
                // If the deleted topic was the current one, select another or show "no topic"
                if (currentTopicId === topic.id) {
                    // Update currentSelectedItem.config.topics directly from the result
                    if (result.remainingTopics) {
                        currentSelectedItem.config.topics = result.remainingTopics;
                    } else {
                        // Fallback: if remainingTopics is not provided, fetch fresh config
                        if (itemType === 'agent') {
                            const updatedConfig = await window.electronAPI.getAgentConfig(itemFullConfig.id);
                            if (updatedConfig && !updatedConfig.error) currentSelectedItem.config = updatedConfig;
                        } else if (itemType === 'group') {
                            const updatedConfig = await window.electronAPI.getAgentGroupConfig(itemFullConfig.id);
                            if (updatedConfig && !updatedConfig.error) currentSelectedItem.config = updatedConfig;
                        }
                    }

                    const remainingTopics = currentSelectedItem.config.topics; // Use the updated config

                    if (remainingTopics && remainingTopics.length > 0) {
                        // Select the first topic from the remaining ones (which are sorted by date)
                        const newSelectedTopic = remainingTopics.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
                        await selectItem(currentSelectedItem.id, currentSelectedItem.type, currentSelectedItem.name, currentSelectedItem.avatarUrl, currentSelectedItem.config); // Reselect item
                        await loadChatHistory(itemFullConfig.id, itemType, newSelectedTopic.id); // Load history for new topic
                        currentTopicId = newSelectedTopic.id; // Explicitly set currentTopicId
                        if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
                    } else {
                        currentTopicId = null;
                        if (window.messageRenderer) {
                             window.messageRenderer.setCurrentTopicId(null);
                             window.messageRenderer.clearChat();
                             window.messageRenderer.renderMessage({ role: 'system', content: '所有话题均已删除。请创建一个新话题。', timestamp: Date.now() });
                        }
                        await displayTopicTimestampBubble(itemFullConfig.id, itemType, null);
                    }
                }
                await loadTopicList(); // Refresh the topic list
            } else {
                uiHelperFunctions.showToastNotification(`删除话题 "${topic.name}" 失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        }
    };
    menu.appendChild(deleteTopicPermanentlyOption);
    

    document.body.appendChild(menu);
    document.addEventListener('click', closeTopicContextMenuOnClickOutside, true);
}

function closeTopicContextMenu() {
    const existingMenu = document.getElementById('topicContextMenu');
    if (existingMenu) {
        existingMenu.remove();
        document.removeEventListener('click', closeTopicContextMenuOnClickOutside, true);
    }
}

function closeTopicContextMenuOnClickOutside(event) {
    const menu = document.getElementById('topicContextMenu');
    if (menu && !menu.contains(event.target)) {
        closeTopicContextMenu();
    }
}


// --- UI Event Listeners & Helpers ---
function setupEventListeners() {
    if (chatMessagesDiv) {
        chatMessagesDiv.addEventListener('click', (event) => {
            const target = event.target.closest('a');
            if (target && target.href) {
                const href = target.href;
                event.preventDefault(); // Prevent default navigation for all links within chat

                if (href.startsWith('#')) { // Internal page anchors
                    console.log('Internal anchor link clicked:', href);
                    // Allow default or custom scroll if desired, for now, Electron handles it if it's a valid ID
                    return;
                }
                if (href.toLowerCase().startsWith('javascript:')) {
                    console.warn('JavaScript link clicked, ignoring.');
                    return;
                }
                // For http, https, file protocols, open externally
                if (href.startsWith('http:') || href.startsWith('https:') || href.startsWith('file:')) {
                    if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                        window.electronAPI.sendOpenExternalLink(href);
                    } else {
                        console.warn('[Renderer] electronAPI.sendOpenExternalLink is not available.');
                    }
                } else {
                    console.warn(`[Renderer] Clicked link with unhandled protocol: ${href}`);
                }
            }
        });
    } else {
        console.error('[Renderer] chatMessagesDiv not found during setupEventListeners.');
    }

    sendMessageBtn.addEventListener('click', handleSendMessage);
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    messageInput.addEventListener('input', () => autoResizeTextarea(messageInput));

    attachFileBtn.addEventListener('click', async () => {
        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelperFunctions.showToastNotification("请先选择一个项目和话题以上传附件。", 'error');
            return;
        }
        const result = await window.electronAPI.selectFilesToSend(currentSelectedItem.id, currentTopicId);

        if (result && result.success && result.attachments && result.attachments.length > 0) {
            result.attachments.forEach(att => {
                if (att.error) {
                    console.error(`Error processing selected file ${att.name || 'unknown'}: ${att.error}`);
                    uiHelperFunctions.showToastNotification(`处理文件 ${att.name || '未知文件'} 失败: ${att.error}`, 'error');
                } else {
                    // Ensure `file` object structure is consistent for `updateAttachmentPreview`
                    attachedFiles.push({
                        file: { name: att.name, type: att.type, size: att.size }, // Standard File-like object
                        localPath: att.internalPath, // Path from fileManager
                        originalName: att.name,
                        _fileManagerData: att // Full object from fileManager for reference
                    });
                }
            });
            updateAttachmentPreview();
        } else if (result && !result.success && result.attachments && result.attachments.length === 0) {
            console.log('[Renderer] File selection cancelled or no files selected.');
        } else if (result && result.error) {
            uiHelperFunctions.showToastNotification(`选择文件时出错: ${result.error}`, 'error');
        }
    });
    
 
    globalSettingsBtn.addEventListener('click', () => openModal('globalSettingsModal'));
    globalSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newSettings = { // Read directly from globalSettings for widths
            userName: document.getElementById('userName').value.trim() || '用户',
            vcpServerUrl: document.getElementById('vcpServerUrl').value.trim(),
            vcpApiKey: document.getElementById('vcpApiKey').value,
            vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
            vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
            sidebarWidth: globalSettings.sidebarWidth, // Keep existing value if not changed by resizer
            notificationsSidebarWidth: globalSettings.notificationsSidebarWidth, // Keep existing
            // userAvatarUrl and userAvatarCalculatedColor are handled by saveUserAvatar
        };

        const userAvatarCropped = getCroppedFile('user'); // Use central getter
        if (userAvatarCropped) {
            try {
                const arrayBuffer = await userAvatarCropped.arrayBuffer();
                const avatarSaveResult = await window.electronAPI.saveUserAvatar({
                    name: userAvatarCropped.name,
                    type: userAvatarCropped.type,
                    buffer: arrayBuffer
                });
                if (avatarSaveResult.success) {
                    globalSettings.userAvatarUrl = avatarSaveResult.avatarUrl;
                    userAvatarPreview.src = avatarSaveResult.avatarUrl; // Already has timestamp
                    userAvatarPreview.style.display = 'block';
                    if (window.messageRenderer) {
                        window.messageRenderer.setUserAvatar(avatarSaveResult.avatarUrl);
                    }
                    if (avatarSaveResult.needsColorExtraction && window.electronAPI && window.electronAPI.saveAvatarColor) {
                        getAverageColorFromAvatar(avatarSaveResult.avatarUrl, (avgColor) => {
                            if (avgColor) {
                                window.electronAPI.saveAvatarColor({ type: 'user', id: 'user_global', color: avgColor })
                                    .then((saveColorResult) => {
                                        if (saveColorResult && saveColorResult.success) {
                                            globalSettings.userAvatarCalculatedColor = avgColor; // Update global state
                                            if (window.messageRenderer) window.messageRenderer.setUserAvatarColor(avgColor);
                                        } else {
                                            console.warn("Failed to save user avatar color:", saveColorResult?.error);
                                        }
                                    }).catch(err => console.error("Error saving user avatar color:", err));
                            }
                        });
                    }
                    setCroppedFile('user', null); // Clear centrally
                    userAvatarInput.value = ''; // Clear file input
                } else {
                    uiHelperFunctions.showToastNotification(`保存用户头像失败: ${avatarSaveResult.error}`, 'error');
                }
            } catch (readError) {
                uiHelperFunctions.showToastNotification(`读取用户头像文件失败: ${readError.message}`, 'error');
            }
        }

        const result = await window.electronAPI.saveSettings(newSettings);
        if (result.success) {
            globalSettings = {...globalSettings, ...newSettings }; // Update local globalSettings
            uiHelperFunctions.showToastNotification('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
            closeModal('globalSettingsModal');
            if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
                 window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
            } else {
                 window.electronAPI.disconnectVCPLog();
                 if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
            }
       } else {
           uiHelperFunctions.showToastNotification(`保存全局设置失败: ${result.error}`, 'error');
        }
    });

    if (userAvatarInput) {
        userAvatarInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                openAvatarCropper(file, (croppedFile) => {
                    setCroppedFile('user', croppedFile); // Use central setter
                    if (userAvatarPreview) {
                        userAvatarPreview.src = URL.createObjectURL(croppedFile);
                        userAvatarPreview.style.display = 'block';
                    }
                }, 'user'); // Pass type to cropper
            } else {
                if (userAvatarPreview) userAvatarPreview.style.display = 'none';
                setCroppedFile('user', null);
            }
        });
    }

    // "Create Agent" button
    if (createNewAgentBtn) {
        createNewAgentBtn.textContent = '创建 Agent'; // Update text
        createNewAgentBtn.style.width = 'auto'; // Adjust width
        createNewAgentBtn.addEventListener('click', async () => {
            const defaultAgentName = `新Agent_${Date.now()}`;
            const result = await window.electronAPI.createAgent(defaultAgentName); // No initial config
            if (result.success) {
                await loadItems(); // Reload combined list
                // Select the new agent and open its settings
                await selectItem(result.agentId, 'agent', result.agentName, null, result.config);
                switchToTab('settings'); // displaySettingsForItem will be called by selectItem or switchToTab
            } else {
                uiHelperFunctions.showToastNotification(`创建Agent失败: ${result.error}`, 'error');
            }
        });
    }
    // "Create Group" button (listener typically in GroupRenderer.init or similar)
    if (createNewGroupBtn) {
        createNewGroupBtn.style.display = 'inline-block'; // Make it visible
        // The actual click listener for createNewGroupBtn should be in GroupRenderer.js
        // to keep group creation logic encapsulated there.
        // If GroupRenderer.handleCreateNewGroup needs to be called from here:
        // createNewGroupBtn.addEventListener('click', () => {
        //    if(window.GroupRenderer) window.GroupRenderer.handleCreateNewGroup();
        // });
    }


    currentItemActionBtn.addEventListener('click', async () => {
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个项目。", 'error');
            return;
        }
        await createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
    });

    if (agentSettingsForm) { // Check if the agent-specific form exists
        agentSettingsForm.addEventListener('submit', saveCurrentAgentSettings);
    }
    if (deleteItemBtn) { // Generic delete button for agent or group settings
        deleteItemBtn.addEventListener('click', handleDeleteCurrentItem);
    }

    if(agentAvatarInput){ // Check if agent-specific avatar input exists
        agentAvatarInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                openAvatarCropper(file, (croppedFileResult) => {
                    setCroppedFile('agent', croppedFileResult); // Store for agent settings save
                    if (agentAvatarPreview) {
                        agentAvatarPreview.src = URL.createObjectURL(croppedFileResult);
                        agentAvatarPreview.style.display = 'block';
                    }
                }, 'agent'); // Pass type
            } else {
                if(agentAvatarPreview) agentAvatarPreview.style.display = 'none';
                setCroppedFile('agent', null);
            }
        });
    }


    clearCurrentChatBtn.addEventListener('click', async () => {
        if (currentSelectedItem.id && currentTopicId && confirm(`确定要清空当前话题的聊天记录吗（${currentSelectedItem.type === 'group' ? '群组' : '助手'}: ${currentSelectedItem.name}）？此操作不可撤销。`)) {
            currentChatHistory = [];
            // Save empty history for the correct item type and ID
            if (currentSelectedItem.type === 'agent') {
                await window.electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, []);
            } else if (currentSelectedItem.type === 'group') {
                // Assuming groupchat.js has a saveGroupChatHistory or similar that main.js exposes
                // For now, let's assume renderer.js doesn't directly call save for group history,
                // groupchat.js manages its own history saving after each message.
                // If explicit clearing is needed, main.js needs an IPC handler for it.
                // For now, we'll just clear UI and local history.
                // TODO: Add IPC for clearing group chat history if needed from main.js
                 if (window.messageRenderer) window.messageRenderer.clearChat();
                 uiHelperFunctions.showToastNotification("群聊记录已在本地清空 (后端清空待实现)。");

            }
            if (window.messageRenderer) {
                 window.messageRenderer.clearChat(); // Clears UI
                 window.messageRenderer.renderMessage({ role: 'system', content: '当前话题聊天记录已清空。', timestamp: Date.now() });
            }
            
            // Reset topic title for agents
            if (currentSelectedItem.type === 'agent') {
                const clearedTopicName = `话题 ${currentTopicId.substring(0,8)}...`;
                const titleSaveResult = await window.electronAPI.saveAgentTopicTitle(currentSelectedItem.id, currentTopicId, clearedTopicName);
                if (titleSaveResult.success) {
                    if (document.getElementById('tabContentTopics').classList.contains('active')) {
                        loadTopicList();
                    }
                }
            }
            uiHelperFunctions.showToastNotification('当前话题聊天记录已清空，话题标题已重置。');
        } else if (!currentTopicId) {
            uiHelperFunctions.showToastNotification("没有选中的话题可清空。", 'info');
        }
    });

    clearNotificationsBtn.addEventListener('click', () => {
        notificationsListUl.innerHTML = '';
    });

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const sunIcon = document.getElementById('sun-icon');
            const moonIcon = document.getElementById('moon-icon');

            document.body.classList.toggle('light-theme');
            if (document.body.classList.contains('light-theme')) {
                localStorage.setItem('theme', 'light');
                if (sunIcon) sunIcon.style.display = 'none';
                if (moonIcon) moonIcon.style.display = 'inline-block'; 
            } else {
                localStorage.setItem('theme', 'dark');
                if (sunIcon) sunIcon.style.display = 'inline-block'; 
                if (moonIcon) moonIcon.style.display = 'none';
            }
        });
    }

    const openNotesBtn = document.getElementById('openNotesBtn');
    if (openAdminPanelBtn) {
        openAdminPanelBtn.style.display = 'inline-block'; // Should be visible by default
        openAdminPanelBtn.addEventListener('click', async () => {
            if (globalSettings.vcpServerUrl) {
                if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                    try {
                        const apiUrl = new URL(globalSettings.vcpServerUrl);
                        let adminPanelUrl = `${apiUrl.protocol}//${apiUrl.host}`;
                        if (!adminPanelUrl.endsWith('/')) {
                            adminPanelUrl += '/';
                        }
                        adminPanelUrl += 'AdminPanel/'; // Standard path

                        window.electronAPI.sendOpenExternalLink(adminPanelUrl);
                    } catch (e) {
                        console.error('构建管理面板URL失败:', e);
                        uiHelperFunctions.showToastNotification('无法构建管理面板URL。请检查VCP服务器URL。', 'error');
                    }
                } else {
                    console.warn('[Renderer] electronAPI.sendOpenExternalLink is not available.');
                    uiHelperFunctions.showToastNotification('无法打开管理面板：功能不可用。', 'error');
                }
            } else {
                uiHelperFunctions.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
                openModal('globalSettingsModal');
            }
        });
    }

    if (openNotesBtn) {
        openNotesBtn.addEventListener('click', async () => {
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            if (window.electronAPI && window.electronAPI.openNotesWindow) {
                await window.electronAPI.openNotesWindow(currentTheme);
            } else {
                console.warn('[Renderer] electronAPI.openNotesWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开笔记：功能不可用。', 'error');
            }
        });
    }

    if (toggleNotificationsBtn && notificationsSidebar) {
        toggleNotificationsBtn.addEventListener('click', () => {
            window.electronAPI.sendToggleNotificationsSidebar(); // Send to main
        });

        // Listen for main process to actually toggle
        window.electronAPI.onDoToggleNotificationsSidebar(() => {
            const isActive = notificationsSidebar.classList.toggle('active');
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.classList.toggle('notifications-sidebar-active', isActive);
            }
            if (isActive && globalSettings.notificationsSidebarWidth) {
                 notificationsSidebar.style.width = `${globalSettings.notificationsSidebarWidth}px`;
            }
        });
    }
}

 
// --- Resizer Functionality ---
function initializeResizers() {
    let isResizingLeft = false;
    let isResizingRight = false;
    let startX = 0;

    if (resizerLeft && leftSidebar) {
        resizerLeft.addEventListener('mousedown', (e) => {
            isResizingLeft = true;
            startX = e.clientX;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none'; // Prevent text selection
            if (leftSidebar) leftSidebar.style.transition = 'none'; // Disable transition during drag
        });
    }

    if (resizerRight && rightNotificationsSidebar) {
        resizerRight.addEventListener('mousedown', (e) => {
            if (!rightNotificationsSidebar.classList.contains('active')) {
                window.electronAPI.sendToggleNotificationsSidebar(); // Activate it
                requestAnimationFrame(() => { // Wait for activation and width application
                    isResizingRight = true;
                    startX = e.clientX;
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                    rightNotificationsSidebar.style.transition = 'none';
                });
            } else {
                isResizingRight = true;
                startX = e.clientX;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                rightNotificationsSidebar.style.transition = 'none';
            }
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (isResizingLeft && leftSidebar) {
            const deltaX = e.clientX - startX;
            const currentWidth = leftSidebar.offsetWidth;
            let newWidth = currentWidth + deltaX;
            newWidth = Math.max(parseInt(getComputedStyle(leftSidebar).minWidth, 10) || 180, Math.min(newWidth, parseInt(getComputedStyle(leftSidebar).maxWidth, 10) || 600)); 
            leftSidebar.style.width = `${newWidth}px`;
            startX = e.clientX;
        }
        if (isResizingRight && rightNotificationsSidebar && rightNotificationsSidebar.classList.contains('active')) {
            const deltaX = e.clientX - startX;
            const currentWidth = rightNotificationsSidebar.offsetWidth;
            let newWidth = currentWidth - deltaX; // Dragging right (towards center) decreases width of right sidebar
            newWidth = Math.max(parseInt(getComputedStyle(rightNotificationsSidebar).minWidth, 10) || 220, Math.min(newWidth, parseInt(getComputedStyle(rightNotificationsSidebar).maxWidth, 10) || 600));
            rightNotificationsSidebar.style.width = `${newWidth}px`;
            startX = e.clientX;
        }
    });

    document.addEventListener('mouseup', async () => {
        let settingsChanged = false;
        if (isResizingLeft && leftSidebar) {
            leftSidebar.style.transition = ''; // Restore transition
            const newSidebarWidth = leftSidebar.offsetWidth;
            if (globalSettings.sidebarWidth !== newSidebarWidth) {
                globalSettings.sidebarWidth = newSidebarWidth;
                settingsChanged = true;
            }
        }
        if (isResizingRight && rightNotificationsSidebar && rightNotificationsSidebar.classList.contains('active')) {
            rightNotificationsSidebar.style.transition = '';
            const newNotificationsWidth = rightNotificationsSidebar.offsetWidth;
             if (globalSettings.notificationsSidebarWidth !== newNotificationsWidth) {
                globalSettings.notificationsSidebarWidth = newNotificationsWidth;
                settingsChanged = true;
            }
        }

        isResizingLeft = false;
        isResizingRight = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (settingsChanged) {
            try {
                await window.electronAPI.saveSettings(globalSettings); // Save all global settings including potentially updated widths
                console.log('Sidebar widths saved to settings.');
            } catch (error) {
                console.error('Failed to save sidebar widths:', error);
            }
        }
    });
}


function updateAttachmentPreview() {
    if (!attachmentPreviewArea) {
        console.error('[Renderer] updateAttachmentPreview: attachmentPreviewArea is null or undefined!');
        return;
    }

    attachmentPreviewArea.innerHTML = ''; // Clear previous previews
    if (attachedFiles.length === 0) {
        attachmentPreviewArea.style.display = 'none';
        return;
    }
    attachmentPreviewArea.style.display = 'flex'; // Show the area

    attachedFiles.forEach((af, index) => {
        const prevDiv = document.createElement('div');
        prevDiv.className = 'attachment-preview-item';
        prevDiv.title = af.originalName || af.file.name;

        const fileType = af.file.type;

        if (fileType.startsWith('image/')) {
            const thumbnailImg = document.createElement('img');
            thumbnailImg.className = 'attachment-thumbnail-image';
            thumbnailImg.src = af.localPath; // Assumes localPath is a usable URL (e.g., file://)
            thumbnailImg.alt = af.originalName || af.file.name;
            thumbnailImg.onerror = () => { // Fallback to icon if image fails to load
                thumbnailImg.remove(); // Remove broken image
                const iconSpanFallback = document.createElement('span');
                iconSpanFallback.className = 'file-preview-icon';
                iconSpanFallback.textContent = '⚠️'; // Error/fallback icon
                prevDiv.prepend(iconSpanFallback); // Add fallback icon at the beginning
            };
            prevDiv.appendChild(thumbnailImg);
        } else {
            const iconSpan = document.createElement('span');
            iconSpan.className = 'file-preview-icon';
            if (fileType.startsWith('audio/')) {
                iconSpan.textContent = '🎵';
            } else if (fileType.startsWith('video/')) {
                iconSpan.textContent = '🎞️';
            } else if (fileType.includes('pdf')) {
                iconSpan.textContent = '📄';
            } else {
                iconSpan.textContent = '📎';
            }
            prevDiv.appendChild(iconSpan);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-preview-name';
        const displayName = af.originalName || af.file.name;
        nameSpan.textContent = displayName.length > 20 ? displayName.substring(0, 17) + '...' : displayName;
        prevDiv.appendChild(nameSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = '移除此附件';
        removeBtn.onclick = () => {
            attachedFiles.splice(index, 1);
            updateAttachmentPreview();
        };
        prevDiv.appendChild(removeBtn);

        attachmentPreviewArea.appendChild(prevDiv);
    });
}


function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto'; 
    textarea.style.height = textarea.scrollHeight + 'px';
}

function openModal(modalId) {
    const modalElement = document.getElementById(modalId);
    if (modalElement) modalElement.classList.add('active');
}
function closeModal(modalId) {
    const modalElement = document.getElementById(modalId);
    if (modalElement) modalElement.classList.remove('active');
}
 
async function openAvatarCropper(file, onCropConfirmedCallback, cropType = 'agent') { // cropType: 'agent', 'group', 'user'
    const modal = document.getElementById('avatarCropperModal');
    const cropperContainer = document.getElementById('avatarCropperContainer');
    const canvas = document.getElementById('avatarCanvas'); // Main canvas for drawing image
    const ctx = canvas.getContext('2d');
    const cropCircleSVG = document.getElementById('cropCircle'); // The visual circle
    const cropCircleBorderSVG = document.getElementById('cropCircleBorder'); // Border for the circle
    const confirmCropBtn = document.getElementById('confirmCropBtn');
    const cancelCropBtn = document.getElementById('cancelCropBtn');

    openModal('avatarCropperModal');
    canvas.style.display = 'block'; // Make sure canvas is visible
    cropperContainer.style.cursor = 'grab';

    let img = new Image();
    let currentEventListeners = {}; // To store and remove listeners

    img.onload = () => {
        canvas.width = 360; // Fixed size for the drawing canvas
        canvas.height = 360;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0)'; // Transparent background for drawing
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Scale image to fit within the 360x360 canvas while maintaining aspect ratio
        let scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        let scaledWidth = img.width * scale;
        let scaledHeight = img.height * scale;
        let offsetX = (canvas.width - scaledWidth) / 2;
        let offsetY = (canvas.height - scaledHeight) / 2;
        ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

        let circle = { x: canvas.width / 2, y: canvas.height / 2, r: Math.min(canvas.width / 2, canvas.height / 2, 100) }; // Default radius
        updateCircleSVG();

        let isDragging = false;
        let dragStartX, dragStartY, circleStartX, circleStartY;

        function updateCircleSVG() {
            cropCircleSVG.setAttribute('cx', circle.x);
            cropCircleSVG.setAttribute('cy', circle.y);
            cropCircleSVG.setAttribute('r', circle.r);
            cropCircleBorderSVG.setAttribute('cx', circle.x);
            cropCircleBorderSVG.setAttribute('cy', circle.y);
            cropCircleBorderSVG.setAttribute('r', circle.r);
        }

        currentEventListeners.onMouseDown = (e) => {
            const rect = cropperContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            if (Math.sqrt((mouseX - circle.x)**2 + (mouseY - circle.y)**2) < circle.r + 10) { // Allow dragging near circle
                isDragging = true;
                dragStartX = mouseX;
                dragStartY = mouseY;
                circleStartX = circle.x;
                circleStartY = circle.y;
                cropperContainer.style.cursor = 'grabbing';
            }
        };

        currentEventListeners.onMouseMove = (e) => {
            if (!isDragging) return;
            const rect = cropperContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            circle.x = circleStartX + (mouseX - dragStartX);
            circle.y = circleStartY + (mouseY - dragStartY);
            // Clamp circle to stay within canvas boundaries
            circle.x = Math.max(circle.r, Math.min(canvas.width - circle.r, circle.x));
            circle.y = Math.max(circle.r, Math.min(canvas.height - circle.r, circle.y));
            updateCircleSVG();
        };

        currentEventListeners.onMouseUpOrLeave = () => {
            isDragging = false;
            cropperContainer.style.cursor = 'grab';
        };

        currentEventListeners.onWheel = (e) => {
            e.preventDefault();
            const zoomFactor = e.deltaY < 0 ? 1.05 : 0.95; // Smaller zoom steps
            const newRadius = Math.max(30, Math.min(Math.min(canvas.width, canvas.height) / 2, circle.r * zoomFactor));
            if (newRadius === circle.r) return;
            circle.r = newRadius;
            // Recalculate clamping after zoom to ensure it stays within bounds
            circle.x = Math.max(circle.r, Math.min(canvas.width - circle.r, circle.x));
            circle.y = Math.max(circle.r, Math.min(canvas.height - circle.r, circle.y));
            updateCircleSVG();
        };

        currentEventListeners.onConfirmCrop = () => {
            const finalCropCanvas = document.createElement('canvas');
            const finalSize = circle.r * 2;
            finalCropCanvas.width = finalSize;
            finalCropCanvas.height = finalSize;
            const finalCtx = finalCropCanvas.getContext('2d');

            // Draw the selected part of the original image (from the main canvas) onto the final canvas
            finalCtx.drawImage(canvas, // Source canvas (where original image is drawn)
                circle.x - circle.r, circle.y - circle.r, // Top-left corner of the crop square on source
                finalSize, finalSize, // Size of the crop square on source
                0, 0,                 // Top-left corner on destination (finalCropCanvas)
                finalSize, finalSize  // Size on destination
            );

            // Make it circular (alpha mask)
            finalCtx.globalCompositeOperation = 'destination-in';
            finalCtx.beginPath();
            finalCtx.arc(circle.r, circle.r, circle.r, 0, Math.PI * 2); // Center of the final canvas
            finalCtx.fill();
            finalCtx.globalCompositeOperation = 'source-over'; // Reset composite operation

            finalCropCanvas.toBlob((blob) => {
                if (!blob) {
                    console.error("[AvatarCropper] Failed to create blob from final canvas.");
                    uiHelperFunctions.showToastNotification("裁剪失败，无法生成图片数据。", 'error');
                    return;
                }
                const croppedFile = new File([blob], `${cropType}_avatar.png`, { type: "image/png" });
                if (typeof onCropConfirmedCallback === 'function') {
                    onCropConfirmedCallback(croppedFile);
                }
                cleanupAndClose();
            }, 'image/png');
        };

        currentEventListeners.onCancelCrop = () => {
            cleanupAndClose();
            if (cropType === 'agent' && agentAvatarInput) agentAvatarInput.value = '';
            else if (cropType === 'user' && userAvatarInput) userAvatarInput.value = '';
            else if (cropType === 'group' && window.GroupRenderer) { // Assuming group avatar input is managed by GroupRenderer
                const groupAvatarInputElement = document.getElementById('groupAvatarInput'); // Or however GroupRenderer accesses it
                if (groupAvatarInputElement) groupAvatarInputElement.value = '';
            }
        };

        function cleanupAndClose() {
            cropperContainer.removeEventListener('mousedown', currentEventListeners.onMouseDown);
            document.removeEventListener('mousemove', currentEventListeners.onMouseMove);
            document.removeEventListener('mouseup', currentEventListeners.onMouseUpOrLeave);
            cropperContainer.removeEventListener('mouseleave', currentEventListeners.onMouseUpOrLeave);
            cropperContainer.removeEventListener('wheel', currentEventListeners.onWheel);
            confirmCropBtn.removeEventListener('click', currentEventListeners.onConfirmCrop);
            cancelCropBtn.removeEventListener('click', currentEventListeners.onCancelCrop);
            closeModal('avatarCropperModal');
        }

        // Attach event listeners
        cropperContainer.addEventListener('mousedown', currentEventListeners.onMouseDown);
        document.addEventListener('mousemove', currentEventListeners.onMouseMove);
        document.addEventListener('mouseup', currentEventListeners.onMouseUpOrLeave);
        cropperContainer.addEventListener('mouseleave', currentEventListeners.onMouseUpOrLeave);
        cropperContainer.addEventListener('wheel', currentEventListeners.onWheel);
        confirmCropBtn.addEventListener('click', currentEventListeners.onConfirmCrop);
        cancelCropBtn.addEventListener('click', currentEventListeners.onCancelCrop);
    };

    img.onerror = () => {
        console.error("[AvatarCropper] Image failed to load from blob URL.");
        uiHelperFunctions.showToastNotification("无法加载选择的图片，请尝试其他图片。", 'error');
        closeModal('avatarCropperModal');
    };
    img.src = URL.createObjectURL(file); // Load the image file
}

function displaySettingsForItem() {
    // Ensure both containers exist before manipulating them
    const agentSettingsExists = agentSettingsContainer && typeof agentSettingsContainer.style !== 'undefined';
    const groupSettingsExists = groupSettingsContainer && typeof groupSettingsContainer.style !== 'undefined';

    if (currentSelectedItem.id) {
        selectItemPromptForSettings.style.display = 'none';
        selectedItemNameForSettingsSpan.textContent = currentSelectedItem.name || currentSelectedItem.id;

        if (currentSelectedItem.type === 'agent') {
            if (agentSettingsExists) agentSettingsContainer.style.display = 'block';
            if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
            itemSettingsContainerTitle.textContent = 'Agent 设置: ';
            deleteItemBtn.textContent = '删除此 Agent';
            populateAgentSettingsForm(currentSelectedItem.id, currentSelectedItem.config);
        } else if (currentSelectedItem.type === 'group') {
            if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
            if (groupSettingsExists) groupSettingsContainer.style.display = 'block';
            itemSettingsContainerTitle.textContent = '群组设置: ';
            deleteItemBtn.textContent = '删除此群组';
            if (window.GroupRenderer && typeof window.GroupRenderer.displayGroupSettingsPage === 'function') {
                window.GroupRenderer.displayGroupSettingsPage(currentSelectedItem.id);
            } else {
                console.error("GroupRenderer or displayGroupSettingsPage not available.");
                if (groupSettingsExists) groupSettingsContainer.innerHTML = "<p>无法加载群组设置界面。</p>";
            }
        }
    } else {
        if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
        if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
        selectItemPromptForSettings.textContent = '请先在左侧选择一个 Agent 或群组以查看或修改其设置。';
        selectItemPromptForSettings.style.display = 'block';
        itemSettingsContainerTitle.textContent = '设置';
        selectedItemNameForSettingsSpan.textContent = '';
    }
}

async function populateAgentSettingsForm(agentId, agentConfig) {
    // This function is specific to agent settings

    // Ensure group settings are hidden when populating agent settings
    if (groupSettingsContainer && typeof groupSettingsContainer.style !== 'undefined') {
        groupSettingsContainer.style.display = 'none';
    } else {
        const fallbackGroupSettings = document.getElementById('groupSettingsContainer');
        if (fallbackGroupSettings) fallbackGroupSettings.style.display = 'none';
        else console.warn('[Renderer populateAgentSettingsForm] groupSettingsContainer (and fallback) is undefined, cannot hide group settings.');
    }
    // Ensure agent settings container is visible
    if (agentSettingsContainer && typeof agentSettingsContainer.style !== 'undefined') {
        agentSettingsContainer.style.display = 'block';
    }


    if (!agentConfig || agentConfig.error) {
        uiHelperFunctions.showToastNotification(`加载Agent配置失败: ${agentConfig?.error || '未知错误'}`, 'error');
        if (agentSettingsContainer) agentSettingsContainer.style.display = 'none';
        selectItemPromptForSettings.textContent = `加载 ${agentId} 配置失败。`;
        selectItemPromptForSettings.style.display = 'block';
        return;
    }
    
    editingAgentIdInput.value = agentId; // This input is part of agentSettingsForm
    agentNameInput.value = agentConfig.name || agentId;
    agentSystemPromptTextarea.value = agentConfig.systemPrompt || '';
    agentModelInput.value = agentConfig.model || '';
    agentTemperatureInput.value = agentConfig.temperature !== undefined ? agentConfig.temperature : 0.7;
    agentContextTokenLimitInput.value = agentConfig.contextTokenLimit !== undefined ? agentConfig.contextTokenLimit : 4000; // Default from your main.js
    agentMaxOutputTokensInput.value = agentConfig.maxOutputTokens !== undefined ? agentConfig.maxOutputTokens : 1000; // Default from your main.js

    const streamOutput = agentConfig.streamOutput !== undefined ? agentConfig.streamOutput : true;
    document.getElementById('agentStreamOutputTrue').checked = streamOutput === true || String(streamOutput) === 'true';
    document.getElementById('agentStreamOutputFalse').checked = streamOutput === false || String(streamOutput) === 'false';
    
    if (agentConfig.avatarUrl) { // Use avatarUrl from the full config
        agentAvatarPreview.src = `${agentConfig.avatarUrl}${agentConfig.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
        agentAvatarPreview.style.display = 'block';
    } else {
        agentAvatarPreview.src = '#';
        agentAvatarPreview.style.display = 'none';
    }
    agentAvatarInput.value = ''; // Clear file input
    setCroppedFile('agent', null); // Clear any previously cropped agent avatar
}

 
async function saveCurrentAgentSettings(event) { // This is specifically for AGENT settings
    event.preventDefault();
    const agentId = editingAgentIdInput.value; // From agent settings form
    const newConfig = {
        name: agentNameInput.value.trim(),
        systemPrompt: agentSystemPromptTextarea.value.trim(),
        model: agentModelInput.value.trim() || 'gemini-pro',
        temperature: parseFloat(agentTemperatureInput.value),
        contextTokenLimit: parseInt(agentContextTokenLimitInput.value),
        maxOutputTokens: parseInt(agentMaxOutputTokensInput.value),
        streamOutput: document.getElementById('agentStreamOutputTrue').checked
    };
 
    if (!newConfig.name) {
        uiHelperFunctions.showToastNotification("Agent名称不能为空！", 'error');
        return;
    }
 
    const croppedFile = getCroppedFile('agent'); // Get agent-specific cropped file
    if (croppedFile) {
        try {
            const arrayBuffer = await croppedFile.arrayBuffer();
            const avatarResult = await window.electronAPI.saveAvatar(agentId, { // saveAvatar is for agents
                name: croppedFile.name,
                type: croppedFile.type,
                buffer: arrayBuffer
            });
 
            if (avatarResult.error) {
                uiHelperFunctions.showToastNotification(`保存Agent头像失败: ${avatarResult.error}`, 'error');
            } else {
                // Color extraction for agent avatar
                if (avatarResult.needsColorExtraction && window.electronAPI && window.electronAPI.saveAvatarColor) {
                     getAverageColorFromAvatar(avatarResult.avatarUrl, (avgColor) => {
                        if (avgColor) {
                            window.electronAPI.saveAvatarColor({ type: 'agent', id: agentId, color: avgColor })
                                .then((saveColorResult) => {
                                    if (saveColorResult && saveColorResult.success) {
                                        if(currentSelectedItem.id === agentId && currentSelectedItem.type === 'agent' && window.messageRenderer) {
                                            window.messageRenderer.setCurrentItemAvatarColor(avgColor);
                                        }
                                    } else {
                                        console.warn(`Failed to save agent ${agentId} avatar color:`, saveColorResult?.error);
                                    }
                                }).catch(err => console.error(`Error saving agent ${agentId} avatar color:`, err));
                        }
                    });
                }
                agentAvatarPreview.src = avatarResult.avatarUrl; // Update preview
                setCroppedFile('agent', null); // Clear after successful save
                agentAvatarInput.value = '';
            }
        } catch (readError) {
            console.error("读取Agent头像文件失败:", readError);
            uiHelperFunctions.showToastNotification(`读取Agent头像文件失败: ${readError.message}`, 'error');
        }
    }
 
    const result = await window.electronAPI.saveAgentConfig(agentId, newConfig);
    const saveButton = agentSettingsForm.querySelector('button[type="submit"]');
 
    if (result.success) {
        if (saveButton) uiHelperFunctions.showSaveFeedback(saveButton, true, '已保存!', '保存 Agent 设置');
        await loadItems(); // Reload combined list
        // If current selected agent is this one, update its details in UI
        if (currentSelectedItem.id === agentId && currentSelectedItem.type === 'agent') {
            const updatedAgentConfig = await window.electronAPI.getAgentConfig(agentId); // Fetch full updated config
            currentSelectedItem.name = newConfig.name;
            currentSelectedItem.config = updatedAgentConfig; // Update stored config
            currentChatNameH3.textContent = `与 ${newConfig.name} 聊天中`;
            if (window.messageRenderer) {
                window.messageRenderer.setCurrentItemAvatar(updatedAgentConfig.avatarUrl); // Update avatar in message renderer
                window.messageRenderer.setCurrentItemAvatarColor(updatedAgentConfig.avatarCalculatedColor || null);
            }
            selectedItemNameForSettingsSpan.textContent = newConfig.name;
        }
         // uiHelperFunctions.showToastNotification(`Agent "${newConfig.name}" 设置已保存。`); // 移除成功提示
    } else {
        if (saveButton) uiHelperFunctions.showSaveFeedback(saveButton, false, '保存失败', '保存 Agent 设置');
        uiHelperFunctions.showToastNotification(`保存Agent设置失败: ${result.error}`, 'error');
    }
}

async function handleDeleteCurrentItem() { // Generic delete for agent or group
    if (!currentSelectedItem.id) {
        uiHelperFunctions.showToastNotification("没有选中的项目可删除。", 'info');
        return;
    }

    const itemTypeDisplay = currentSelectedItem.type === 'group' ? '群组' : 'Agent';
    const itemName = currentSelectedItem.name || '当前选中的项目';

    if (confirm(`您确定要删除 ${itemTypeDisplay} "${itemName}" 吗？其所有聊天记录和设置都将被删除，此操作不可撤销！`)) {
        let result;
        if (currentSelectedItem.type === 'agent') {
            result = await window.electronAPI.deleteAgent(currentSelectedItem.id);
        } else if (currentSelectedItem.type === 'group') {
            result = await window.electronAPI.deleteAgentGroup(currentSelectedItem.id);
        }

        if (result && result.success) {
            // uiHelperFunctions.showToastNotification(`${itemTypeDisplay} ${itemName} 已删除。`); // 移除成功提示
            const deletedItemId = currentSelectedItem.id;
            
            currentSelectedItem = { id: null, type: null, name: null, avatarUrl: null, config: null }; // Reset selected item
            currentTopicId = null;
            currentChatHistory = [];
            
            displayNoItemSelected(); // Show default "select an item" state
            await loadItems(); // Reload the main item list
            // displaySettingsForItem(); // Will show "select item" as currentSelectedItem is null
            // loadTopicList(); // Will also show "select item"
        } else {
            uiHelperFunctions.showToastNotification(`删除${itemTypeDisplay}失败: ${result?.error || '未知错误'}`, 'error');
        }
    }
}


async function createNewTopicForItem(itemId, itemType) {
    if (!itemId) {
        uiHelperFunctions.showToastNotification("请先选择一个项目。", 'error');
        return;
    }

    const itemName = currentSelectedItem.name || (itemType === 'group' ? "当前群组" : "当前助手");
    const newTopicName = `新话题 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    
    try {
        let result;
        if (itemType === 'agent') {
            result = await window.electronAPI.createNewTopicForAgent(itemId, newTopicName);
        } else if (itemType === 'group') {
            result = await window.electronAPI.createNewTopicForGroup(itemId, newTopicName);
        }

        if (result && result.success && result.topicId) {
            currentTopicId = result.topicId;
            currentChatHistory = []; // Clear history for new topic
            
            if (window.messageRenderer) {
                window.messageRenderer.setCurrentTopicId(currentTopicId);
                window.messageRenderer.clearChat(); // Clear UI
                window.messageRenderer.renderMessage({ role: 'system', content: `新话题 "${result.topicName}" 已开始。`, timestamp: Date.now() });
            }
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, currentTopicId);
            
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                await loadTopicList(); // Refresh topic list UI
            } else { // If not on topics tab, still need to update its internal state potentially
                // Or simply ensure topic list is reloaded next time it's viewed
            }
            // Highlight the new topic in the list (loadTopicList should handle this due to currentTopicId being set)
            await displayTopicTimestampBubble(itemId, itemType, currentTopicId);
            messageInput.focus();
        } else {
            uiHelperFunctions.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
        }
    } catch (error) {
        console.error(`创建新话题时出错:`, error);
        uiHelperFunctions.showToastNotification(`创建新话题时出错: ${error.message}`, 'error');
    }
}
 
let markedInstance;
if (window.marked && typeof window.marked.Marked === 'function') { // Ensure Marked is a constructor
    try {
        markedInstance = new window.marked.Marked({
            sanitize: false, 
            gfm: true,
            breaks: true
        });
        // Optional: Add custom processing like quote spans if needed
    } catch (err) {
        console.warn("Failed to initialize marked, using basic fallback.", err);
        markedInstance = { parse: (text) => `<p>${String(text || '').replace(/\n/g, '<br>')}</p>` };
    }
} else {
    console.warn("Marked library not found or not in expected format, Markdown rendering will be basic.");
    markedInstance = { parse: (text) => `<p>${String(text || '').replace(/\n/g, '<br>')}</p>` };
}
 
window.addEventListener('contextmenu', (e) => {
    // Allow context menu for text input fields
    if (e.target.closest('textarea, input[type="text"], .message-item .md-content')) { // Also allow on rendered message content
        // Standard context menu will appear
    } else {
        // e.preventDefault(); // Optionally prevent context menu elsewhere
    }
}, false);
 
function setupTitleBarControls() {
    if (minimizeBtn) minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
    if (maximizeBtn) maximizeBtn.addEventListener('click', () => window.electronAPI.maximizeWindow());
    if (restoreBtn) restoreBtn.addEventListener('click', () => window.electronAPI.unmaximizeWindow());
    if (closeBtn) closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());
    if (settingsBtn) settingsBtn.addEventListener('click', () => window.electronAPI.openDevTools()); // DevTools button

    if (window.electronAPI && typeof window.electronAPI.onWindowMaximized === 'function') {
        window.electronAPI.onWindowMaximized(() => {
            if (maximizeBtn) maximizeBtn.style.display = 'none';
            if (restoreBtn) restoreBtn.style.display = 'flex';
        });
    }
    if (window.electronAPI && typeof window.electronAPI.onWindowUnmaximized === 'function') {
        window.electronAPI.onWindowUnmaximized(() => {
            if (maximizeBtn) maximizeBtn.style.display = 'flex';
            if (restoreBtn) restoreBtn.style.display = 'none';
        });
    }
}

async function handleCreateBranch(selectedMessage) { // Only for Agents
    if (currentSelectedItem.type !== 'agent' || !currentSelectedItem.id || !currentTopicId || !selectedMessage) {
        uiHelperFunctions.showToastNotification("无法创建分支：当前非Agent聊天或缺少必要信息。", 'error');
        return;
    }

    const messageId = selectedMessage.id;
    const messageIndex = currentChatHistory.findIndex(msg => msg.id === messageId);

    if (messageIndex === -1) {
        uiHelperFunctions.showToastNotification("无法创建分支：在当前聊天记录中未找到选定消息。", 'error');
        return;
    }

    const historyForNewBranch = currentChatHistory.slice(0, messageIndex + 1);
    if (historyForNewBranch.length === 0) {
        uiHelperFunctions.showToastNotification("无法创建分支：没有可用于创建分支的消息。", 'error');
        return;
    }

    try {
        const agentConfig = await window.electronAPI.getAgentConfig(currentSelectedItem.id);
        if (!agentConfig || agentConfig.error) {
            uiHelperFunctions.showToastNotification(`创建分支失败：无法获取助手配置。 ${agentConfig?.error || ''}`, 'error');
            return;
        }
        const originalTopic = agentConfig.topics.find(t => t.id === currentTopicId);
        const originalTopicName = originalTopic ? originalTopic.name : "未命名话题";
        const newBranchTopicName = `${originalTopicName} (分支)`;

        const createResult = await window.electronAPI.createNewTopicForAgent(currentSelectedItem.id, newBranchTopicName, true); // true to refresh timestamp

        if (!createResult || !createResult.success || !createResult.topicId) {
            uiHelperFunctions.showToastNotification(`创建分支话题失败: ${createResult ? createResult.error : '未知错误'}`, 'error');
            return;
        }

        const newTopicId = createResult.topicId;
        const saveResult = await window.electronAPI.saveChatHistory(currentSelectedItem.id, newTopicId, historyForNewBranch);
        if (!saveResult || !saveResult.success) {
            uiHelperFunctions.showToastNotification(`无法将历史记录保存到新的分支话题: ${saveResult ? saveResult.error : '未知错误'}`, 'error');
            await window.electronAPI.deleteTopic(currentSelectedItem.id, newTopicId); // Clean up empty branch topic
            return;
        }

        currentTopicId = newTopicId; // Switch to the new branch topic
        if (window.messageRenderer) window.messageRenderer.setCurrentTopicId(currentTopicId);
        
        if (document.getElementById('tabContentTopics').classList.contains('active')) {
            await loadTopicList(); // Refresh topic list UI
        }
        await loadChatHistory(currentSelectedItem.id, 'agent', currentTopicId); // Load history for the new branch
        localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_agent`, currentTopicId);

        uiHelperFunctions.showToastNotification(`已成功创建分支话题 "${newBranchTopicName}" 并切换。`);
        messageInput.focus();

    } catch (error) {
        console.error("创建分支时发生错误:", error);
        uiHelperFunctions.showToastNotification(`创建分支时发生内部错误: ${error.message}`, 'error');
    }
}

// Helper to get a centrally stored cropped file (agent, group, or user)
function getCroppedFile(type) {
    if (type === 'agent') return croppedAgentAvatarFile;
    if (type === 'group') return croppedGroupAvatarFile;
    if (type === 'user') return croppedUserAvatarFile;
    return null;
}

// Helper to set a centrally stored cropped file
function setCroppedFile(type, file) {
    if (type === 'agent') croppedAgentAvatarFile = file;
    else if (type === 'group') croppedGroupAvatarFile = file;
    else if (type === 'user') croppedUserAvatarFile = file;
}

// Function to extract average color from an avatar image
function getAverageColorFromAvatar(imageUrl, callback) {
    const img = new Image();
    img.crossOrigin = "Anonymous"; // Important for local file URLs if issues arise, though usually okay for file://
    img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0, img.width, img.height);
        try {
            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            const data = imageData.data;
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 4) {
                // Consider only non-transparent pixels and somewhat opaque
                if (data[i + 3] > 128) { 
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    count++;
                }
            }
            if (count > 0) {
                r = Math.floor(r / count);
                g = Math.floor(g / count);
                b = Math.floor(b / count);
                callback(`rgb(${r},${g},${b})`);
            } else {
                callback(null); // All transparent or no pixels
            }
        } catch (e) {
            console.error("Error getting image data (possibly CORS or security issue for remote images):", e);
            callback(null);
        }
    };
    img.onerror = () => {
        console.error("Failed to load image for color extraction:", imageUrl);
        callback(null);
    };
    img.src = imageUrl;
}

