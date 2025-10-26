/**
 * This module encapsulates all event listener setup logic for the main renderer process.
 */

// This function will be called from renderer.js to attach all event listeners.
// It receives a 'deps' object containing all necessary references to elements, state, and functions.
export function setupEventListeners(deps) {
    const {
        // DOM Elements from a future dom-elements.js or passed directly
        chatMessagesDiv, sendMessageBtn, messageInput, attachFileBtn, globalSettingsBtn,
        globalSettingsForm, userAvatarInput, createNewAgentBtn, createNewGroupBtn,
        currentItemActionBtn, clearNotificationsBtn, openAdminPanelBtn, toggleNotificationsBtn,
        notificationsSidebar, agentSearchInput, minimizeToTrayBtn, addNetworkPathBtn,
        openTranslatorBtn, openNotesBtn, openMusicBtn, openCanvasBtn, toggleAssistantBtn,
        enableContextSanitizerCheckbox, contextSanitizerDepthContainer, seamFixer,

        // State variables (passed via refs)
        refs,

        // Modules and helper functions
        uiHelperFunctions, chatManager, itemListManager, settingsManager, uiManager,
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
        
        if (!lastAiMessage) {
            console.log('[ContinueWriting] 没有找到AI消息，视为普通对话');
            if (!additionalPrompt) {
                uiHelperFunctions.showToastNotification('请输入内容或选择包含AI回复的话题', 'info');
                return;
            }
            await chatManager.handleSendMessage();
            return;
        }
        
        const temporaryPrompt = additionalPrompt || globalSettings.continueWritingPrompt || '请继续';
        
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
            
            const temporaryUserMessage = { role: 'user', content: temporaryPrompt };
            historySnapshotForVCP = [...historySnapshotForVCP, temporaryUserMessage];
            
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

    if (chatMessagesDiv) {
        chatMessagesDiv.addEventListener('click', (event) => {
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
    globalSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const networkNotesPathsContainer = document.getElementById('networkNotesPathsContainer');
        const pathInputs = networkNotesPathsContainer.querySelectorAll('input[name="networkNotesPath"]');
        const networkNotesPaths = Array.from(pathInputs).map(input => input.value.trim()).filter(path => path);

        const newSettings = {
            userName: document.getElementById('userName').value.trim() || '用户',
            continueWritingPrompt: document.getElementById('continueWritingPrompt').value.trim() || '请继续',
            enableMiddleClickQuickAction: document.getElementById('enableMiddleClickQuickAction').checked,
            middleClickQuickAction: document.getElementById('middleClickQuickAction').value,
            enableMiddleClickAdvanced: document.getElementById('enableMiddleClickAdvanced').checked,
            middleClickAdvancedDelay: Math.max(1000, parseInt(document.getElementById('middleClickAdvancedDelay').value, 10) || 1000),
            enableRegenerateConfirmation: document.getElementById('enableRegenerateConfirmation').checked,
            vcpServerUrl: settingsManager.completeVcpUrl(document.getElementById('vcpServerUrl').value.trim()),
            vcpApiKey: document.getElementById('vcpApiKey').value,
            vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
            vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
            topicSummaryModel: document.getElementById('topicSummaryModel').value.trim(),
            networkNotesPaths: networkNotesPaths,
            sidebarWidth: refs.globalSettings.get().sidebarWidth,
            notificationsSidebarWidth: refs.globalSettings.get().notificationsSidebarWidth,
            enableAgentBubbleTheme: document.getElementById('enableAgentBubbleTheme').checked,
            enableSmoothStreaming: document.getElementById('enableSmoothStreaming').checked,
            minChunkBufferSize: parseInt(document.getElementById('minChunkBufferSize').value, 10) || 16,
            smoothStreamIntervalMs: parseInt(document.getElementById('smoothStreamIntervalMs').value, 10) || 100,
            assistantAgent: document.getElementById('assistantAgent').value,
            enableDistributedServer: document.getElementById('enableDistributedServer').checked,
            agentMusicControl: document.getElementById('agentMusicControl').checked,
            enableVcpToolInjection: document.getElementById('enableVcpToolInjection').checked,
            enableContextSanitizer: document.getElementById('enableContextSanitizer').checked,
            contextSanitizerDepth: parseInt(document.getElementById('contextSanitizerDepth').value, 10) || 0,
        };

        const userAvatarCropped = getCroppedFile('user');
        if (userAvatarCropped) {
            try {
                const arrayBuffer = await userAvatarCropped.arrayBuffer();
                const avatarSaveResult = await window.electronAPI.saveUserAvatar({
                    name: userAvatarCropped.name,
                    type: userAvatarCropped.type,
                    buffer: arrayBuffer
                });
                if (avatarSaveResult.success) {
                    refs.globalSettings.get().userAvatarUrl = avatarSaveResult.avatarUrl;
                    document.getElementById('userAvatarPreview').src = avatarSaveResult.avatarUrl;
                    document.getElementById('userAvatarPreview').style.display = 'block';
                    if (window.messageRenderer) {
                        window.messageRenderer.setUserAvatar(avatarSaveResult.avatarUrl);
                    }
                    if (avatarSaveResult.needsColorExtraction && window.electronAPI && window.electronAPI.saveAvatarColor) {
                        if (window.getDominantAvatarColor) {
                            window.getDominantAvatarColor(avatarSaveResult.avatarUrl).then(avgColor => {
                                if (avgColor) {
                                    window.electronAPI.saveAvatarColor({ type: 'user', id: 'user_global', color: avgColor })
                                        .then((saveColorResult) => {
                                            if (saveColorResult && saveColorResult.success) {
                                                refs.globalSettings.get().userAvatarCalculatedColor = avgColor;
                                                if (window.messageRenderer) window.messageRenderer.setUserAvatarColor(avgColor);
                                            } else {
                                                console.warn("Failed to save user avatar color:", saveColorResult?.error);
                                            }
                                        }).catch(err => console.error("Error saving user avatar color:", err));
                                }
                            });
                        }
                    }
                    setCroppedFile('user', null);
                    document.getElementById('userAvatarInput').value = '';
                } else {
                    uiHelperFunctions.showToastNotification(`保存用户头像失败: ${avatarSaveResult.error}`, 'error');
                }
            } catch (readError) {
                uiHelperFunctions.showToastNotification(`读取用户头像文件失败: ${readError.message}`, 'error');
            }
        }

        const result = await window.electronAPI.saveSettings(newSettings);
        if (result.success) {
            Object.assign(refs.globalSettings.get(), newSettings);
            uiHelperFunctions.showToastNotification('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
            uiHelperFunctions.closeModal('globalSettingsModal');
            if (refs.globalSettings.get().vcpLogUrl && refs.globalSettings.get().vcpLogKey) {
                 window.electronAPI.connectVCPLog(refs.globalSettings.get().vcpLogUrl, refs.globalSettings.get().vcpLogKey);
            } else {
                 window.electronAPI.disconnectVCPLog();
                 if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, document.getElementById('vcpLogConnectionStatus'));
            }
       } else {
           uiHelperFunctions.showToastNotification(`保存全局设置失败: ${result.error}`, 'error');
        }
    });

    if (addNetworkPathBtn) {
        addNetworkPathBtn.addEventListener('click', () => addNetworkPathInput());
    }

    if (userAvatarInput) {
        userAvatarInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                uiHelperFunctions.openAvatarCropper(file, (croppedFile) => {
                    setCroppedFile('user', croppedFile);
                    const userAvatarPreview = document.getElementById('userAvatarPreview');
                    if (userAvatarPreview) {
                        userAvatarPreview.src = URL.createObjectURL(croppedFile);
                        userAvatarPreview.style.display = 'block';
                    }
                }, 'user');
            } else {
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                if (userAvatarPreview) userAvatarPreview.style.display = 'none';
                setCroppedFile('user', null);
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

    clearNotificationsBtn.addEventListener('click', () => {
        document.getElementById('notificationsList').innerHTML = '';
    });

    if (openAdminPanelBtn) {
        openAdminPanelBtn.style.display = 'inline-block';
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

        openAdminPanelBtn.addEventListener('click', async () => {
            const globalSettings = refs.globalSettings.get();
            if (globalSettings.vcpServerUrl) {
                if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                    try {
                        const apiUrl = new URL(globalSettings.vcpServerUrl);
                        let adminPanelUrl = `${apiUrl.protocol}//${apiUrl.host}`;
                        if (!adminPanelUrl.endsWith('/')) {
                            adminPanelUrl += '/';
                        }
                        adminPanelUrl += 'AdminPanel/';
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
                uiHelperFunctions.openModal('globalSettingsModal');
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
            if (!refs.currentSelectedItem.get().id || !refs.currentTopicId.get()) {
                uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
                return;
            }
            const currentInputText = messageInput ? messageInput.value.trim() : '';
            handleContinueWriting(currentInputText);
        }
    });

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

