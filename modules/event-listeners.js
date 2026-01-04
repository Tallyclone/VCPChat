/**
 * This module encapsulates all event listener setup logic for the main renderer process.
 */

import { handleSaveGlobalSettings } from './global-settings-manager.js';

// This function will be called from renderer.js to attach all event listeners.
// It receives a 'deps' object containing all necessary references to elements, state, and functions.
export function setupEventListeners(deps) {
    const {
        // DOM Elements from a future dom-elements.js or passed directly
        chatMessagesDiv, sendMessageBtn, messageInput, attachFileBtn, globalSettingsBtn,
        globalSettingsForm, userAvatarInput, createNewAgentBtn, createNewGroupBtn,
        currentItemActionBtn, clearNotificationsBtn, openForumBtn, toggleNotificationsBtn,
        notificationsSidebar, agentSearchInput, minimizeToTrayBtn, addNetworkPathBtn,
        openTranslatorBtn, openNotesBtn, openMusicBtn, openCanvasBtn, toggleAssistantBtn,
        leftSidebar, toggleSidebarBtn,
        enableContextSanitizerCheckbox, contextSanitizerDepthContainer, seamFixer,

        // State variables (passed via refs)
        refs,

        // Modules and helper functions
        uiHelperFunctions, chatManager, itemListManager, settingsManager, uiManager, topicListManager,
        getCroppedFile, setCroppedFile, updateAttachmentPreview, filterAgentList,
        addNetworkPathInput
    } = deps;

    // --- Keyboard Shortcut Handlers ---

    /**
     * Handles the quick save settings shortcut.
     */
    function handleQuickSaveSettings() {
        console.log('[快捷键] 执行快速保存设置');

        const currentItem = refs.currentSelectedItem.get();
        if (!currentItem.id) {
            uiHelperFunctions.showToastNotification('请先选择一个Agent或群组', 'warning');
            return;
        }

        const agentSettingsForm = document.getElementById('agentSettingsForm');
        if (agentSettingsForm && currentItem.type === 'agent') {
            const fakeEvent = new Event('submit', { bubbles: true, cancelable: true });
            agentSettingsForm.dispatchEvent(fakeEvent);
        } else if (currentItem.type === 'group') {
            const groupSettingsForm = document.getElementById('groupSettingsForm');
            if (groupSettingsForm) {
                const fakeEvent = new Event('submit', { bubbles: true, cancelable: true });
                groupSettingsForm.dispatchEvent(fakeEvent);
            } else {
                uiHelperFunctions.showToastNotification('群组设置表单不可用', 'error');
            }
        } else {
            uiHelperFunctions.showToastNotification('当前没有可保存的设置', 'info');
        }
    }

    /**
     * Handles the quick export topic shortcut.
     */
    async function handleQuickExportTopic() {
        console.log('[快捷键] 执行快速导出话题');

        const currentTopicId = refs.currentTopicId.get();
        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentTopicId || !currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification('请先选择并打开一个话题', 'warning');
            return;
        }

        try {
            let topicName = '未命名话题';
            if (currentSelectedItem.config && currentSelectedItem.config.topics) {
                const currentTopic = currentSelectedItem.config.topics.find(t => t.id === currentTopicId);
                if (currentTopic) {
                    topicName = currentTopic.name;
                }
            }

            const chatMessagesDiv = document.getElementById('chatMessages');
            if (!chatMessagesDiv) {
                uiHelperFunctions.showToastNotification('错误：找不到聊天内容容器', 'error');
                return;
            }

            const messageItems = chatMessagesDiv.querySelectorAll('.message-item');
            if (messageItems.length === 0) {
                uiHelperFunctions.showToastNotification('此话题没有可见的聊天内容可导出', 'info');
                return;
            }

            let markdownContent = `# 话题: ${topicName}\n\n`;
            let extractedCount = 0;

            messageItems.forEach((item) => {
                if (item.classList.contains('system') || item.classList.contains('thinking')) {
                    return;
                }

                const senderElement = item.querySelector('.sender-name');
                const contentElement = item.querySelector('.md-content');

                if (senderElement && contentElement) {
                    const sender = senderElement.textContent.trim().replace(':', '');
                    let content = contentElement.innerText || contentElement.textContent || "";
                    content = content.trim();

                    if (sender && content) {
                        markdownContent += `**${sender}**: ${content}\n\n---\n\n`;
                        extractedCount++;
                    }
                }
            });

            if (extractedCount === 0) {
                uiHelperFunctions.showToastNotification('未能从当前话题中提取任何有效对话内容', 'warning');
                return;
            }

            const result = await window.electronAPI.exportTopicAsMarkdown({
                topicName: topicName,
                markdownContent: markdownContent
            });

            if (result.success) {
                uiHelperFunctions.showToastNotification(`话题 "${topicName}" 已成功导出到: ${result.path}`, 'success');
            } else {
                uiHelperFunctions.showToastNotification(`导出话题失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('[快捷键] 导出话题时发生错误:', error);
            uiHelperFunctions.showToastNotification(`导出话题时发生错误: ${error.message}`, 'error');
        }
    }

    /**
     * Handles the continue writing functionality.
     * @param {string} additionalPrompt - Additional prompt text from the input box.
     */
    async function handleContinueWriting(additionalPrompt = '') {
        console.log('[ContinueWriting] 开始执行续写功能，附加提示词:', additionalPrompt);

        const currentSelectedItem = refs.currentSelectedItem.get();
        const currentTopicId = refs.currentTopicId.get();
        const globalSettings = refs.globalSettings.get();
        const currentChatHistory = refs.currentChatHistory.get();

        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
            return;
        }
        
        if (!globalSettings.vcpServerUrl) {
            uiHelperFunctions.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
            uiHelperFunctions.openModal('globalSettingsModal');
            return;
        }
        
        if (currentSelectedItem.type === 'group') {
            uiHelperFunctions.showToastNotification('群组聊天暂不支持续写功能', 'warning');
            return;
        }
        
        const lastAiMessage = [...currentChatHistory].reverse().find(msg => msg.role === 'assistant' && !msg.isThinking);
        
        // 改进：即使没有AI消息，也允许续写（让当前Agent开始发言）
        // 区分两种情况：
        // 1. 有AI消息：使用续写提示词（附加提示词或默认续写提示词）
        // 2. 无AI消息：如果有附加提示词则使用，否则直接让AI开始对话（不添加额外提示）
        let temporaryPrompt;
        if (!lastAiMessage) {
            console.log('[ContinueWriting] 没有找到AI消息，让当前Agent开始发言');
            // 如果有附加提示词，使用附加提示词；否则不添加提示词（让AI基于现有上下文自然开始）
            temporaryPrompt = additionalPrompt || '';
        } else {
            // 有AI消息时，使用续写逻辑：优先使用附加提示词，否则使用默认续写提示词
            temporaryPrompt = additionalPrompt || globalSettings.continueWritingPrompt || '请继续';
        }
        
        const thinkingMessageId = `regen_${Date.now()}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI',
            content: '续写中...',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };
        
        let thinkingMessageItem = null;
        if (window.messageRenderer) {
            thinkingMessageItem = await window.messageRenderer.renderMessage(thinkingMessage);
        }
        currentChatHistory.push(thinkingMessage);
        
        try {
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            let historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
            
            // 只有当有提示词时才添加临时用户消息
            // 如果 temporaryPrompt 为空，说明是无AI消息且无输入的情况，让AI基于现有上下文自然开始
            if (temporaryPrompt && temporaryPrompt.trim()) {
                const temporaryUserMessage = { role: 'user', content: temporaryPrompt };
                historySnapshotForVCP = [...historySnapshotForVCP, temporaryUserMessage];
            }
            
            const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
                let currentMessageTextContent = '';
                if (typeof msg.content === 'string') {
                    currentMessageTextContent = msg.content;
                } else if (msg.content && typeof msg.content === 'object') {
                    if (typeof msg.content.text === 'string') {
                        currentMessageTextContent = msg.content.text;
                    } else if (Array.isArray(msg.content)) {
                        currentMessageTextContent = msg.content
                            .filter(item => item.type === 'text' && item.text)
                            .map(item => item.text)
                            .join('\n');
                    }
                }
                return { role: msg.role, content: currentMessageTextContent };
            }));
            
            if (agentConfig && agentConfig.systemPrompt) {
                let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentSelectedItem.id);
                const prependedContent = [];
                
                if (agentConfig.agentDataPath && currentTopicId) {
                    const historyPath = `${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`;
                    prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
                }
                
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
            
            const useStreaming = (agentConfig?.streamOutput !== false);
            const modelConfigForVCP = {
                model: agentConfig?.model || 'gemini-pro',
                temperature: agentConfig?.temperature !== undefined ? parseFloat(agentConfig.temperature) : 0.7,
                ...(agentConfig?.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
                ...(agentConfig?.contextTokenLimit && { contextTokenLimit: parseInt(agentConfig.contextTokenLimit) }),
                stream: useStreaming
            };
            
            if (useStreaming) {
                if (window.messageRenderer) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await window.messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" }, thinkingMessageItem);
                }
            }
            
            const context = {
                agentId: currentSelectedItem.id,
                agentName: currentSelectedItem.name || currentSelectedItem.id,
                topicId: currentTopicId,
                isGroupMessage: false
            };
            
            const vcpResponse = await window.electronAPI.sendToVCP(
                globalSettings.vcpServerUrl,
                globalSettings.vcpApiKey,
                messagesForVCP,
                modelConfigForVCP,
                thinkingMessage.id,
                false,
                context
            );
            
            if (!useStreaming) {
                const { response, context } = vcpResponse;
                const isForActiveChat = context && context.agentId === currentSelectedItem.id && context.topicId === currentTopicId;
                
                if (isForActiveChat) {
                    if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id);
                }
                
                if (response.error) {
                    if (isForActiveChat && window.messageRenderer) {
                        window.messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ContinueWriting] VCP Error:`, response.error);
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: context.agentName || context.agentId || 'AI',
                        avatarUrl: currentSelectedItem.avatarUrl,
                        avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: response.id || `regen_nonstream_${Date.now()}`
                    };
                    
                    const historyForSave = await window.electronAPI.getChatHistory(context.agentId, context.topicId);
                    if (historyForSave && !historyForSave.error) {
                        const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
                        finalHistory.push(assistantMessage);
                        await window.electronAPI.saveChatHistory(context.agentId, context.topicId, finalHistory);
                        
                        if (isForActiveChat) {
                            currentChatHistory.length = 0;
                            currentChatHistory.push(...finalHistory);
                            if (window.messageRenderer) window.messageRenderer.renderMessage(assistantMessage);
                            await window.chatManager.attemptTopicSummarizationIfNeeded();
                        }
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("[ContinueWriting] Streaming setup failed:", vcpResponse.errorDetail || vcpResponse.error);
                }
            }
            
        } catch (error) {
            console.error('[ContinueWriting] 续写时出错:', error);
            if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id);
            if (window.messageRenderer) window.messageRenderer.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
            if (currentSelectedItem.id && currentTopicId) {
                await window.electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory.filter(msg => !msg.isThinking));
            }
        }
    }

    // 导出到window对象供Flowlock使用
    window.handleContinueWriting = handleContinueWriting;

    if (chatMessagesDiv) {
        chatMessagesDiv.addEventListener('click', (event) => {
            // Stop TTS playback when clicking a speaking avatar
            const avatar = event.target.closest('.chat-avatar');
            if (avatar && avatar.classList.contains('speaking')) {
                console.log('[UI] Speaking avatar clicked. Requesting TTS stop via sovitsStop.');
                event.preventDefault();
                event.stopPropagation();
                if (window.electronAPI && window.electronAPI.sovitsStop) {
                    // This sends the stop request to the main process
                    window.electronAPI.sovitsStop();
                }
                return;
            }

            // Handle external links
            const target = event.target.closest('a');
            if (target && target.href) {
                const href = target.href;
                event.preventDefault(); // Prevent default navigation for all links within chat

                if (href.startsWith('#')) { // Internal page anchors
                    console.log('Internal anchor link clicked:', href);
                    return;
                }
                if (href.toLowerCase().startsWith('javascript:')) {
                    console.warn('JavaScript link clicked, ignoring.');
                    return;
                }
                if (href.startsWith('http:') || href.startsWith('https:') || href.startsWith('file:') || href.startsWith('magnet:')) {
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

    sendMessageBtn.addEventListener('click', () => chatManager.handleSendMessage());
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatManager.handleSendMessage();
        }
    });
    messageInput.addEventListener('input', () => uiHelperFunctions.autoResizeTextarea(messageInput));

    messageInput.addEventListener('mousedown', async (e) => {
        if (e.button === 1) { // 中键
            e.preventDefault();
            e.stopPropagation();
            
            // 检查心流锁是否激活
            if (window.flowlockManager && window.flowlockManager.getState().isActive) {
                uiHelperFunctions.showToastNotification('心流锁已启用，无法手动续写', 'warning');
                return;
            }
            
            const currentSelectedItem = refs.currentSelectedItem.get();
            const currentTopicId = refs.currentTopicId.get();
            if (!currentSelectedItem.id || !currentTopicId) {
                uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
                return;
            }
            
            const currentInputText = messageInput.value.trim();
            await handleContinueWriting(currentInputText);
        }
    });

    attachFileBtn.addEventListener('click', async () => {
        const currentSelectedItem = refs.currentSelectedItem.get();
        const currentTopicId = refs.currentTopicId.get();
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
                    refs.attachedFiles.get().push({
                        file: { name: att.name, type: att.type, size: att.size },
                        localPath: att.internalPath,
                        originalName: att.name,
                        _fileManagerData: att
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
    
 
    globalSettingsBtn.addEventListener('click', () => uiHelperFunctions.openModal('globalSettingsModal'));
    
    // 🟢 优化：监听模态框就绪事件，动态绑定内部元素的事件
    document.addEventListener('modal-ready', (e) => {
        const { modalId } = e.detail;
        if (modalId === 'globalSettingsModal') {
            const form = document.getElementById('globalSettingsForm');
            if (form) form.addEventListener('submit', (ev) => handleSaveGlobalSettings(ev, deps));
            
            const addPathBtn = document.getElementById('addNetworkPathBtn');
            if (addPathBtn) addPathBtn.addEventListener('click', () => addNetworkPathInput());
            
            const avatarInput = document.getElementById('userAvatarInput');
            if (avatarInput) setupUserAvatarListener(avatarInput);

            const resetBtn = document.getElementById('resetUserAvatarColorsBtn');
            if (resetBtn) setupResetUserColorsListener(resetBtn);

            const styleHeader = document.getElementById('userStyleCollapseHeader');
            if (styleHeader) {
                styleHeader.addEventListener('click', () => {
                    const container = styleHeader.closest('.agent-style-collapsible-container');
                    if (container) container.classList.toggle('collapsed');
                });
            }

            // 绑定颜色选择器同步
            setupColorSyncListeners();
        }
    });

    function setupUserAvatarListener(input) {
        input.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                uiHelperFunctions.openAvatarCropper(file, (croppedFile) => {
                    setCroppedFile('user', croppedFile);
                    const userAvatarPreview = document.getElementById('userAvatarPreview');
                    if (userAvatarPreview) {
                        const previewUrl = URL.createObjectURL(croppedFile);
                        userAvatarPreview.src = previewUrl;
                        userAvatarPreview.style.display = 'block';
                        
                        if (window.getDominantAvatarColor) {
                            window.getDominantAvatarColor(previewUrl).then((avgColor) => {
                                const userAvatarBorderColorInput = document.getElementById('userAvatarBorderColor');
                                const userAvatarBorderColorTextInput = document.getElementById('userAvatarBorderColorText');
                                const userNameTextColorInput = document.getElementById('userNameTextColor');
                                const userNameTextColorTextInput = document.getElementById('userNameTextColorText');
                                
                                if (avgColor && userAvatarBorderColorInput && userNameTextColorInput) {
                                    const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                                    if (rgbMatch) {
                                        const r = parseInt(rgbMatch[1]);
                                        const g = parseInt(rgbMatch[2]);
                                        const b = parseInt(rgbMatch[3]);
                                        const hexColor = '#' + [r, g, b].map(x => {
                                            const hex = x.toString(16);
                                            return hex.length === 1 ? '0' + hex : hex;
                                        }).join('');
                                        
                                        userAvatarBorderColorInput.value = hexColor;
                                        userAvatarBorderColorTextInput.value = hexColor;
                                        userNameTextColorInput.value = hexColor;
                                        userNameTextColorTextInput.value = hexColor;
                                        userAvatarPreview.style.borderColor = hexColor;
                                    }
                                }
                            }).catch(err => console.error('[EventListeners] Error extracting user avatar color:', err));
                        }
                    }
                }, 'user');
            } else {
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                if (userAvatarPreview) userAvatarPreview.style.display = 'none';
                setCroppedFile('user', null);
            }
        });
    }

    function setupResetUserColorsListener(btn) {
        btn.addEventListener('click', () => {
            const userAvatarPreview = document.getElementById('userAvatarPreview');
            if (!userAvatarPreview || !userAvatarPreview.src || userAvatarPreview.src.includes('default_user_avatar.png')) {
                uiHelperFunctions.showToastNotification('请先上传头像后再重置颜色', 'warning');
                return;
            }
            if (window.getDominantAvatarColor) {
                window.getDominantAvatarColor(userAvatarPreview.src).then((avgColor) => {
                    const borderColorInput = document.getElementById('userAvatarBorderColor');
                    const nameColorInput = document.getElementById('userNameTextColor');
                    if (avgColor && borderColorInput && nameColorInput) {
                        const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                        if (rgbMatch) {
                            const r = parseInt(rgbMatch[1]), g = parseInt(rgbMatch[2]), b = parseInt(rgbMatch[3]);
                            const hexColor = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
                            borderColorInput.value = hexColor;
                            document.getElementById('userAvatarBorderColorText').value = hexColor;
                            nameColorInput.value = hexColor;
                            document.getElementById('userNameTextColorText').value = hexColor;
                            userAvatarPreview.style.borderColor = hexColor;
                            uiHelperFunctions.showToastNotification('已重置为头像默认颜色', 'success');
                        }
                    }
                });
            }
        });
    }

    function setupColorSyncListeners() {
        const sync = (pickerId, textId, previewId) => {
            const picker = document.getElementById(pickerId);
            const text = document.getElementById(textId);
            const preview = previewId ? document.getElementById(previewId) : null;
            if (picker && text) {
                picker.addEventListener('input', (e) => {
                    text.value = e.target.value;
                    if (preview) preview.style.borderColor = e.target.value;
                });
                text.addEventListener('input', (e) => {
                    if (/^#[0-9A-F]{6}$/i.test(e.target.value)) {
                        picker.value = e.target.value;
                        if (preview) preview.style.borderColor = e.target.value;
                    }
                });
            }
        };
        sync('userAvatarBorderColor', 'userAvatarBorderColorText', 'userAvatarPreview');
        sync('userNameTextColor', 'userNameTextColorText');
    }
    
    // 用户样式设置折叠功能
    const userStyleCollapseHeader = document.getElementById('userStyleCollapseHeader');
    if (userStyleCollapseHeader) {
        userStyleCollapseHeader.addEventListener('click', () => {
            const container = userStyleCollapseHeader.closest('.agent-style-collapsible-container');
            if (container) {
                container.classList.toggle('collapsed');
            }
        });
    }
    
    // 用户颜色选择器同步
    const userAvatarBorderColorInput = document.getElementById('userAvatarBorderColor');
    const userAvatarBorderColorTextInput = document.getElementById('userAvatarBorderColorText');
    const userNameTextColorInput = document.getElementById('userNameTextColor');
    const userNameTextColorTextInput = document.getElementById('userNameTextColorText');
    
    if (userAvatarBorderColorInput && userAvatarBorderColorTextInput) {
        userAvatarBorderColorInput.addEventListener('input', (e) => {
            userAvatarBorderColorTextInput.value = e.target.value;
            const userAvatarPreview = document.getElementById('userAvatarPreview');
            if (userAvatarPreview) {
                userAvatarPreview.style.borderColor = e.target.value;
            }
        });
        
        userAvatarBorderColorTextInput.addEventListener('input', (e) => {
            const color = e.target.value.trim();
            if (/^#[0-9A-F]{6}$/i.test(color)) {
                userAvatarBorderColorInput.value = color;
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                if (userAvatarPreview) {
                    userAvatarPreview.style.borderColor = color;
                }
            }
        });
        
        userAvatarBorderColorTextInput.addEventListener('blur', (e) => {
            const color = e.target.value.trim();
            if (!/^#[0-9A-F]{6}$/i.test(color)) {
                e.target.value = userAvatarBorderColorInput.value;
                uiHelperFunctions.showToastNotification('颜色格式无效，请使用 #RRGGBB 格式', 'warning');
            }
        });
    }
    
    if (userNameTextColorInput && userNameTextColorTextInput) {
        userNameTextColorInput.addEventListener('input', (e) => {
            userNameTextColorTextInput.value = e.target.value;
        });
        
        userNameTextColorTextInput.addEventListener('input', (e) => {
            const color = e.target.value.trim();
            if (/^#[0-9A-F]{6}$/i.test(color)) {
                userNameTextColorInput.value = color;
            }
        });
        
        userNameTextColorTextInput.addEventListener('blur', (e) => {
            const color = e.target.value.trim();
            if (!/^#[0-9A-F]{6}$/i.test(color)) {
                e.target.value = userNameTextColorInput.value;
                uiHelperFunctions.showToastNotification('颜色格式无效，请使用 #RRGGBB 格式', 'warning');
            }
        });
    }
    
    // 用户重置颜色按钮
    const resetUserAvatarColorsBtn = document.getElementById('resetUserAvatarColorsBtn');
    if (resetUserAvatarColorsBtn) {
        resetUserAvatarColorsBtn.addEventListener('click', () => {
            const userAvatarPreview = document.getElementById('userAvatarPreview');
            
            if (!userAvatarPreview || !userAvatarPreview.src || userAvatarPreview.src === '#' || userAvatarPreview.src.includes('default_user_avatar.png')) {
                uiHelperFunctions.showToastNotification('请先上传头像后再重置颜色', 'warning');
                return;
            }
            
            if (window.getDominantAvatarColor) {
                window.getDominantAvatarColor(userAvatarPreview.src).then((avgColor) => {
                    if (avgColor && userAvatarBorderColorInput && userNameTextColorInput) {
                        const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                        if (rgbMatch) {
                            const r = parseInt(rgbMatch[1]);
                            const g = parseInt(rgbMatch[2]);
                            const b = parseInt(rgbMatch[3]);
                            const hexColor = '#' + [r, g, b].map(x => {
                                const hex = x.toString(16);
                                return hex.length === 1 ? '0' + hex : hex;
                            }).join('');
                            
                            userAvatarBorderColorInput.value = hexColor;
                            userAvatarBorderColorTextInput.value = hexColor;
                            userNameTextColorInput.value = hexColor;
                            userNameTextColorTextInput.value = hexColor;
                            userAvatarPreview.style.borderColor = hexColor;
                            
                            uiHelperFunctions.showToastNotification('已重置为头像默认颜色', 'success');
                            console.log('[EventListeners] User colors reset to avatar default:', hexColor);
                        }
                    } else {
                        uiHelperFunctions.showToastNotification('无法从头像提取颜色', 'error');
                    }
                }).catch(err => {
                    console.error('[EventListeners] Error extracting user avatar color:', err);
                    uiHelperFunctions.showToastNotification('提取颜色时出错', 'error');
                });
            } else {
                uiHelperFunctions.showToastNotification('颜色提取功能不可用', 'error');
            }
        });
    }

    if (createNewAgentBtn) {
        createNewAgentBtn.textContent = '创建 Agent';
        createNewAgentBtn.style.width = 'auto';
        createNewAgentBtn.addEventListener('click', async () => {
            const defaultAgentName = `新Agent_${Date.now()}`;
            const result = await window.electronAPI.createAgent(defaultAgentName);
            if (result.success) {
                await itemListManager.loadItems();
                await chatManager.selectItem(result.agentId, 'agent', result.agentName, null, result.config);
                uiManager.switchToTab('settings');
            } else {
                uiHelperFunctions.showToastNotification(`创建Agent失败: ${result.error}`, 'error');
            }
        });
    }
    
    if (createNewGroupBtn) {
        createNewGroupBtn.style.display = 'inline-block';
    }

    currentItemActionBtn.addEventListener('click', async () => {
        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个项目。", 'error');
            return;
        }
        await chatManager.createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
    });

    // 【新建话题】按钮右键菜单 - 创建未锁定话题
    currentItemActionBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentSelectedItem.id || currentSelectedItem.type !== 'agent') {
            return; // 仅对 Agent 显示右键菜单
        }
        
        showNewTopicButtonMenu(e, currentSelectedItem);
    });

    /**
     * 显示【新建话题】按钮的右键菜单
     */
    function showNewTopicButtonMenu(event, currentSelectedItem) {
        // 移除已存在的菜单
        const existingMenu = document.getElementById('newTopicContextMenu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.id = 'newTopicContextMenu';
        menu.classList.add('context-menu');
        menu.style.top = `${event.clientY}px`;
        menu.style.left = `${event.clientX}px`;

        // 新建无锁话题选项
        const createUnlockedOption = document.createElement('div');
        createUnlockedOption.classList.add('context-menu-item');
        createUnlockedOption.innerHTML = `<i class="fas fa-unlock"></i> 新建无锁话题`;
        createUnlockedOption.onclick = async () => {
            menu.remove();
            await createNewTopicWithLockStatus(currentSelectedItem, false);
        };
        menu.appendChild(createUnlockedOption);

        document.body.appendChild(menu);
        
        // 点击外部关闭菜单
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu, true);
        }, 0);
    }

    /**
     * 创建指定锁定状态的话题
     * 通过扩展后端 API 来创建带指定锁定状态的话题，然后使用 chatManager 的标准流程切换到该话题
     */
    async function createNewTopicWithLockStatus(currentSelectedItem, locked = true) {
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个Agent。", 'error');
            return;
        }
        
        const newTopicName = `新话题 ${new Date().toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        })}`;
        
        try {
            // 调用后端 API 创建话题，传入 locked 参数
            const result = await window.electronAPI.createNewTopicForAgent(
                currentSelectedItem.id,
                newTopicName,
                false, // isBranch
                locked // 指定锁定状态
            );
            
            if (result && result.success && result.topicId) {
                // 使用 chatManager 的 selectTopic 方法来切换到新创建的话题
                // 这会触发所有必要的状态更新、UI刷新和文件监听器启动
                if (chatManager && chatManager.selectTopic) {
                    await chatManager.selectTopic(result.topicId);
                }

                // 关键修复：在切换话题后，强制刷新话题列表UI
                if (topicListManager && topicListManager.loadTopicList) {
                    await topicListManager.loadTopicList();
                }
                
                uiHelperFunctions.showToastNotification(
                    locked ? '已创建新话题（已锁定）' : '已创建新话题（未锁定，AI可查看）',
                    'success'
                );
            } else {
                uiHelperFunctions.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error('创建话题时出错:', error);
            uiHelperFunctions.showToastNotification(`创建话题时出错: ${error.message}`, 'error');
        }
    }

    clearNotificationsBtn.addEventListener('click', () => {
        document.getElementById('notificationsList').innerHTML = '';
    });

    if (openForumBtn) {
        openForumBtn.style.display = 'inline-block';
        const enableMiddleClickCheckbox = document.getElementById('enableMiddleClickQuickAction');
        const middleClickContainer = document.getElementById('middleClickQuickActionContainer');
        const middleClickAdvancedContainer = document.getElementById('middleClickAdvancedContainer');

        if (enableMiddleClickCheckbox && middleClickContainer && middleClickAdvancedContainer) {
            enableMiddleClickCheckbox.addEventListener('change', () => {
                const isEnabled = enableMiddleClickCheckbox.checked;
                middleClickContainer.style.display = isEnabled ? 'block' : 'none';
                middleClickAdvancedContainer.style.display = isEnabled ? 'block' : 'none';
            });
        }

        const enableMiddleClickAdvancedCheckbox = document.getElementById('enableMiddleClickAdvanced');
        const middleClickAdvancedSettings = document.getElementById('middleClickAdvancedSettings');

        if (enableMiddleClickAdvancedCheckbox && middleClickAdvancedSettings) {
            enableMiddleClickAdvancedCheckbox.addEventListener('change', () => {
                middleClickAdvancedSettings.style.display = enableMiddleClickAdvancedCheckbox.checked ? 'block' : 'none';
            });
        }

        const middleClickQuickActionSelect = document.getElementById('middleClickQuickAction');
        const regenerateConfirmationContainer = document.getElementById('regenerateConfirmationContainer');

        if (enableMiddleClickCheckbox && middleClickQuickActionSelect && regenerateConfirmationContainer) {
            const updateRegenerateConfirmationVisibility = () => {
                const isMiddleClickEnabled = enableMiddleClickCheckbox.checked;
                const selectedAction = middleClickQuickActionSelect.value;
                const shouldShowConfirmation = isMiddleClickEnabled && selectedAction === 'regenerate';
                regenerateConfirmationContainer.style.display = shouldShowConfirmation ? 'block' : 'none';
            };
            updateRegenerateConfirmationVisibility();
            enableMiddleClickCheckbox.addEventListener('change', updateRegenerateConfirmationVisibility);
            middleClickQuickActionSelect.addEventListener('change', updateRegenerateConfirmationVisibility);
        }

        const middleClickAdvancedDelayInput = document.getElementById('middleClickAdvancedDelay');
        if (middleClickAdvancedDelayInput) {
            middleClickAdvancedDelayInput.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10);
                if (value < 1000) {
                    e.target.value = 1000;
                    uiHelperFunctions.showToastNotification('九宫格出现延迟不能小于1000ms，已自动调整', 'info');
                }
            });
            middleClickAdvancedDelayInput.addEventListener('blur', (e) => {
                const value = parseInt(e.target.value, 10);
                if (isNaN(value) || value < 1000) {
                    e.target.value = 1000;
                    uiHelperFunctions.showToastNotification('九宫格出现延迟不能小于1000ms，已自动调整', 'info');
                }
            });
        }

        openForumBtn.addEventListener('click', async () => {
            if (window.electronAPI && window.electronAPI.openForumWindow) {
                await window.electronAPI.openForumWindow();
            } else {
                console.warn('[Renderer] electronAPI.openForumWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开论坛：功能不可用。', 'error');
            }
        });

        // 右键点击 - 打开 VCPMemo 中心
        openForumBtn.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            if (window.electronAPI && window.electronAPI.openMemoWindow) {
                await window.electronAPI.openMemoWindow();
            } else {
                console.warn('[Renderer] electronAPI.openMemoWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开 VCPMemo 中心：功能不可用。', 'error');
            }
        });
    }

    if (openTranslatorBtn) {
        openTranslatorBtn.addEventListener('click', async () => {
            if (window.electronAPI && window.electronAPI.openTranslatorWindow) {
                await window.electronAPI.openTranslatorWindow();
            } else {
                console.warn('[Renderer] electronAPI.openTranslatorWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开翻译助手：功能不可用。', 'error');
            }
        });
    }

    if (openNotesBtn) {
        openNotesBtn.addEventListener('click', async () => {
            if (window.electronAPI && window.electronAPI.openNotesWindow) {
                await window.electronAPI.openNotesWindow();
            } else {
                console.warn('[Renderer] electronAPI.openNotesWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开笔记：功能不可用。', 'error');
            }
        });
    }

    if (openMusicBtn) {
        openMusicBtn.addEventListener('click', () => {
            if (window.electron) {
                window.electron.send('open-music-window');
            } else {
                console.error('Music Player: electron context bridge not found.');
            }
        });
    }

    if (openCanvasBtn) {
        openCanvasBtn.addEventListener('click', () => {
            if (window.electronAPI && window.electronAPI.openCanvasWindow) {
                window.electronAPI.openCanvasWindow();
            } else {
                console.error('Canvas: electronAPI.openCanvasWindow not found.');
            }
        });
    }

    if (toggleNotificationsBtn && notificationsSidebar) {
        toggleNotificationsBtn.addEventListener('click', () => {
            window.electronAPI.sendToggleNotificationsSidebar();
        });

        toggleNotificationsBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (window.electronAPI && window.electronAPI.openRAGObserverWindow) {
                window.electronAPI.openRAGObserverWindow();
            } else {
                console.error('electronAPI.openRAGObserverWindow is not defined!');
                uiHelperFunctions.showToastNotification('功能缺失: preload.js需要更新。', 'error');
            }
        });

        window.electronAPI.onDoToggleNotificationsSidebar(() => {
            const isActive = notificationsSidebar.classList.toggle('active');
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.classList.toggle('notifications-sidebar-active', isActive);
            }
            if (isActive && refs.globalSettings.get().notificationsSidebarWidth) {
                 notificationsSidebar.style.width = `${refs.globalSettings.get().notificationsSidebarWidth}px`;
            }
        });
    }

    if (toggleAssistantBtn) {
        toggleAssistantBtn.addEventListener('click', async () => {
            const globalSettings = refs.globalSettings.get();
            const isActive = toggleAssistantBtn.classList.toggle('active');
            globalSettings.assistantEnabled = isActive;
            window.electronAPI.toggleSelectionListener(isActive);
            const result = await window.electronAPI.saveSettings({
                ...globalSettings,
                assistantEnabled: isActive
            });
            if (result.success) {
                uiHelperFunctions.showToastNotification(`划词助手已${isActive ? '开启' : '关闭'}`, 'info');
            } else {
                uiHelperFunctions.showToastNotification(`设置划词助手状态失败: ${result.error}`, 'error');
                toggleAssistantBtn.classList.toggle('active', !isActive);
                globalSettings.assistantEnabled = !isActive;
            }
        });

        // 右键点击 - 切换侧边栏显示/隐藏
        toggleAssistantBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // 阻止默认的右键菜单
            if (leftSidebar) {
                const isActive = leftSidebar.classList.toggle('active');
                const mainContent = document.querySelector('.main-content');
                if (mainContent) {
                    mainContent.classList.toggle('sidebar-active', isActive);
                }
                // 更新按钮状态
                if (toggleSidebarBtn) {
                    toggleSidebarBtn.classList.toggle('active', isActive);
                }
                
                // 保存侧边栏状态到设置
                const globalSettings = refs.globalSettings.get();
                globalSettings.sidebarActive = isActive;
                
                // 异步保存设置
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    window.electronAPI.saveSettings(globalSettings).then(result => {
                        if (!result.success) {
                            console.error('保存侧边栏状态失败:', result.error);
                        }
                    }).catch(error => {
                        console.error('保存侧边栏状态时出错:', error);
                    });
                }
                
                // 显示操作提示
                // uiHelperFunctions.showToastNotification(`侧边栏已${isActive ? '显示' : '隐藏'}`, 'info');
            }
        });
    }

    // 语音聊天按钮事件处理
    const voiceChatBtn = document.getElementById('voiceChatBtn');
    if (voiceChatBtn) {
        voiceChatBtn.addEventListener('click', async () => {
            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }

            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('语音聊天功能仅适用于Agent，不适用于群组', 'warning');
                return;
            }

            try {
                console.log(`[VoiceChat] Opening voice chat for agent: ${currentSelectedItem.id}`);
                await window.electronAPI.openVoiceChatWindow({
                    agentId: currentSelectedItem.id
                });
            } catch (error) {
                console.error('[VoiceChat] Failed to open voice chat window:', error);
                uiHelperFunctions.showToastNotification(`打开语音聊天失败: ${error.message}`, 'error');
            }
        });
    }
    if (agentSearchInput) {
        agentSearchInput.addEventListener('input', (e) => {
            filterAgentList(e.target.value);
        });
    }

    if (minimizeToTrayBtn) {
        minimizeToTrayBtn.addEventListener('click', () => {
            window.electronAPI.minimizeToTray();
        });
    }

    if (enableContextSanitizerCheckbox && contextSanitizerDepthContainer) {
        enableContextSanitizerCheckbox.addEventListener('change', () => {
            contextSanitizerDepthContainer.style.display = enableContextSanitizerCheckbox.checked ? 'block' : 'none';
        });
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();
            const tabContentSettings = document.getElementById('tabContentSettings');
            if (tabContentSettings && tabContentSettings.classList.contains('active')) {
                handleQuickSaveSettings();
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
            e.preventDefault();
            if (refs.currentTopicId.get() && refs.currentSelectedItem.get().id) {
                handleQuickExportTopic();
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            
            // 检查心流锁是否激活
            if (window.flowlockManager && window.flowlockManager.getState().isActive) {
                uiHelperFunctions.showToastNotification('心流锁已启用，无法手动续写', 'warning');
                return;
            }
            
            if (!refs.currentSelectedItem.get().id || !refs.currentTopicId.get()) {
                uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
                return;
            }
            const currentInputText = messageInput ? messageInput.value.trim() : '';
            handleContinueWriting(currentInputText);
        }

        if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
            e.preventDefault();
            
            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }
            
            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('此快捷键仅适用于Agent，不适用于群组', 'warning');
                return;
            }
            
            // 检查是否按下 Shift 键
            if (e.shiftKey) {
                // Ctrl/Command + Shift + N: 创建未上锁的话题
                console.log('[快捷键] 执行快速新建未上锁话题');
                createNewTopicWithLockStatus(currentSelectedItem, false);
            } else {
                // Ctrl/Command + N: 创建普通话题（已上锁）
                console.log('[快捷键] 执行快速新建话题');
                if (chatManager && chatManager.createNewTopicForItem) {
                    chatManager.createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
                } else {
                    uiHelperFunctions.showToastNotification('无法创建新话题：功能不可用', 'error');
                }
            }
        }
    });

    // 监听来自主进程的全局快捷键触发的创建未锁定话题事件
    if (window.electronAPI && window.electronAPI.onCreateUnlockedTopic) {
        window.electronAPI.onCreateUnlockedTopic(() => {
            console.log('[快捷键] 收到来自主进程的创建未锁定话题请求');
            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }
            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('此快捷键仅适用于Agent，不适用于群组', 'warning');
                return;
            }
            createNewTopicWithLockStatus(currentSelectedItem, false);
        });
    }

    if (seamFixer && notificationsSidebar) {
        const setSeamFixerWidth = () => {
            const sidebarWidth = notificationsSidebar.getBoundingClientRect().width;
            const offset = sidebarWidth > 0 ? 3 : 0;
            seamFixer.style.right = `${sidebarWidth + offset}px`;
        };
        const resizeObserver = new ResizeObserver(setSeamFixerWidth);
        resizeObserver.observe(notificationsSidebar);
        const mutationObserver = new MutationObserver(setSeamFixerWidth);
        mutationObserver.observe(notificationsSidebar, { attributes: true, attributeFilter: ['class', 'style'] });
        setSeamFixerWidth();
    }
}

