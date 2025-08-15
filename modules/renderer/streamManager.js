// modules/renderer/streamManager.js

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string
// const streamingHistory = new Map(); // DEPRECATED: This was the source of the sync bug.
let activeStreamingMessageId = null; // Track the currently active streaming message

// --- Local Reference Store ---
let refs = {};

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
export function initStreamManager(dependencies) {
    refs = dependencies;
}

/**
 * Scrolls the chat to the bottom only if the user is already near the bottom.
 */

function shouldEnableSmoothStreaming() {
    const globalSettings = refs.globalSettingsRef.get();
    return globalSettings.enableSmoothStreaming === true;
}

function messageIsFinalized(messageId) {
    const history = refs.currentChatHistoryRef.get();
    const msg = history.find(m => m.id === messageId);
    return msg && (msg.finishReason || msg.isError);
}

function processAndRenderSmoothChunk(messageId) {
    const { chatMessagesDiv, markedInstance, uiHelper } = refs;
    // ALWAYS get the LATEST history. This is the core fix.
    const historyForThisMessage = refs.currentChatHistoryRef.get();
    
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    // If the message item doesn't exist in the DOM (because it's for a non-visible chat),
    // we should still process the queue and update the history, but skip DOM operations.
    if (!messageItem || !document.body.contains(messageItem)) {
        // The queue processing logic below will handle history updates.
        // We just need to avoid returning early.
        // console.log(`[StreamManager] Smooth chunk for non-visible message ${messageId}. Processing history only.`);
    }

    const contentDiv = messageItem ? messageItem.querySelector('.md-content') : null;
    // if (!contentDiv) return; // Don't return, just skip DOM parts if it's null

    const queue = streamingChunkQueues.get(messageId);
    if (!queue || queue.length === 0) return;

    let textBatchToRender = "";
    const globalSettings = refs.globalSettingsRef.get();
    const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;

    while (queue.length > 0 && textBatchToRender.length < minChunkSize) {
        textBatchToRender += queue.shift();
    }
    
    const chunkToProcess = textBatchToRender;
    if (!chunkToProcess) return;

    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    historyForThisMessage[messageIndex].content += chunkToProcess;
    
    // Only update the main ref if the message is visible to avoid changing the UI for background chats
    if (messageItem && document.body.contains(messageItem)) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);
    }

    const textForRendering = historyForThisMessage[messageIndex].content;
    
    if (contentDiv) {
        const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
        if (streamingIndicator) streamingIndicator.remove();
    }

    let processedTextForParse = refs.removeSpeakerTags(textForRendering);
    processedTextForParse = refs.ensureNewlineAfterCodeBlock(processedTextForParse);
    processedTextForParse = refs.ensureSpaceAfterTilde(processedTextForParse);
    processedTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedTextForParse);
    processedTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedTextForParse);
    
    if (contentDiv) {
        const rawHtml = markedInstance.parse(processedTextForParse);
        refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
        // The full processRenderedContent includes all necessary post-processing,
        // so we call it here to apply syntax highlighting and other effects during streaming.
        refs.processRenderedContent(contentDiv);

        // 调用现在已经内置了条件检查的 scrollToBottom
        refs.uiHelper.scrollToBottom();
    }
}

function renderChunkDirectlyToDOM(messageId, textToAppend, context) {
    const { chatMessagesDiv, markedInstance, uiHelper } = refs;
    // ALWAYS get the LATEST history. This is the core fix.
    const historyForThisMessage = refs.currentChatHistoryRef.get();

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    // if (!messageItem) return; // Don't return, allow history to be updated.
    const contentDiv = messageItem ? messageItem.querySelector('.md-content') : null;
    // if (!contentDiv) return; // Don't return.

    if (contentDiv) {
        const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
        if (streamingIndicator) streamingIndicator.remove();
    }
    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);
    let fullCurrentText = "";
    if (messageIndex > -1) {
        historyForThisMessage[messageIndex].content += textToAppend;
        if (historyForThisMessage[messageIndex].isGroupMessage && context) {
            if (context.agentName && !historyForThisMessage[messageIndex].name) historyForThisMessage[messageIndex].name = context.agentName;
            if (context.agentId && !historyForThisMessage[messageIndex].agentId) historyForThisMessage[messageIndex].agentId = context.agentId;
        }
        fullCurrentText = historyForThisMessage[messageIndex].content;
    } else if (contentDiv) { // Fallback if not in history (should not happen often)
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = contentDiv.innerHTML;
        fullCurrentText = (tempContainer.textContent || "") + textToAppend;
    } else {
        fullCurrentText = textToAppend;
    }

    // Only update the main ref if the message is visible
    if (messageItem && document.body.contains(messageItem)) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);
    }

    let processedFullCurrentTextForParse = refs.removeSpeakerTags(fullCurrentText);
    processedFullCurrentTextForParse = refs.ensureNewlineAfterCodeBlock(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSpaceAfterTilde(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedFullCurrentTextForParse);
    
    if (contentDiv) {
        const rawHtml = markedInstance.parse(processedFullCurrentTextForParse);
        refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
        // The full processRenderedContent includes all necessary post-processing.
        refs.processRenderedContent(contentDiv);
        
        // 此处不再需要无条件调用 scrollToBottom，因为正确的滚动逻辑由 processAndRenderSmoothChunk 和 finalizeStreamedMessage 处理
    }
}

