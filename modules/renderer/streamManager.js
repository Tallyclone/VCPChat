// modules/renderer/streamManager.js

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string
// const streamingHistory = new Map(); // DEPRECATED: This was the source of the sync bug.
let activeStreamingMessageId = null; // Track the currently active streaming message

// --- 新增：预缓冲系统 ---
const preBufferedChunks = new Map(); // messageId -> array of chunks waiting for initialization
const messageInitializationStatus = new Map(); // messageId -> 'pending' | 'ready' | 'finalized'

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
    const messageId = message.id;
    
    // 标记消息为初始化中
    messageInitializationStatus.set(messageId, 'pending');
    
    activeStreamingMessageId = messageId;
    const { chatMessagesDiv, electronAPI, currentChatHistoryRef, currentSelectedItemRef, currentTopicIdRef, uiHelper } = refs;
    if (!message || !messageId) return null;

    const currentSelectedItem = currentSelectedItemRef.get();
    const currentTopicId = currentTopicIdRef.get();

    // Determine if the message is for the active chat.
    // This is a simplified check. A more robust solution might pass the message's context.
    const isForActiveChat = (passedMessageItem !== null) || (document.querySelector(`.message-item[data-message-id="${message.id}"]`) !== null);

    let messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);

    // We only need to manipulate the DOM if the message is for the currently visible chat.
    if (isForActiveChat) {
        if (!messageItem) {
            const placeholderMessage = { ...message, content: '', isThinking: false, timestamp: message.timestamp || Date.now(), isGroupMessage: message.isGroupMessage || false };
            messageItem = refs.renderMessage(placeholderMessage, false);
            if (!messageItem) {
                console.error(`[StreamManager] CRITICAL: Failed to render message item for active chat ${message.id}.`);
                return null;
            }
        }
        messageItem.classList.add('streaming');
        messageItem.classList.remove('thinking');
    }

    // Always prepare the message data for history.
    let initialContentForHistory = '';
    if (shouldEnableSmoothStreaming(messageId)) {
        streamingChunkQueues.set(messageId, []);
        accumulatedStreamText.set(messageId, '');
    }
    
    const placeholderForHistory = {
        ...message,
        content: initialContentForHistory,
        isThinking: false,
        timestamp: message.timestamp || Date.now(),
        isGroupMessage: message.isGroupMessage || false
    };

    // Update the history. This part is crucial and now handles both active and background chats.
    const history = currentChatHistoryRef.get();
    const historyIndex = history.findIndex(m => m.id === message.id);

    if (historyIndex === -1) {
        history.push(placeholderForHistory);
    } else {
        history[historyIndex] = { ...history[historyIndex], ...placeholderForHistory };
    }
    
    // This is the key change: We are now explicitly updating the history for the *current* chat.
    // When a background chat finishes, its *full* history will be loaded from disk, updated, and saved.
    // This immediate update is primarily for the active chat's UI consistency.
    currentChatHistoryRef.set([...history]);
    
    // Save the history immediately to ensure the placeholder is on disk before finalization.
    // This is critical for the background chat scenario.
    const itemId = currentSelectedItem.id;
    const topicId = currentTopicId;
    const itemType = currentSelectedItem.type;

    if (itemId && topicId) {
        const historyToSave = history.filter(msg => !msg.isThinking);
         if (itemType === 'agent') {
            electronAPI.saveChatHistory(itemId, topicId, historyToSave);
        } else if (itemType === 'group') {
            electronAPI.saveGroupChatHistory(itemId, topicId, historyToSave);
        }
    }

    // 处理预缓冲的chunks（如果有）
    const bufferedChunks = preBufferedChunks.get(messageId);
    if (bufferedChunks && bufferedChunks.length > 0) {
        console.log(`[StreamManager] Processing ${bufferedChunks.length} pre-buffered chunks for message ${messageId}`);
        
        // 将预缓冲的chunks转移到正式队列
        for (const chunkData of bufferedChunks) {
            // 重新调用appendStreamChunk处理这些chunks
            appendStreamChunk(messageId, chunkData.chunk, chunkData.context);
        }
        preBufferedChunks.delete(messageId);
    }
    
    // 标记消息为就绪
    messageInitializationStatus.set(messageId, 'ready');

    if (isForActiveChat) {
        uiHelper.scrollToBottom();
    }

    return messageItem;
}

