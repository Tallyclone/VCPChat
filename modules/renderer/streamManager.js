// modules/renderer/streamManager.js

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string

// --- Local Reference Store ---
let refs = {};

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
export function initStreamManager(dependencies) {
    refs = dependencies;
}

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
    const currentChatHistoryArray = refs.currentChatHistoryRef.get();
    
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem || !document.body.contains(messageItem)) {
        if (streamingTimers.has(messageId)) {
            clearInterval(streamingTimers.get(messageId));
            streamingTimers.delete(messageId);
        }
        streamingChunkQueues.delete(messageId);
        accumulatedStreamText.delete(messageId);
        return;
    }

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

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

    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    currentChatHistoryArray[messageIndex].content += chunkToProcess;
    refs.currentChatHistoryRef.set([...currentChatHistoryArray]);

    const textForRendering = currentChatHistoryArray[messageIndex].content;
    
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    let processedTextForParse = refs.removeSpeakerTags(textForRendering);
    processedTextForParse = refs.ensureNewlineAfterCodeBlock(processedTextForParse);
    processedTextForParse = refs.ensureSpaceAfterTilde(processedTextForParse);
    processedTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedTextForParse);
    processedTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedTextForParse);
    processedTextForParse = refs.removeBoldMarkersAroundQuotes(processedTextForParse);
    const rawHtml = markedInstance.parse(processedTextForParse);
   refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
   // The full processRenderedContent includes all necessary post-processing,
   // so we call it here to apply syntax highlighting and other effects during streaming.
   refs.processRenderedContent(contentDiv);
    
    uiHelper.scrollToBottom();
}

function renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup) {
    const { chatMessagesDiv, markedInstance, uiHelper } = refs;
    const currentChatHistoryArray = refs.currentChatHistoryRef.get();

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;
    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    let fullCurrentText = "";
    if (messageIndex > -1) {
        currentChatHistoryArray[messageIndex].content += textToAppend;
        if (currentChatHistoryArray[messageIndex].isGroupMessage) {
            if (agentNameForGroup && !currentChatHistoryArray[messageIndex].name) currentChatHistoryArray[messageIndex].name = agentNameForGroup;
            if (agentIdForGroup && !currentChatHistoryArray[messageIndex].agentId) currentChatHistoryArray[messageIndex].agentId = agentIdForGroup;
        }
        fullCurrentText = currentChatHistoryArray[messageIndex].content;
    } else {
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = contentDiv.innerHTML;
        fullCurrentText = (tempContainer.textContent || "") + textToAppend;
    }
    refs.currentChatHistoryRef.set([...currentChatHistoryArray]);

    let processedFullCurrentTextForParse = refs.removeSpeakerTags(fullCurrentText);
    processedFullCurrentTextForParse = refs.ensureNewlineAfterCodeBlock(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSpaceAfterTilde(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.removeIndentationFromCodeBlockMarkers(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.ensureSeparatorBetweenImgAndCode(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = refs.removeBoldMarkersAroundQuotes(processedFullCurrentTextForParse);
    const rawHtml = markedInstance.parse(processedFullCurrentTextForParse);
   refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
   // The full processRenderedContent includes all necessary post-processing.
   refs.processRenderedContent(contentDiv);
    uiHelper.scrollToBottom();
}

export function startStreamingMessage(message) {
    const { chatMessagesDiv, uiHelper } = refs;
    if (!message || !message.id) return null;

    let messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);

    if (!messageItem) {
        const placeholderMessage = { ...message, content: '', isThinking: false, timestamp: message.timestamp || Date.now(), isGroupMessage: message.isGroupMessage || false };
        messageItem = refs.renderMessage(placeholderMessage, false); 
        if (!messageItem) return null;
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

    if (historyIndex === -1) {
        currentChatHistoryArray.push({ ...message, content: initialContentForHistory, isThinking: false, timestamp: message.timestamp || Date.now(), isGroupMessage: message.isGroupMessage || false });
    } else {
        currentChatHistoryArray[historyIndex].isThinking = false;
        currentChatHistoryArray[historyIndex].content = initialContentForHistory;
        currentChatHistoryArray[historyIndex].timestamp = message.timestamp || Date.now();
        currentChatHistoryArray[historyIndex].name = message.name || currentChatHistoryArray[historyIndex].name;
        currentChatHistoryArray[historyIndex].agentId = message.agentId || currentChatHistoryArray[historyIndex].agentId;
        currentChatHistoryArray[historyIndex].isGroupMessage = message.isGroupMessage || currentChatHistoryArray[historyIndex].isGroupMessage || false;
    }
    refs.currentChatHistoryRef.set(currentChatHistoryArray);

    uiHelper.scrollToBottom();
    return messageItem;
}

export function appendStreamChunk(messageId, chunkData, agentNameForGroup, agentIdForGroup) {
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

    if (shouldEnableSmoothStreaming(messageId)) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue) {
            const chars = textToAppend.split('');
            for (const char of chars) queue.push(char);
        } else {
            renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup);
            return;
        }
        
        let currentAccumulated = accumulatedStreamText.get(messageId) || "";
        currentAccumulated += textToAppend;
        accumulatedStreamText.set(messageId, currentAccumulated);

        const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
        if (messageIndex > -1 && currentChatHistoryArray[messageIndex].isGroupMessage) {
            if (agentNameForGroup && !currentChatHistoryArray[messageIndex].name) currentChatHistoryArray[messageIndex].name = agentNameForGroup;
            if (agentIdForGroup && !currentChatHistoryArray[messageIndex].agentId) currentChatHistoryArray[messageIndex].agentId = agentIdForGroup;
        }
        refs.currentChatHistoryRef.set([...currentChatHistoryArray]);

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
                    
                    const finalHistory = refs.currentChatHistoryRef.get();
                    const finalMsgIdx = finalHistory.findIndex(m => m.id === messageId);
                    const completeAccumulatedText = accumulatedStreamText.get(messageId) || "";

                    if (finalMsgIdx > -1 && finalHistory[finalMsgIdx].content !== completeAccumulatedText) {
                        finalHistory[finalMsgIdx].content = completeAccumulatedText;
                        refs.currentChatHistoryRef.set([...finalHistory]);
                    }
                    
                    const textForFinalPass = completeAccumulatedText;

                    if (finalMessageItem) {
                        const finalContentDiv = finalMessageItem.querySelector('.md-content');
                        if (finalContentDiv && typeof textForFinalPass === 'string') {
                           // Clear any pending debounced timers since we are doing the final render now.
                           if (refs.enhancedRenderDebounceTimers.has(finalMessageItem)) {
                               clearTimeout(refs.enhancedRenderDebounceTimers.get(finalMessageItem));
                               refs.enhancedRenderDebounceTimers.delete(finalMessageItem);
                           }

                           // Perform the final, definitive render.
                           let processedText = refs.preprocessFullContent(textForFinalPass);
                           const rawHtml = refs.markedInstance.parse(processedText);
                           refs.setContentAndProcessImages(finalContentDiv, rawHtml, messageId);
                           
                           // Now, run the full, unified content processor.
                           refs.processRenderedContent(finalContentDiv);
                           
                           refs.uiHelper.scrollToBottom();
                       }
                    }
                    streamingChunkQueues.delete(messageId);
                    accumulatedStreamText.delete(messageId);
                }
            }, globalSettings.smoothStreamIntervalMs !== undefined && globalSettings.smoothStreamIntervalMs >= 1 ? globalSettings.smoothStreamIntervalMs : 25);
            streamingTimers.set(messageId, timerId);
        }
    } else {
        renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup);
    }
}