export function startStreamingMessage(message, passedMessageItem = null) {
    activeStreamingMessageId = message.id; // Set the active streaming ID
    const { chatMessagesDiv, uiHelper } = refs;
    if (!message || !message.id) return null;

    let messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);

    if (!messageItem) {
        console.warn(`[StreamManager] Could not find or receive messageItem for ${message.id}. Attempting to re-render.`);
        const placeholderMessage = { ...message, content: '', isThinking: false, timestamp: message.timestamp || Date.now(), isGroupMessage: message.isGroupMessage || false };
        messageItem = refs.renderMessage(placeholderMessage, false);
        if (!messageItem) {
            console.error(`[StreamManager] CRITICAL: Failed to re-render message item for ${message.id}. Aborting stream start.`);
            return null;
        }
    }
    
    messageItem.classList.add('streaming');
    messageItem.classList.remove('thinking'); 

    const currentChatHistoryArray = refs.currentChatHistoryRef.get();
    const historyIndex = currentChatHistoryArray.findIndex(m => m.id === message.id);

    let initialContentForHistory = '';
    if (shouldEnableSmoothStreaming(message.id)) {
        streamingChunkQueues.set(message.id, []);
        accumulatedStreamText.set(message.id, '');
    }
    // When a stream starts, it's always for the current chat.
    // DEPRECATED: Caching the history was the source of the bug.
    // streamingHistory.set(message.id, currentChatHistoryArray);

    if (historyIndex === -1) {
        // Ensure we are pushing to the most current history array
        const latestHistory = refs.currentChatHistoryRef.get();
        latestHistory.push({ ...message, content: initialContentForHistory, isThinking: false, timestamp: message.timestamp || Date.now(), isGroupMessage: message.isGroupMessage || false });
        refs.currentChatHistoryRef.set(latestHistory);
    } else {
        currentChatHistoryArray[historyIndex].isThinking = false;
        currentChatHistoryArray[historyIndex].content = initialContentForHistory;
        currentChatHistoryArray[historyIndex].timestamp = message.timestamp || Date.now();
        currentChatHistoryArray[historyIndex].name = message.name || currentChatHistoryArray[historyIndex].name;
        currentChatHistoryArray[historyIndex].agentId = message.agentId || currentChatHistoryArray[historyIndex].agentId;
        currentChatHistoryArray[historyIndex].isGroupMessage = message.isGroupMessage || currentChatHistoryArray[historyIndex].isGroupMessage || false;
    }
    refs.currentChatHistoryRef.set(currentChatHistoryArray);

    // 调用现在已经内置了条件检查的 scrollToBottom
    refs.uiHelper.scrollToBottom();
    return messageItem;
}

export function appendStreamChunk(messageId, chunkData, context) {
    const currentChatHistoryArray = refs.currentChatHistoryRef.get();

    let textToAppend = "";
    if (chunkData?.choices?.[0]?.delta?.content) {
        textToAppend = chunkData.choices[0].delta.content;
    } else if (chunkData?.delta?.content) {
        textToAppend = chunkData.delta.content;
    } else if (typeof chunkData?.content === 'string') {
        textToAppend = chunkData.content;
    } else if (typeof chunkData === 'string') {
        textToAppend = chunkData;
    } else if (chunkData?.raw) {
        textToAppend = chunkData.raw + (chunkData.error ? ` (解析错误)` : "");
    }

    if (!textToAppend) return;

    // 【关键修正】无论是否开启平滑流，都维护一份完整的文本记录
    let currentAccumulated = accumulatedStreamText.get(messageId) || "";
    currentAccumulated += textToAppend;
    accumulatedStreamText.set(messageId, currentAccumulated);

    // 更新群聊消息的发送者信息（如果需要）
    const messageIndexForMeta = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndexForMeta > -1 && currentChatHistoryArray[messageIndexForMeta].isGroupMessage && context) {
        if (context.agentName && !currentChatHistoryArray[messageIndexForMeta].name) currentChatHistoryArray[messageIndexForMeta].name = context.agentName;
        if (context.agentId && !currentChatHistoryArray[messageIndexForMeta].agentId) currentChatHistoryArray[messageIndexForMeta].agentId = context.agentId;
        refs.currentChatHistoryRef.set([...currentChatHistoryArray]);
    }

    if (shouldEnableSmoothStreaming(messageId)) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue) {
            const chars = textToAppend.split('');
            for (const char of chars) queue.push(char);
        } else {
            // 如果队列不存在，但平滑流是开启的，这是一种边缘情况，直接渲染
            renderChunkDirectlyToDOM(messageId, textToAppend, context);
            return;
        }

        if (!streamingTimers.has(messageId)) {
            const globalSettings = refs.globalSettingsRef.get();
            const timerId = setInterval(() => {
                processAndRenderSmoothChunk(messageId);
                
                const currentQueue = streamingChunkQueues.get(messageId);
                if ((!currentQueue || currentQueue.length === 0) && messageIsFinalized(messageId)) {
                    clearInterval(streamingTimers.get(messageId));
                    streamingTimers.delete(messageId);
                    
                    const finalMessageItem = refs.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
                    if (finalMessageItem) finalMessageItem.classList.remove('streaming');
                    
                    // 最终渲染的逻辑已移至 finalizeStreamedMessage
                    streamingChunkQueues.delete(messageId);
                }
            }, globalSettings.smoothStreamIntervalMs !== undefined && globalSettings.smoothStreamIntervalMs >= 1 ? globalSettings.smoothStreamIntervalMs : 25);
            streamingTimers.set(messageId, timerId);
        }
    } else {
        renderChunkDirectlyToDOM(messageId, textToAppend, context);
    }
}