export function appendStreamChunk(messageId, chunkData, context) {
    // 检查消息是否已初始化
    const initStatus = messageInitializationStatus.get(messageId);
    
    // 如果消息还未初始化，先缓冲chunk
    if (!initStatus || initStatus === 'pending') {
        if (!preBufferedChunks.has(messageId)) {
            preBufferedChunks.set(messageId, []);
        }
        preBufferedChunks.get(messageId).push({ chunk: chunkData, context });
        console.log(`[StreamManager] Pre-buffering chunk for uninitialized message ${messageId}`);
        return;
    }
    
    // 如果消息已经finalized，忽略迟到的chunks（但记录日志）
    if (initStatus === 'finalized') {
        console.warn(`[StreamManager] Received chunk for already finalized message ${messageId}. This chunk will be ignored.`);
        return;
    }

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
    // 先处理所有剩余的队列chunks
    if (shouldEnableSmoothStreaming(messageId)) {
        const queue = streamingChunkQueues.get(messageId);
        
        // 强制处理所有剩余的chunks
        if (queue && queue.length > 0) {
            console.log(`[StreamManager] Processing ${queue.length} remaining chunks before finalization`);
            
            // 批量处理所有剩余chunks
            while (queue.length > 0) {
                processAndRenderSmoothChunk(messageId);
            }
            
            // 等待一个小延迟确保DOM更新
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    // Stop timers and clear active streaming ID
    if (streamingTimers.has(messageId)) {
        clearInterval(streamingTimers.get(messageId));
        streamingTimers.delete(messageId);
    }
    if (activeStreamingMessageId === messageId) {
        activeStreamingMessageId = null;
    }
    
    // 标记为已完成
    messageInitializationStatus.set(messageId, 'finalized');

    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = refs;
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicIdVal = refs.currentTopicIdRef.get();

    // 1. Determine if the message belongs to the currently active chat window.
    const isRelevant = context && currentSelectedItem &&
        (context.groupId ? context.groupId === currentSelectedItem.id : context.agentId === currentSelectedItem.id) &&
        context.topicId === currentTopicIdVal;

    // 2. Get the appropriate chat history.
    let historyForThisMessage;
    if (isRelevant) {
        // For the active chat, use the in-memory history reference.
        historyForThisMessage = refs.currentChatHistoryRef.get();
    } else if (context) {
        // For a background chat, we must fetch the history from the file system.
        const { agentId, groupId, topicId } = context;
        const itemId = groupId || agentId;
        const itemType = groupId ? 'group' : 'agent';
        if (itemId && topicId) {
            try {
                const historyResult = itemType === 'agent'
                    ? await electronAPI.getChatHistory(itemId, topicId)
                    : await electronAPI.getGroupChatHistory(itemId, topicId);
                
                if (historyResult && !historyResult.error) {
                    historyForThisMessage = historyResult;
                } else {
                    console.error(`[StreamManager] Finalize: Failed to get history for background chat`, context, historyResult?.error);
                }
            } catch (e) {
                console.error(`[StreamManager] Finalize: Exception getting history for background chat`, context, e);
            }
        }
    }

    // Abort if we couldn't retrieve the history.
    if (!historyForThisMessage) {
        console.error(`[StreamManager] Finalize: Could not retrieve history for message ${messageId}. Aborting.`);
        accumulatedStreamText.delete(messageId);
        streamingChunkQueues.delete(messageId);
        return;
    }

    // 3. Find and update the message in the retrieved history.
    const finalFullText = accumulatedStreamText.get(messageId) || "";
    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);

    if (messageIndex === -1) {
        console.error(`[StreamManager] Finalize: Message ${messageId} not found in its history array. The message might have been deleted.`, { isRelevant, context });
        // Clean up and exit if message not found.
        accumulatedStreamText.delete(messageId);
        streamingChunkQueues.delete(messageId);
        return;
    }

    const message = historyForThisMessage[messageIndex];
    message.content = finalFullText;
    message.finishReason = finishReason;
    message.isThinking = false;
    if (message.isGroupMessage && context) {
        message.name = context.agentName || message.name;
        message.agentId = context.agentId || message.agentId;
    }

    // 4. If it's the active chat, update the UI and the in-memory state.
    if (isRelevant) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);
        
        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.remove('streaming', 'thinking');
            
            // Final, authoritative DOM render
            const contentDiv = messageItem.querySelector('.md-content');
            if (contentDiv) {
                const globalSettings = refs.globalSettingsRef.get();
                const processedFinalText = refs.preprocessFullContent(finalFullText, globalSettings);
                const rawHtml = markedInstance.parse(processedFinalText);
                refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
                refs.processRenderedContent(contentDiv);
                if (globalSettings.enableAgentBubbleTheme && refs.processAnimationsInContent) {
                    refs.processAnimationsInContent(contentDiv);
                }
            }
            
            // Add context menu and update timestamp if needed
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

            refs.uiHelper.scrollToBottom();
        }
    }

    // 5. Always save the updated history back to the file system.
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

    // 6. Final cleanup.
    streamingChunkQueues.delete(messageId);
    accumulatedStreamText.delete(messageId);
    
    // 清理所有相关数据
    setTimeout(() => {
        messageInitializationStatus.delete(messageId);
        preBufferedChunks.delete(messageId);
    }, 5000); // 5秒后清理，防止极端延迟的chunks
}

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    getActiveStreamingMessageId: () => activeStreamingMessageId, // Expose a getter
};
