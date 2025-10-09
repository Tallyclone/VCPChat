// modules/chatManager.js

window.chatManager = (() => {
    // --- Private Variables ---
    let electronAPI;
    let uiHelper;
    let messageRenderer;
    let itemListManager;
    let topicListManager;
    let groupRenderer;

    // References to state in renderer.js
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let currentChatHistoryRef;
    let attachedFilesRef;
    let globalSettingsRef;

    // DOM Elements from renderer.js
    let elements = {};
    
    // Functions from main renderer
    let mainRendererFunctions = {};
    let isCanvasWindowOpen = false; // State to track if the canvas window is open



    /**
     * 应用单个正则规则到文本
     * @param {string} text - 输入文本
     * @param {Object} rule - 正则规则对象
     * @returns {string} 处理后的文本
     */
    function applyRegexRule(text, rule) {
        if (!rule || !rule.findPattern || typeof text !== 'string') {
            return text;
        }

        try {
            // 使用 uiHelperFunctions.regexFromString 来解析正则表达式
            let regex = null;
            if (window.uiHelperFunctions && window.uiHelperFunctions.regexFromString) {
                regex = window.uiHelperFunctions.regexFromString(rule.findPattern);
            } else {
                // 后备方案：手动解析
                const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
                if (regexMatch) {
                    regex = new RegExp(regexMatch[1], regexMatch[2]);
                } else {
                    regex = new RegExp(rule.findPattern, 'g');
                }
            }
            
            if (!regex) {
                console.error('无法解析正则表达式:', rule.findPattern);
                return text;
            }
            
            // 应用替换（如果没有替换内容，则默认替换为空字符串）
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错:', rule.findPattern, error);
            return text;
        }
    }

    /**
     * 应用所有匹配的正则规则到文本
     * @param {string} text - 输入文本
     * @param {Array} rules - 正则规则数组
     * @param {string} scope - 作用域 ('frontend' 或 'context')
     * @param {string} role - 消息角色 ('user' 或 'assistant')
     * @param {number} depth - 消息深度（0 = 最新消息）
     * @returns {string} 处理后的文本
     */
    function applyRegexRules(text, rules, scope, role, depth = 0) {
        if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
            return text;
        }

        let processedText = text;
        
        rules.forEach(rule => {
            // 检查是否应该应用此规则
            
            // 1. 检查作用域
            const shouldApplyToScope =
                (scope === 'context' && rule.applyToContext) ||
                (scope === 'frontend' && rule.applyToFrontend);
            
            if (!shouldApplyToScope) return;
            
            // 2. 检查角色
            const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
            if (!shouldApplyToRole) return;
            
            // 3. 检查深度（-1 表示无限制）
            const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
            const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
            
            if (!minDepthOk || !maxDepthOk) return;
            
            // 应用规则
            processedText = applyRegexRule(processedText, rule);
        });
        
        return processedText;
    }

    /**
     * Initializes the ChatManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        electronAPI = config.electronAPI;
        uiHelper = config.uiHelper;
        
        // Modules
        messageRenderer = config.modules.messageRenderer;
        itemListManager = config.modules.itemListManager;
        topicListManager = config.modules.topicListManager;
        groupRenderer = config.modules.groupRenderer;

        // State References
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        currentTopicIdRef = config.refs.currentTopicIdRef;
        currentChatHistoryRef = config.refs.currentChatHistoryRef;
        attachedFilesRef = config.refs.attachedFilesRef;
        globalSettingsRef = config.refs.globalSettingsRef;

        // DOM Elements
        elements = config.elements;
        
        // Main Renderer Functions
        mainRendererFunctions = config.mainRendererFunctions;

        console.log('[ChatManager] Initialized successfully.');

        // Listen for Canvas events
        if (electronAPI) {
            electronAPI.onCanvasContentUpdate(handleCanvasContentUpdate);
            electronAPI.onCanvasWindowClosed(handleCanvasWindowClosed);
        }
    }

    // --- Functions moved from renderer.js ---

    function displayNoItemSelected() {
        const { currentChatNameH3, chatMessagesDiv, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        const voiceChatBtn = document.getElementById('voiceChatBtn');
        currentChatNameH3.textContent = '选择一个 Agent 或群组开始聊天';
        chatMessagesDiv.innerHTML = `<div class="message-item system welcome-bubble"><p>欢迎！请从左侧选择AI助手/群组，或创建新的开始对话。</p></div>`;
        currentItemActionBtn.style.display = 'none';
        if (voiceChatBtn) voiceChatBtn.style.display = 'none';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        attachFileBtn.disabled = true;
        if (mainRendererFunctions.displaySettingsForItem) {
            mainRendererFunctions.displaySettingsForItem(); 
        }
        if (topicListManager) topicListManager.loadTopicList();
    }

    async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) {
        // Stop any previous watcher when switching items
        if (electronAPI.watcherStop) {
            await electronAPI.watcherStop();
        }

        const { currentChatNameH3, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        let currentSelectedItem = currentSelectedItemRef.get();
        let currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem.id === itemId && currentSelectedItem.type === itemType && currentTopicId) {
            console.log(`Item ${itemType} ${itemId} already selected with topic ${currentTopicId}. No change.`);
            return;
        }

        currentSelectedItem = { id: itemId, type: itemType, name: itemName, avatarUrl: itemAvatarUrl, config: itemFullConfig };
        currentSelectedItemRef.set(currentSelectedItem);
        currentTopicIdRef.set(null); // Reset topic
        currentChatHistoryRef.set([]);

        document.querySelectorAll('.topic-list .topic-item.active-topic-glowing').forEach(item => {
            item.classList.remove('active-topic-glowing');
        });

        if (messageRenderer) {
            messageRenderer.setCurrentSelectedItem(currentSelectedItem);
            messageRenderer.setCurrentTopicId(null);
            messageRenderer.setCurrentItemAvatar(itemAvatarUrl);
            messageRenderer.setCurrentItemAvatarColor(itemFullConfig?.avatarCalculatedColor || null);
        }

        if (itemType === 'group' && groupRenderer && typeof groupRenderer.handleSelectGroup === 'function') {
            await groupRenderer.handleSelectGroup(itemId, itemName, itemAvatarUrl, itemFullConfig);
        } else if (itemType === 'agent') {
            if (groupRenderer && typeof groupRenderer.clearInviteAgentButtons === 'function') {
                groupRenderer.clearInviteAgentButtons();
            }
        }
     
        const voiceChatBtn = document.getElementById('voiceChatBtn');

        currentChatNameH3.textContent = `与 ${itemName} ${itemType === 'group' ? '(群组)' : ''} 聊天中`;
        currentItemActionBtn.textContent = itemType === 'group' ? '新建群聊话题' : '新建聊天话题';
        currentItemActionBtn.title = `为 ${itemName} 新建${itemType === 'group' ? '群聊话题' : '聊天话题'}`;
        currentItemActionBtn.style.display = 'inline-block';
        
        if (voiceChatBtn) {
            voiceChatBtn.style.display = itemType === 'agent' ? 'inline-block' : 'none';
        }

        itemListManager.highlightActiveItem(itemId, itemType);
        if(mainRendererFunctions.displaySettingsForItem) mainRendererFunctions.displaySettingsForItem();

        try {
            let topics;
            if (itemType === 'agent') {
                topics = await electronAPI.getAgentTopics(itemId);
            } else if (itemType === 'group') {
                topics = await electronAPI.getGroupTopics(itemId);
            }

            if (topics && !topics.error && topics.length > 0) {
                let topicToLoadId = topics[0].id;
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${itemId}_${itemType}`);
                if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
                currentTopicIdRef.set(topicToLoadId);
                if (messageRenderer) messageRenderer.setCurrentTopicId(topicToLoadId);
                await loadChatHistory(itemId, itemType, topicToLoadId);
            } else if (topics && topics.error) {
                console.error(`加载 ${itemType} ${itemId} 的话题列表失败:`, topics.error);
                if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
                await loadChatHistory(itemId, itemType, null);
            } else {
                if (itemType === 'agent') {
                    const agentConfig = await electronAPI.getAgentConfig(itemId);
                    if (agentConfig && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                        const defaultTopicResult = await electronAPI.createNewTopicForAgent(itemId, "主要对话");
                        if (defaultTopicResult.success) {
                            currentTopicIdRef.set(defaultTopicResult.topicId);
                            if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                            await loadChatHistory(itemId, itemType, defaultTopicResult.topicId);
                        } else {
                            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                            await loadChatHistory(itemId, itemType, null);
                        }
                    } else {
                         await loadChatHistory(itemId, itemType, null);
                    }
                } else if (itemType === 'group') {
                    const defaultTopicResult = await electronAPI.createNewTopicForGroup(itemId, "主要群聊");
                    if (defaultTopicResult.success) {
                        currentTopicIdRef.set(defaultTopicResult.topicId);
                        if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                        await loadChatHistory(itemId, itemType, defaultTopicResult.topicId);
                    } else {
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认群聊话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                        await loadChatHistory(itemId, itemType, null);
                    }
                }
            }
        } catch (e) {
            console.error(`选择 ${itemType} ${itemId} 时发生错误: `, e);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `选择${itemType === 'group' ? '群组' : '助手'}时出错: ${e.message}`, timestamp: Date.now() });
        }

        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        attachFileBtn.disabled = false;
        // messageInput.focus();
        if (topicListManager) topicListManager.loadTopicList();
    }

    async function selectTopic(topicId) {
        let currentTopicId = currentTopicIdRef.get();
        if (currentTopicId !== topicId) {
            currentTopicIdRef.set(topicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);
            
            const currentSelectedItem = currentSelectedItemRef.get();
            
            // Explicitly start watcher for the new topic
            const agentConfigForWatcher = currentSelectedItem.config || currentSelectedItem;
            if (electronAPI.watcherStart && agentConfigForWatcher?.agentDataPath) {
                const historyFilePath = `${agentConfigForWatcher.agentDataPath}\\topics\\${topicId}\\history.json`;
                await electronAPI.watcherStart(historyFilePath, currentSelectedItem.id, topicId);
            }

            document.querySelectorAll('#topicList .topic-item').forEach(item => {
                const isClickedItem = item.dataset.topicId === topicId && item.dataset.itemId === currentSelectedItem.id;
                item.classList.toggle('active', isClickedItem);
                item.classList.toggle('active-topic-glowing', isClickedItem);
            });
            await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, topicId);
            localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_${currentSelectedItem.type}`, topicId);
        }
    }

    async function handleTopicDeletion(remainingTopics) {
        let currentSelectedItem = currentSelectedItemRef.get();
        const config = currentSelectedItem.config || currentSelectedItem;
        config.topics = remainingTopics;
        currentSelectedItemRef.set(currentSelectedItem);

        if (remainingTopics && remainingTopics.length > 0) {
            const newSelectedTopic = remainingTopics.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
            await selectItem(currentSelectedItem.id, currentSelectedItem.type, currentSelectedItem.name, currentSelectedItem.avatarUrl, (currentSelectedItem.config || currentSelectedItem));
            await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, newSelectedTopic.id);
            currentTopicIdRef.set(newSelectedTopic.id);
            if (messageRenderer) messageRenderer.setCurrentTopicId(newSelectedTopic.id);
        } else {
            currentTopicIdRef.set(null);
            if (messageRenderer) {
                messageRenderer.setCurrentTopicId(null);
                messageRenderer.clearChat();
                messageRenderer.renderMessage({ role: 'system', content: '所有话题均已删除。请创建一个新话题。', timestamp: Date.now() });
            }
            await displayTopicTimestampBubble(currentSelectedItem.id, currentSelectedItem.type, null);
        }
    }

    async function loadChatHistory(itemId, itemType, topicId) {
        if (messageRenderer) messageRenderer.clearChat();
        currentChatHistoryRef.set([]);
    
    
        document.querySelectorAll('.topic-list .topic-item').forEach(item => {
            const isCurrent = item.dataset.topicId === topicId && item.dataset.itemId === itemId && item.dataset.itemType === itemType;
            item.classList.toggle('active', isCurrent);
            item.classList.toggle('active-topic-glowing', isCurrent);
        });
    
        if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);
    
        if (!itemId) {
            const errorMsg = `错误：无法加载聊天记录，${itemType === 'group' ? '群组' : '助手'}ID (${itemId}) 缺失。`;
            console.error(errorMsg);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: errorMsg, timestamp: Date.now() });
            await displayTopicTimestampBubble(null, null, null);
            return;
        }
    
        if (!topicId) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: '请选择或创建一个话题以开始聊天。', timestamp: Date.now() });
            await displayTopicTimestampBubble(itemId, itemType, null);
            return;
        }
    
        // 核心修改：使用 await 确保加载消息被渲染
        if (messageRenderer) {
            await messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });
        }
    
        let historyResult;
        if (itemType === 'agent') {
            historyResult = await electronAPI.getChatHistory(itemId, topicId);
        } else if (itemType === 'group') {
            historyResult = await electronAPI.getGroupChatHistory(itemId, topicId);
        }
    
        const currentSelectedItem = currentSelectedItemRef.get();
        const agentConfigForHistory = currentSelectedItem.config || currentSelectedItem;
        if (electronAPI.watcherStart && agentConfigForHistory?.agentDataPath) {
            const historyFilePath = `${agentConfigForHistory.agentDataPath}\\topics\\${topicId}\\history.json`;
            await electronAPI.watcherStart(historyFilePath, itemId, topicId);
        }
    
        if (messageRenderer) messageRenderer.removeMessageById('loading_history');
    
        await displayTopicTimestampBubble(itemId, itemType, topicId);
    
        if (historyResult && historyResult.error) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录失败: ${historyResult.error}`, timestamp: Date.now() });
        } else if (historyResult && historyResult.length > 0) {
            console.log(`[LoadHistory] 从文件加载了 ${historyResult.length} 条历史消息`);
            if (historyResult.length > 0) {
                console.log(`[LoadHistory] 历史消息详情:`);
                historyResult.forEach((msg, index) => {
                    console.log(`  ${index + 1}. [${msg.role}] ${msg.name || '未命名'}: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? '...' : ''}`);
                });
            }

            currentChatHistoryRef.set(historyResult);
            if (messageRenderer) {
                // 使用优化的分批渲染策略
                const renderOptions = {
                    initialBatch: 5,    // 首先显示最新的5条消息
                    batchSize: 10,      // 后续每批10条消息
                    batchDelay: 80      // 批次间延迟80ms，平衡性能和用户体验
                };

                console.log(`[ChatManager] 开始渲染话题历史，共 ${historyResult.length} 条消息`);
                await messageRenderer.renderHistory(historyResult, renderOptions);
                console.log(`[ChatManager] 话题历史渲染完成`);
            }
    
        } else if (historyResult) { // History is empty
            currentChatHistoryRef.set([]);
        } else {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录时返回了无效数据。`, timestamp: Date.now() });
        }
    
        if (itemId && topicId && !(historyResult && historyResult.error)) {
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, topicId);
        }
    }

    async function displayTopicTimestampBubble(itemId, itemType, topicId) {
        const { chatMessagesDiv } = elements;
        const chatMessagesContainer = document.querySelector('.chat-messages-container');

        if (!chatMessagesDiv || !chatMessagesContainer) {
            console.warn('[displayTopicTimestampBubble] Missing chatMessagesDiv or chatMessagesContainer.');
            const existingBubble = document.getElementById('topicTimestampBubble');
            if (existingBubble) existingBubble.style.display = 'none';
            return;
        }

        let timestampBubble = document.getElementById('topicTimestampBubble');
        if (!timestampBubble) {
            timestampBubble = document.createElement('div');
            timestampBubble.id = 'topicTimestampBubble';
            timestampBubble.className = 'topic-timestamp-bubble';
            if (chatMessagesDiv.firstChild) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            } else {
                chatMessagesDiv.appendChild(timestampBubble);
            }
        } else {
            if (chatMessagesDiv.firstChild !== timestampBubble) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            }
        }

        if (!itemId || !topicId) {
            timestampBubble.style.display = 'none';
            return;
        }

        try {
            let itemConfigFull;
            if (itemType === 'agent') {
                itemConfigFull = await electronAPI.getAgentConfig(itemId);
            } else if (itemType === 'group') {
                itemConfigFull = await electronAPI.getAgentGroupConfig(itemId);
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
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem.type !== 'agent' || currentChatHistory.length < 4 || !currentTopicId) return;

        try {
            // 强制从文件系统重新加载最新的配置，确保标题检查的准确性
            const agentConfigForSummary = await electronAPI.getAgentConfig(currentSelectedItem.id);
            if (!agentConfigForSummary || agentConfigForSummary.error) {
                console.error('[TopicSummary] Failed to get fresh agent config for summarization:', agentConfigForSummary?.error);
                return;
            }
            // 使用最新的配置更新内存中的状态，以保持同步
            if (currentSelectedItem.config) {
                currentSelectedItem.config = agentConfigForSummary;
            } else {
                Object.assign(currentSelectedItem, agentConfigForSummary);
            }
            currentSelectedItemRef.set(currentSelectedItem);

            const topics = agentConfigForSummary.topics || [];
            const currentTopicObject = topics.find(t => t.id === currentTopicId);
            const existingTopicTitle = currentTopicObject ? currentTopicObject.name : "主要对话";
            const currentAgentName = agentConfigForSummary.name || 'AI';

            if (existingTopicTitle === "主要对话" || existingTopicTitle.startsWith("新话题")) {
                if (messageRenderer && typeof messageRenderer.summarizeTopicFromMessages === 'function') {
                    const summarizedTitle = await messageRenderer.summarizeTopicFromMessages(currentChatHistory.filter(m => !m.isThinking), currentAgentName);
                    if (summarizedTitle) {
                        const saveResult = await electronAPI.saveAgentTopicTitle(currentSelectedItem.id, currentTopicId, summarizedTitle);
                        if (saveResult.success) {
                            // 标题已保存到文件，现在更新内存中的对象以立即反映更改
                            if (currentTopicObject) {
                                currentTopicObject.name = summarizedTitle;
                            }
                            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                                if (topicListManager) topicListManager.loadTopicList();
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
        const { messageInput } = elements;
        let content = messageInput.value.trim(); // Use let as it might be modified
        const attachedFiles = attachedFilesRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();

        if (!content && attachedFiles.length === 0) return;
        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelper.showToastNotification('请先选择一个项目和话题！', 'error');
            return;
        }
        if (!globalSettings.vcpServerUrl) {
            uiHelper.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
            uiHelper.openModal('globalSettingsModal');
            return;
        }

        if (currentSelectedItem.type === 'group') {
            if (groupRenderer && typeof groupRenderer.handleSendGroupMessage === 'function') {
                groupRenderer.handleSendGroupMessage(
                    currentSelectedItem.id,
                    currentTopicId,
                    { text: content, attachments: attachedFiles.map(af => ({ type: af.file.type, src: af.localPath, name: af.originalName, size: af.file.size })) },
                    globalSettings.userName || '用户'
                );
            } else {
                uiHelper.showToastNotification("群聊功能模块未加载，无法发送消息。", 'error');
            }
            messageInput.value = '';
            attachedFilesRef.set([]);
            if(mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
            uiHelper.autoResizeTextarea(messageInput);
            // messageInput.focus();
            return;
        }

        // --- Standard Agent Message Sending ---
        // The 'content' variable still holds the user's raw input, including the placeholder.
        // We will resolve the placeholder later, only for the final message sent to VCP.
        let combinedTextContent = content; // 用于发送给VCP的组合文本内容
 
        const uiAttachments = [];
        if (attachedFiles.length > 0) {
            for (const af of attachedFiles) {
                const fileManagerData = af._fileManagerData || {};
                uiAttachments.push({
                    type: fileManagerData.type,
                    src: af.localPath,
                    name: af.originalName,
                    size: af.file.size,
                    _fileManagerData: fileManagerData
                });

                // 修正：将文件路径和提取的文本正确地附加到 combinedTextContent
                const filePathForContext = af.localPath || af.originalName;

                if (af.file.type.startsWith('image/')) {
                    // 对于图片，我们只附加路径，因为内容将作为多模态部分发送
                    combinedTextContent += `\n\n[附加图片: ${filePathForContext}]`;
                } else if (fileManagerData.extractedText) {
                    // 对于有提取文本的文件，同时附加路径和文本
                    combinedTextContent += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${af.originalName}]`;
                } else {
                    // 对于其他文件（如音频、视频、无文本的PDF等），只附加路径
                    combinedTextContent += `\n\n[附加文件: ${filePathForContext}]`;
                }
            }
        }

        const userMessage = {
            role: 'user',
            name: globalSettings.userName || '用户',
            content: content, // Use raw content for UI
            timestamp: Date.now(),
            id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
            attachments: uiAttachments
        };
        
        if (messageRenderer) {
            await messageRenderer.renderMessage(userMessage);
        }
        // Manually update history after rendering
        const currentChatHistory = currentChatHistoryRef.get();
        currentChatHistory.push(userMessage);
        currentChatHistoryRef.set(currentChatHistory);

        // Save history with the user message before adding the thinking message or making API calls
        await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory);

        messageInput.value = '';
        attachedFilesRef.set([]);
        if(mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
        
        // After sending, if the canvas window is still open, restore the placeholder
        if (isCanvasWindowOpen) {
            messageInput.value = CANVAS_PLACEHOLDER;
        }
        uiHelper.autoResizeTextarea(messageInput);
        // messageInput.focus(); // 核心修正：注释掉此行。这是导致AI流式输出时，即使向上滚动也会被强制拉回底部的根源。

        const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI', // 修复：使用 ID 作为更可靠的回退
            content: '思考中...',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };

        let thinkingMessageItem = null;
        if (messageRenderer) {
            thinkingMessageItem = await messageRenderer.renderMessage(thinkingMessage);
        }
        // Manually update history with the thinking message
        const currentChatHistoryWithThinking = currentChatHistoryRef.get();
        currentChatHistoryWithThinking.push(thinkingMessage);
        currentChatHistoryRef.set(currentChatHistoryWithThinking);

        try {
            const agentConfig = currentSelectedItem.config || currentSelectedItem;

            // 🔧 关键修复：确保从文件中获取最新的历史记录，包含预制消息
            console.log(`[SendMessage] 准备发送消息，当前话题: ${currentTopicId}`);

            // 优先从内存获取历史记录
            let currentChatHistory = currentChatHistoryRef.get();

            // 如果内存历史记录为空或不完整，从文件重新加载
            if (!currentChatHistory || currentChatHistory.length === 0) {
                console.log(`[SendMessage] 内存历史记录为空，尝试从文件重新加载...`);
                const fileHistory = await electronAPI.getChatHistory(currentSelectedItem.id, currentTopicId);
                if (fileHistory && !fileHistory.error) {
                    currentChatHistory = fileHistory;
                    currentChatHistoryRef.set(currentChatHistory);
                    console.log(`[SendMessage] 从文件加载了 ${currentChatHistory.length} 条历史消息`);
                } else {
                    console.warn(`[SendMessage] 文件历史记录也为空或读取失败`);
                    currentChatHistory = [];
                }
            } else {
                console.log(`[SendMessage] 使用内存中的 ${currentChatHistory.length} 条历史消息`);
            }

            const historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);

            const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
                let vcpImageAttachmentsPayload = [];
                let vcpAudioAttachmentsPayload = [];
                let vcpVideoAttachmentsPayload = [];
                let currentMessageTextContent = msg.content;

                // --- 应用正则规则（后端/上下文）---
                if (agentConfig?.stripRegexes && Array.isArray(agentConfig.stripRegexes) && agentConfig.stripRegexes.length > 0) {
                    // --- 按“对话轮次”计算深度 ---
                    const turns = [];
                    for (let i = historySnapshotForVCP.length - 1; i >= 0; i--) {
                        if (historySnapshotForVCP[i].role === 'assistant') {
                            const turn = { assistant: historySnapshotForVCP[i], user: null };
                            if (i > 0 && historySnapshotForVCP[i - 1].role === 'user') {
                                turn.user = historySnapshotForVCP[i - 1];
                                i--; // 跳过用户消息，因为已经配对
                            }
                            turns.unshift(turn);
                        } else if (historySnapshotForVCP[i].role === 'user') {
                            // 处理末尾的单个用户消息
                            turns.unshift({ assistant: null, user: historySnapshotForVCP[i] });
                        }
                    }
                    
                    // 找到当前消息所在的轮次
                    const turnIndex = turns.findIndex(t => (t.assistant && t.assistant.id === msg.id) || (t.user && t.user.id === msg.id));
                    const depth = turnIndex !== -1 ? (turns.length - 1 - turnIndex) : -1;

                    if (depth !== -1) {
                        // 应用规则到消息内容
                        currentMessageTextContent = applyRegexRules(
                            currentMessageTextContent,
                            agentConfig.stripRegexes,
                            'context',  // 这里处理的是发送给AI的上下文
                            msg.role,
                            depth
                        );
                    }
                    // --- 深度计算和应用结束 ---
                }
                // --- 正则规则应用结束 ---

                if (msg.role === 'user' && msg.id === userMessage.id) {
                    // 关键修复：使用已经包含附件内容的 combinedTextContent
                    currentMessageTextContent = combinedTextContent;
                    
                    // IMPORTANT: We need to handle Canvas placeholder WITHOUT overwriting the combined content
                    // First, check if we need to replace Canvas placeholder
                    if (currentMessageTextContent.includes(CANVAS_PLACEHOLDER)) {
                        try {
                            const canvasData = await electronAPI.getLatestCanvasContent();
                            if (canvasData && !canvasData.error) {
                                const formattedCanvasContent = `\n[Canvas Content]\n${canvasData.content || ''}\n[Canvas Path]\n${canvasData.path || 'No file path'}\n[Canvas Errors]\n${canvasData.errors || 'No errors'}\n`;
                                // Replace Canvas placeholder in the combined content
                                currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), formattedCanvasContent);
                            } else {
                                console.error("Failed to get latest canvas content:", canvasData?.error);
                                currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), '\n[Canvas content could not be loaded]\n');
                            }
                        } catch (error) {
                            console.error("Error fetching canvas content:", error);
                            currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), '\n[Error loading canvas content]\n');
                        }
                    }
                } else if (msg.attachments && msg.attachments.length > 0) {
                    let historicalAppendedText = "";
                    for (const att of msg.attachments) {
                        const fileManagerData = att._fileManagerData || {};
                        // 优先使用 att.src，因为它代表前端的本地可访问路径
                        // 后备到 internalPath（来自 fileManager），最后才是文件名
                        const filePathForContext = att.src || (fileManagerData.internalPath ? fileManagerData.internalPath.replace('file://', '') : (att.name || '未知文件'));

                        if (fileManagerData.imageFrames && fileManagerData.imageFrames.length > 0) {
                             historicalAppendedText += `\n\n[附加文件: ${filePathForContext} (扫描版PDF，已转换为图片)]`;
                        } else if (fileManagerData.extractedText) {
                            historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${att.name || '未知文件'}]`;
                        } else {
                            // 对于没有提取文本的文件（如音视频），只附加路径
                            historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]`;
                        }
                    }
                    currentMessageTextContent += historicalAppendedText;
                }

                if (msg.attachments && msg.attachments.length > 0) {
                    // --- IMAGE PROCESSING ---
                    const imageAttachmentsPromises = msg.attachments.map(async att => {
                        const fileManagerData = att._fileManagerData || {};
                        // Case 1: Scanned PDF converted to image frames
                        if (fileManagerData.imageFrames && fileManagerData.imageFrames.length > 0) {
                            return fileManagerData.imageFrames.map(frameData => ({
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${frameData}` }
                            }));
                        }
                        // Case 2: Regular image file (including GIFs that get framed)
                        if (att.type.startsWith('image/')) {
                            try {
                                const result = await electronAPI.getFileAsBase64(att.src);
                                if (result && result.success) {
                                    return result.base64Frames.map(frameData => ({
                                        type: 'image_url',
                                        image_url: { url: `data:image/jpeg;base64,${frameData}` }
                                    }));
                                } else {
                                    const errorMsg = result ? result.error : '未知错误';
                                    console.error(`Failed to get Base64 for ${att.name}: ${errorMsg}`);
                                    uiHelper.showToastNotification(`处理图片 ${att.name} 失败: ${errorMsg}`, 'error');
                                    return null;
                                }
                            } catch (processingError) {
                                console.error(`Exception during getBase64 for ${att.name}:`, processingError);
                                uiHelper.showToastNotification(`处理图片 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                                return null;
                            }
                        }
                        return null; // Not an image or a convertible PDF
                    });

                    const nestedImageAttachments = await Promise.all(imageAttachmentsPromises);
                    const flatImageAttachments = nestedImageAttachments.flat().filter(Boolean);
                    vcpImageAttachmentsPayload.push(...flatImageAttachments);

                    // --- AUDIO PROCESSING ---
                    const supportedAudioTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac'];
                    const audioAttachmentsPromises = msg.attachments
                        .filter(att => supportedAudioTypes.includes(att.type))
                        .map(async att => {
                            try {
                                const result = await electronAPI.getFileAsBase64(att.src);
                                if (result && result.success) {
                                    return result.base64Frames.map(frameData => ({
                                        type: 'image_url',
                                        image_url: { url: `data:${att.type};base64,${frameData}` }
                                    }));
                                } else {
                                    const errorMsg = result ? result.error : '未知错误';
                                    console.error(`Failed to get Base64 for audio ${att.name}: ${errorMsg}`);
                                    uiHelper.showToastNotification(`处理音频 ${att.name} 失败: ${errorMsg}`, 'error');
                                    return null;
                                }
                            } catch (processingError) {
                                console.error(`Exception during getBase64 for audio ${att.name}:`, processingError);
                                uiHelper.showToastNotification(`处理音频 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                                return null;
                            }
                        });
                    const nestedAudioAttachments = await Promise.all(audioAttachmentsPromises);
                    vcpAudioAttachmentsPayload.push(...nestedAudioAttachments.flat().filter(Boolean));

                    // --- VIDEO PROCESSING ---
                    const videoAttachmentsPromises = msg.attachments
                        .filter(att => att.type.startsWith('video/'))
                        .map(async att => {
                            try {
                                const result = await electronAPI.getFileAsBase64(att.src);
                                if (result && result.success) {
                                    return result.base64Frames.map(frameData => ({
                                        type: 'image_url',
                                        image_url: { url: `data:${att.type};base64,${frameData}` }
                                    }));
                                } else {
                                    const errorMsg = result ? result.error : '未知错误';
                                    console.error(`Failed to get Base64 for video ${att.name}: ${errorMsg}`);
                                    uiHelper.showToastNotification(`处理视频 ${att.name} 失败: ${errorMsg}`, 'error');
                                    return null;
                                }
                            } catch (processingError) {
                                console.error(`Exception during getBase64 for video ${att.name}:`, processingError);
                                uiHelper.showToastNotification(`处理视频 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                                return null;
                            }
                        });
                    const nestedVideoAttachments = await Promise.all(videoAttachmentsPromises);
                    vcpVideoAttachmentsPayload.push(...nestedVideoAttachments.flat().filter(Boolean));
                }

                let finalContentPartsForVCP = [];
                if (currentMessageTextContent && currentMessageTextContent.trim() !== '') {
                    finalContentPartsForVCP.push({ type: 'text', text: currentMessageTextContent });
                }
                finalContentPartsForVCP.push(...vcpImageAttachmentsPayload);
                finalContentPartsForVCP.push(...vcpAudioAttachmentsPayload);
                finalContentPartsForVCP.push(...vcpVideoAttachmentsPayload);

                if (finalContentPartsForVCP.length === 0 && msg.role === 'user') {
                     finalContentPartsForVCP.push({ type: 'text', text: '(用户发送了附件，但无文本或图片内容)' });
                }
                
                return { role: msg.role, content: finalContentPartsForVCP.length > 0 ? finalContentPartsForVCP : msg.content };
            }));

            if (agentConfig && agentConfig.systemPrompt) {
                let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentSelectedItem.id);
                const prependedContent = [];

                // 任务2: 注入聊天记录文件路径
                // 假设 agentConfig 对象中包含一个 agentDataPath 属性，该属性由主进程在加载代理配置时提供。
                if (agentConfig.agentDataPath && currentTopicId) {
                    // 修正：currentTopicId 本身就包含 "topic_" 前缀，无需重复添加
                    const historyPath = `${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`;
                    prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
                }

                // 任务1: 注入话题创建时间
                if (agentConfig.topics && currentTopicId) {
                    const currentTopicObj = agentConfig.topics.find(t => t.id === currentTopicId);
                    if (currentTopicObj && currentTopicObj.createdAt) {
                        const date = new Date(currentTopicObj.createdAt);
                        const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        prependedContent.push(`当前话题创建于: ${formattedDate}`);
                    }
                }

                if (prependedContent.length > 0) {
                    systemPromptContent = prependedContent.join('\n') + '\n\n' + systemPromptContent;
                }

                messagesForVCP.unshift({ role: 'system', content: systemPromptContent });
            }

            const useStreaming = (agentConfig && agentConfig.streamOutput !== undefined) ? (agentConfig.streamOutput === true || agentConfig.streamOutput === 'true') : true;
            const modelConfigForVCP = {
                model: (agentConfig && agentConfig.model) ? agentConfig.model : 'gemini-pro',
                temperature: (agentConfig && agentConfig.temperature !== undefined) ? parseFloat(agentConfig.temperature) : 0.7,
                ...(agentConfig && agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
                ...(agentConfig && agentConfig.top_p !== undefined && agentConfig.top_p !== null && { top_p: parseFloat(agentConfig.top_p) }),
                ...(agentConfig && agentConfig.top_k !== undefined && agentConfig.top_k !== null && { top_k: parseInt(agentConfig.top_k) }),
                stream: useStreaming
            };

            if (useStreaming) {
                if (messageRenderer) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    // Pass the created DOM element directly to avoid race conditions with querySelector
                    await messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" }, thinkingMessageItem);
                }
            }

            const context = {
                agentId: currentSelectedItem.id,
                agentName: currentSelectedItem.name || currentSelectedItem.id, // 修复：为单聊上下文添加 agentName，并使用 ID 作为回退
                topicId: currentTopicId,
                isGroupMessage: false
            };

            const vcpResponse = await electronAPI.sendToVCP(
                globalSettings.vcpServerUrl,
                globalSettings.vcpApiKey,
                messagesForVCP,
                modelConfigForVCP,
                thinkingMessage.id,
                false, // isGroupCall - legacy, will be ignored by new handler but kept for safety
                context // The new context object
            );

            if (!useStreaming) {
                const { response, context } = vcpResponse;
                const currentSelectedItem = currentSelectedItemRef.get();
                const currentTopicId = currentTopicIdRef.get();

                // Determine if the response is for the currently active chat
                const isForActiveChat = context && context.agentId === currentSelectedItem.id && context.topicId === currentTopicId;

                if (isForActiveChat) {
                    // If it's for the active chat, update the UI as usual
                    if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id);
                }

                if (response.error) {
                    if (isForActiveChat && messageRenderer) {
                        messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ChatManager] VCP Error for background message:`, response.error);
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: context.agentName || context.agentId || 'AI', // 修复：使用 context 中的 agentName 或 agentId 作为回退
                        avatarUrl: currentSelectedItem.avatarUrl, // This might be incorrect if user switched, but it's a minor UI detail for background saves.
                        avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`
                    };

                    // Fetch the correct history from the file, update it, and save it back.
                    console.log(`[LLM Response] 获取文件历史记录进行保存...`);
                    const historyForSave = await electronAPI.getChatHistory(context.agentId, context.topicId);
                    if (historyForSave && !historyForSave.error) {
                        console.log(`[LLM Response] 文件历史记录包含 ${historyForSave.length} 条消息`);

                        // 调试：显示前几条消息的内容
                        if (historyForSave.length > 0) {
                            console.log(`[LLM Response] 文件历史记录前3条消息:`);
                            historyForSave.slice(0, 3).forEach((msg, index) => {
                                console.log(`  ${index + 1}. [${msg.role}] ${msg.name}: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? '...' : ''}`);
                            });
                        }

                        // Remove any lingering 'thinking' message and add the new one
                        const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
                        console.log(`[LLM Response] 过滤后剩余 ${finalHistory.length} 条消息，准备添加新的助手消息`);

                        finalHistory.push(assistantMessage);
                        console.log(`[LLM Response] 添加助手消息后，总共 ${finalHistory.length} 条消息`);

                        // Save the final, complete history to the correct file
                        const saveResult = await electronAPI.saveChatHistory(context.agentId, context.topicId, finalHistory);
                        if (saveResult && saveResult.success) {
                            console.log(`[LLM Response] ✅ 成功保存回复消息到文件`);
                        } else {
                            console.error(`[LLM Response] ❌ 保存回复消息失败: ${saveResult?.error || '未知错误'}`);
                        }

                        if (isForActiveChat) {
                            // If it's the active chat, also update the UI and in-memory state
                            currentChatHistoryRef.set(finalHistory);
                            if (messageRenderer) messageRenderer.renderMessage(assistantMessage);
                            await attemptTopicSummarizationIfNeeded();
                        } else {
                            console.log(`[ChatManager] Saved non-streaming response for background chat: Agent ${context.agentId}, Topic ${context.topicId}`);
                        }
                    } else {
                         console.error(`[ChatManager] Failed to get history for background save:`, historyForSave.error);
                    }
                } else {
                    if (isForActiveChat && messageRenderer) {
                        messageRenderer.renderMessage({ role: 'system', content: 'VCP返回了未知格式的响应。', timestamp: Date.now() });
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                    console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                    if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id); // This will also remove from history
                    if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                    // No need to save again here as removeMessageById handles it if configured
                }
            }
        } catch (error) {
            console.error('发送消息或处理VCP响应时出错:', error);
            if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
            if(currentSelectedItem.id && currentTopicId) {
                await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistoryRef.get().filter(msg => !msg.isThinking));
            }
        }
    }

    async function createNewTopicForItem(itemId, itemType) {
        if (!itemId) {
            uiHelper.showToastNotification("请先选择一个项目。", 'error');
            return;
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        const itemName = currentSelectedItem.name || (itemType === 'group' ? "当前群组" : "当前助手");
        const newTopicName = `新话题 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

        try {
            let result;
            if (itemType === 'agent') {
                result = await electronAPI.createNewTopicForAgent(itemId, newTopicName);
            } else if (itemType === 'group') {
                result = await electronAPI.createNewTopicForGroup(itemId, newTopicName);
            }

            if (result && result.success && result.topicId) {
                currentTopicIdRef.set(result.topicId);
                currentChatHistoryRef.set([]);

                if (messageRenderer) {
                    messageRenderer.setCurrentTopicId(result.topicId);
                    messageRenderer.clearChat();
                    // messageRenderer.renderMessage({ role: 'system', content: `新话题 "${result.topicName}" 已开始。`, timestamp: Date.now() });
                }
                localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, result.topicId);

                if (document.getElementById('tabContentTopics').classList.contains('active')) {
                    if (topicListManager) await topicListManager.loadTopicList();
                }

                await displayTopicTimestampBubble(itemId, itemType, result.topicId);
                // elements.messageInput.focus();
            } else {
                uiHelper.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error(`创建新话题时出错:`, error);
            uiHelper.showToastNotification(`创建新话题时出错: ${error.message}`, 'error');
        }
    }

    /**
     * 创建带初始消息的新话题（真正的普通消息方式）
     * @param {string} agentId - Agent ID
     * @param {string} topicName - 话题名称
     * @param {Array} messages - 初始消息数组，就是普通的对话消息
     * @param {Object} options - 其他选项
     * @returns {Object} 创建结果
     */
    async function createNewTopicWithMessages(agentId, topicName, messages = [], options = {}) {
        try {
            // 1. 获取配置信息用于设置正确的消息名字
            const agentConfig = await electronAPI.getAgentConfig(agentId);
            const globalSettings = await electronAPI.loadSettings();

            // 2. 准备初始消息 - 就是普通的对话消息，和发送消息时完全一致
            const initialMessages = messages.map((msg, index) => {
                let messageName;

                // 根据消息角色确定名字（和发送消息时的逻辑完全一致）
                if (msg.role === 'assistant') {
                    messageName = msg.name || agentConfig?.name || agentId || 'AI助手';
                } else if (msg.role === 'system') {
                    messageName = msg.name || '系统';
                } else {
                    messageName = msg.name || globalSettings?.userName || '用户';
                }

                return {
                    role: msg.role || 'user',
                    name: messageName,
                    content: msg.content || '',
                    timestamp: Date.now() + index,
                    id: `msg_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 9)}`
                };
            });

            // 3. 调用主进程API，一步到位创建话题和初始消息
            if (electronAPI.createTopicWithInitialMessages) {
                const result = await electronAPI.createTopicWithInitialMessages(agentId, topicName, initialMessages);

                if (result && result.success && result.topicId) {
                    // 4. 如果需要自动跳转，使用标准的selectTopic流程（和普通话题完全一致）
                    if (options.autoSwitch !== false) {
                        await selectTopic(result.topicId);
                    }

                    return {
                        success: true,
                        topicId: result.topicId,
                        topicName: topicName,
                        messageCount: initialMessages.length
                    };
                } else {
                    return { success: false, error: result ? result.error : '创建话题失败' };
                }
            } else {
                // 回退方案：如果主进程不支持，直接创建话题然后保存初始消息
                const result = await electronAPI.createNewTopicForAgent(agentId, topicName);

                if (!result || !result.success || !result.topicId) {
                    return { success: false, error: result ? result.error : '创建话题失败' };
                }

                const topicId = result.topicId;

                // 保存初始消息（就是普通消息）
                if (initialMessages.length > 0) {
                    const saveResult = await electronAPI.saveChatHistory(agentId, topicId, initialMessages);
                    if (!saveResult || !saveResult.success) {
                        return { success: false, error: `保存初始消息失败: ${saveResult ? saveResult.error : '未知错误'}` };
                    }
                }

                // 如果需要自动跳转，使用标准流程
                if (options.autoSwitch !== false) {
                    await selectTopic(topicId);
                }

                return {
                    success: true,
                    topicId: topicId,
                    topicName: topicName,
                    messageCount: initialMessages.length
                };
            }

        } catch (error) {
            console.error('创建带初始消息的话题时出错:', error);
            return { success: false, error: error.message };
        }
    }


    async function handleCreateBranch(selectedMessage) {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentChatHistory = currentChatHistoryRef.get();
        const itemType = currentSelectedItem.type;

        if ((itemType !== 'agent' && itemType !== 'group') || !currentSelectedItem.id || !currentTopicId || !selectedMessage) {
            uiHelper.showToastNotification("无法创建分支：当前非Agent/群组聊天或缺少必要信息。", 'error');
            return;
        }

        const messageId = selectedMessage.id;
        const messageIndex = currentChatHistory.findIndex(msg => msg.id === messageId);

        if (messageIndex === -1) {
            uiHelper.showToastNotification("无法创建分支：在当前聊天记录中未找到选定消息。", 'error');
            return;
        }

        const historyForNewBranch = currentChatHistory.slice(0, messageIndex + 1);
        if (historyForNewBranch.length === 0) {
            uiHelper.showToastNotification("无法创建分支：没有可用于创建分支的消息。", 'error');
            return;
        }

        try {
            let itemConfig, originalTopic, createResult, saveResult;
            const itemId = currentSelectedItem.id;

            if (itemType === 'agent') {
                itemConfig = await electronAPI.getAgentConfig(itemId);
            } else { // group
                itemConfig = await electronAPI.getAgentGroupConfig(itemId);
            }

            if (!itemConfig || itemConfig.error) {
                uiHelper.showToastNotification(`创建分支失败：无法获取${itemType === 'agent' ? '助手' : '群组'}配置。 ${itemConfig?.error || ''}`, 'error');
                return;
            }

            originalTopic = itemConfig.topics.find(t => t.id === currentTopicId);
            const originalTopicName = originalTopic ? originalTopic.name : "未命名话题";
            const newBranchTopicName = `${originalTopicName} (分支)`;

            if (itemType === 'agent') {
                createResult = await electronAPI.createNewTopicForAgent(itemId, newBranchTopicName, true);
            } else { // group
                createResult = await electronAPI.createNewTopicForGroup(itemId, newBranchTopicName, true);
            }

            if (!createResult || !createResult.success || !createResult.topicId) {
                uiHelper.showToastNotification(`创建分支话题失败: ${createResult ? createResult.error : '未知错误'}`, 'error');
                return;
            }

            const newTopicId = createResult.topicId;

            if (itemType === 'agent') {
                saveResult = await electronAPI.saveChatHistory(itemId, newTopicId, historyForNewBranch);
            } else { // group
                saveResult = await electronAPI.saveGroupChatHistory(itemId, newTopicId, historyForNewBranch);
            }

            if (!saveResult || !saveResult.success) {
                uiHelper.showToastNotification(`无法将历史记录保存到新的分支话题: ${saveResult ? saveResult.error : '未知错误'}`, 'error');
                // Clean up empty branch topic
                if (itemType === 'agent') {
                    await electronAPI.deleteTopic(itemId, newTopicId);
                } else { // group
                    await electronAPI.deleteGroupTopic(itemId, newTopicId);
                }
                return;
            }

            currentTopicIdRef.set(newTopicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(newTopicId);
            
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                if (topicListManager) await topicListManager.loadTopicList();
            }
            await loadChatHistory(itemId, itemType, newTopicId);
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, newTopicId);

            uiHelper.showToastNotification(`已成功创建分支话题 "${newBranchTopicName}" 并切换。`);

        } catch (error) {
            console.error("创建分支时发生错误:", error);
            uiHelper.showToastNotification(`创建分支时发生内部错误: ${error.message}`, 'error');
        }
    }

    async function handleForwardMessage(target, content, attachments) {
        const { messageInput } = elements;
        
        // 1. Find the target item's full config to select it
        let targetItemFullConfig;
        if (target.type === 'agent') {
            targetItemFullConfig = await electronAPI.getAgentConfig(target.id);
        } else {
            targetItemFullConfig = await electronAPI.getAgentGroupConfig(target.id);
        }

        if (!targetItemFullConfig || targetItemFullConfig.error) {
            uiHelper.showToastNotification(`转发失败: 无法获取目标配置。`, 'error');
            return;
        }

        // 2. Select the item. This will automatically handle finding the last active topic or creating a new one.
        await selectItem(target.id, target.type, target.name, targetItemFullConfig.avatarUrl, targetItemFullConfig);

        // 3. After a brief delay to allow the UI to update from selectItem, populate and send.
        setTimeout(async () => {
            // 4. Populate the message input and attachments ref
            messageInput.value = content;
            
            const uiAttachments = attachments.map(att => ({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.src,
                originalName: att.name,
                _fileManagerData: att._fileManagerData || {}
            }));
            attachedFilesRef.set(uiAttachments);
            
            // Manually trigger attachment preview update
            if (mainRendererFunctions.updateAttachmentPreview) {
                mainRendererFunctions.updateAttachmentPreview();
            }
            
            // Manually trigger textarea resize
            uiHelper.autoResizeTextarea(messageInput);

            // 5. Call the standard send message handler to trigger the full AI response flow
            await handleSendMessage();

        }, 200); // 200ms delay seems reasonable for UI transition
    }

    // --- Canvas Integration ---
    const CANVAS_PLACEHOLDER = '{{VCPChatCanvas}}';

    function handleCanvasContentUpdate(data) {
        isCanvasWindowOpen = true;
        const { messageInput } = elements;
        // If the canvas is open and there's content, ensure the placeholder is in the input
        if (!messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Add a space for better formatting if the input is not empty
            const prefix = messageInput.value.length > 0 ? ' ' : '';
            messageInput.value += prefix + CANVAS_PLACEHOLDER;
            uiHelper.autoResizeTextarea(messageInput);
        }
    }

    function handleCanvasWindowClosed() {
        isCanvasWindowOpen = false;
        const { messageInput } = elements;
        // Remove the placeholder when the window is closed
        if (messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Also remove any surrounding whitespace for cleanliness
            messageInput.value = messageInput.value.replace(new RegExp(`\\s*${CANVAS_PLACEHOLDER}\\s*`, 'g'), '').trim();
            uiHelper.autoResizeTextarea(messageInput);
        }
    }


    async function syncHistoryFromFile(itemId, itemType, topicId) {
        if (!messageRenderer) return;

        // 🔧 检查是否有正在进行的编辑操作
        const isEditing = document.querySelector('.message-item-editing');
        if (isEditing) {
            console.log('[Sync] Aborting sync because a message is currently being edited.');
            return;
        }

        // 1. Fetch the latest history from the file
        let newHistory;
        if (itemType === 'agent') {
            newHistory = await electronAPI.getChatHistory(itemId, topicId);
        } else if (itemType === 'group') {
            newHistory = await electronAPI.getGroupChatHistory(itemId, topicId);
        }

        if (!newHistory || newHistory.error) {
            console.error("Sync failed: Could not fetch new history.", newHistory?.error);
            return;
        }

        const oldHistory = currentChatHistoryRef.get();
        let historyInMem = [...oldHistory]; // Create a mutable copy to work with

        const oldHistoryMap = new Map(oldHistory.map(msg => [msg.id, msg]));
        const newHistoryMap = new Map(newHistory.map(msg => [msg.id, msg]));
        const activeStreamingId = window.streamManager ? window.streamManager.getActiveStreamingMessageId() : null;

        // --- Perform UI and Memory updates ---

        // 2. Handle DELETED and MODIFIED messages
        for (const oldMsg of oldHistory) {
            if (oldMsg.id === activeStreamingId) {
                continue; // Protect the currently streaming message
            }
            
            const newMsgData = newHistoryMap.get(oldMsg.id);

            if (!newMsgData) {
                // Message was DELETED from the file
                messageRenderer.removeMessageById(oldMsg.id, false); // Update UI
                const indexToRemove = historyInMem.findIndex(m => m.id === oldMsg.id);
                if (indexToRemove > -1) {
                    historyInMem.splice(indexToRemove, 1); // Update Memory
                }
            } else {
                // Message exists, check for MODIFICATION
                if (JSON.stringify(oldMsg.content) !== JSON.stringify(newMsgData.content)) {
                    if (typeof messageRenderer.updateMessageContent === 'function') {
                        messageRenderer.updateMessageContent(oldMsg.id, newMsgData.content); // Update UI
                    }
                    const indexToUpdate = historyInMem.findIndex(m => m.id === oldMsg.id);
                    if (indexToUpdate > -1) {
                        historyInMem[indexToUpdate] = newMsgData; // Update Memory
                    }
                }
            }
        }

        // 3. Handle ADDED messages
        let messagesWereAdded = false;
        for (const newMsg of newHistory) {
            if (!oldHistoryMap.has(newMsg.id)) {
                // Message was ADDED
                messageRenderer.renderMessage(newMsg, true); // Update UI (true = don't modify history ref inside)
                historyInMem.push(newMsg); // Update Memory
                messagesWereAdded = true;
            }
        }

        // 4. If messages were added or removed, the order might be wrong. Re-sort.
        // Also ensures the streaming message (if any) is at the very end.
        historyInMem.sort((a, b) => {
            if (a.id === activeStreamingId) return 1;
            if (b.id === activeStreamingId) return -1;
            return a.timestamp - b.timestamp;
        });

        // 5. Commit the fully merged and sorted history back to the ref. This is the new source of truth.
        currentChatHistoryRef.set(historyInMem);

        // If messages were added, the DOM order might be incorrect. A full re-render is safest
        // but can cause flicker. For now, we accept this as the individual DOM operations
        // are faster. A subsequent topic load will fix any visual misordering.
        if (messagesWereAdded) {
             console.log('[Sync] New messages were added. DOM might require a refresh to be perfectly ordered.');
        }
    }



    // --- Public API ---
    return {
        init,
        selectItem,
        selectTopic,
        handleTopicDeletion,
        loadChatHistory,
        handleSendMessage,
        createNewTopicForItem,
        createNewTopicWithMessages, // 新增：带预制消息的新建话题功能
        displayNoItemSelected,
        attemptTopicSummarizationIfNeeded,
        handleCreateBranch,
        handleForwardMessage,
        syncHistoryFromFile, // Expose the new function
    };
})();