export async function finalizeStreamedMessage(messageId, finishReason, context) {
    // 停止所有与此消息相关的定时器
    if (streamingTimers.has(messageId)) {
        clearInterval(streamingTimers.get(messageId));
        streamingTimers.delete(messageId);
    }
    if (activeStreamingMessageId === messageId) {
        activeStreamingMessageId = null; // Clear the active ID when stream finishes
    }

    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = refs;
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicIdVal = refs.currentTopicIdRef.get();
    // ALWAYS get the LATEST history. This is the core fix.
    const historyForThisMessage = refs.currentChatHistoryRef.get();

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        console.log(`[StreamManager] Finalize: Message item ${messageId} not found in DOM. Will still process history.`);
        // Don't return early. We must update the history regardless of UI visibility.
    }

    if (messageItem) {
        messageItem.classList.remove('streaming', 'thinking');
    }

    // 【决定性逻辑】无条件地从内部状态获取最终文本
    const finalFullText = accumulatedStreamText.get(messageId) || "";

    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);

    if (messageIndex > -1) {
        const message = historyForThisMessage[messageIndex];
        message.content = finalFullText; // Use the authoritative internal text to update history
        message.finishReason = finishReason;
        message.isThinking = false;

        // Update metadata
        if (message.isGroupMessage && context) {
            message.name = context.agentName || message.name;
            message.agentId = context.agentId || message.agentId;
        }

        // Check if this is the current view
        const isRelevant = context && currentSelectedItem &&
            (context.groupId ? context.groupId === currentSelectedItem.id : context.agentId === currentSelectedItem.id) &&
            context.topicId === currentTopicIdVal;

        if (isRelevant) {
            // If it's the current chat, update the main ref to sync UI state
            refs.currentChatHistoryRef.set([...historyForThisMessage]);
        }
        
        if (messageItem) {
            // Ensure timestamp and context menu exist
            const nameTimeBlock = messageItem.querySelector('.name-time-block');
            if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
                const timestampDiv = document.createElement('div');
                timestampDiv.classList.add('message-timestamp');
                timestampDiv.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                nameTimeBlock.appendChild(timestampDiv);
            }
            messageItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                refs.showContextMenu(e, messageItem, message);
            });
        }

        // Always save the modified history to disk using the context
        const historyToSave = historyForThisMessage.filter(msg => !msg.isThinking);
        if (context) {
            const { agentId, groupId, topicId } = context;
            const itemId = groupId || agentId;
            const itemType = groupId ? 'group' : 'agent';

            if (itemId && topicId) {
                if (itemType === 'agent') {
                    await electronAPI.saveChatHistory(itemId, topicId, historyToSave);
                } else if (itemType === 'group' && electronAPI.saveGroupChatHistory) {
                    await electronAPI.saveGroupChatHistory(itemId, topicId, historyToSave);
                }
            }
        } else {
            console.warn(`[StreamManager] Finalize: Cannot save history for message ${messageId} because context is missing.`);
        }
    } else {
        console.error(`[StreamManager] Finalize: Message ${messageId} not found in its own cached history array.`);
    }

    // 执行最终的、权威的DOM渲染 (仅当 messageItem 存在时)
    if (messageItem) {
        const contentDiv = messageItem.querySelector('.md-content');
        if (contentDiv) {
            const globalSettings = refs.globalSettingsRef.get();
            // Pass settings to the preprocessor
            let processedFinalText = refs.preprocessFullContent(finalFullText, globalSettings);
            const rawHtml = markedInstance.parse(processedFinalText);
            refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
            refs.processRenderedContent(contentDiv);

            // After final content is rendered, check if we need to run animations
            if (globalSettings.enableAgentBubbleTheme && refs.processAnimationsInContent) {
                refs.processAnimationsInContent(contentDiv);
            }
        }
        // 调用现在已经内置了条件检查的 scrollToBottom
        refs.uiHelper.scrollToBottom();
    }
    
    // 清理工作
    streamingChunkQueues.delete(messageId);
    accumulatedStreamText.delete(messageId);
    // streamingHistory.delete(messageId); // Cache removed, so no need to delete
}

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    getActiveStreamingMessageId: () => activeStreamingMessageId, // Expose a getter
};