export async function finalizeStreamedMessage(messageId, finishReason, fullResponseText, agentNameForGroup, agentIdForGroup) {
    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = refs;
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicIdVal = refs.currentTopicIdRef.get();
    const currentChatHistoryArray = refs.currentChatHistoryRef.get();

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        if (streamingTimers.has(messageId)) {
            clearInterval(streamingTimers.get(messageId));
            streamingTimers.delete(messageId);
        }
        streamingChunkQueues.delete(messageId);
        accumulatedStreamText.delete(messageId);
        return;
    }

    // Always remove streaming and thinking classes on finalization, regardless of mode.
    messageItem.classList.remove('streaming', 'thinking');
    
    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    let finalFullTextForRender;

    if (messageIndex > -1) {
        const message = currentChatHistoryArray[messageIndex];
        message.finishReason = finishReason;
        message.isThinking = false;

        let authoritativeTextForHistory = message.content;

        if (typeof fullResponseText === 'string' && fullResponseText.trim() !== '') {
            const correctedText = fullResponseText.replace(/^重新生成中\.\.\./, '').trim();
            authoritativeTextForHistory = correctedText;
            if (shouldEnableSmoothStreaming(messageId)) {
                accumulatedStreamText.set(messageId, correctedText);
            }
        } else if (shouldEnableSmoothStreaming(messageId)) {
            const accumulated = accumulatedStreamText.get(messageId);
            if (typeof accumulated === 'string' && accumulated.length > 0) {
                authoritativeTextForHistory = accumulated;
            }
        }
        
        message.content = authoritativeTextForHistory;
        finalFullTextForRender = message.content;

        if (message.isGroupMessage) {
            message.name = agentNameForGroup || message.name;
            message.agentId = agentIdForGroup || message.agentId;
        }

        const nameTimeBlock = messageItem.querySelector('.name-time-block');
        if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
            const timestampDiv = document.createElement('div');
            timestampDiv.classList.add('message-timestamp');
            timestampDiv.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            nameTimeBlock.appendChild(timestampDiv);
        }

        if (message.role !== 'system' && !messageItem.classList.contains('thinking')) {
            messageItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                refs.showContextMenu(e, messageItem, message);
            });
        }
        
        refs.currentChatHistoryRef.set([...currentChatHistoryArray]);

        if (currentSelectedItem && currentSelectedItem.id && currentTopicIdVal) {
            const historyToSave = currentChatHistoryArray.filter(msg => !msg.isThinking);
            if (currentSelectedItem.type === 'agent') {
                await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicIdVal, historyToSave);
            } else if (currentSelectedItem.type === 'group' && electronAPI.saveGroupChatHistory) {
                await electronAPI.saveGroupChatHistory(currentSelectedItem.id, currentTopicIdVal, historyToSave);
            }
        }
    } else {
        if (shouldEnableSmoothStreaming(messageId)) {
            if (streamingTimers.has(messageId)) {
                clearInterval(streamingTimers.get(messageId));
                streamingTimers.delete(messageId);
            }
        }
        finalFullTextForRender = (typeof fullResponseText === 'string' && fullResponseText.trim() !== '')
                               ? fullResponseText.replace(/^重新生成中\.\.\./, '').trim()
                               : accumulatedStreamText.get(messageId) || `(消息 ${messageId} 历史记录未找到)`;
        const directContentDiv = messageItem.querySelector('.md-content');
        if(directContentDiv && (finishReason === 'error' || !fullResponseText || !shouldEnableSmoothStreaming(messageId))) {
             const rawHtml = markedInstance.parse(finalFullTextForRender);
             refs.setContentAndProcessImages(directContentDiv, rawHtml, messageId);
        }
    }
    
    if (!shouldEnableSmoothStreaming(messageId)) {
        const contentDiv = messageItem.querySelector('.md-content');
        if (contentDiv) {
            const thinkingIndicator = contentDiv.querySelector('.thinking-indicator, .streaming-indicator');
            if (thinkingIndicator) thinkingIndicator.remove();
            
            let textForNonSmoothRender = finalFullTextForRender;
            if (messageIndex > -1) {
                textForNonSmoothRender = currentChatHistoryArray[messageIndex].content;
            }

            let processedFinalText = refs.removeSpeakerTags(textForNonSmoothRender);
            processedFinalText = refs.ensureNewlineAfterCodeBlock(processedFinalText);
            processedFinalText = refs.ensureSpaceAfterTilde(processedFinalText);
            processedFinalText = refs.removeIndentationFromCodeBlockMarkers(processedFinalText);
            processedFinalText = refs.ensureSeparatorBetweenImgAndCode(processedFinalText);
            processedFinalText = refs.removeBoldMarkersAroundQuotes(processedFinalText);
           const rawHtml = markedInstance.parse(processedFinalText);
           refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
           
           // Use the full, unified content processor for the final render.
           refs.processRenderedContent(contentDiv);
       }
    }

    if (!shouldEnableSmoothStreaming(messageId)) {
        uiHelper.scrollToBottom();
    }
}

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage
};