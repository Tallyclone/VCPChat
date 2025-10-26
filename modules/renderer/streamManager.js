// modules/renderer/streamManager.js

// --- Stream State ---
const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
const accumulatedStreamText = new Map(); // messageId -> string
let activeStreamingMessageId = null; // Track the currently active streaming message

// --- DOM Cache ---
const messageDomCache = new Map(); // messageId -> { messageItem, contentDiv }

// --- Performance Caches & Throttling ---
const scrollThrottleTimers = new Map(); // messageId -> timerId
const SCROLL_THROTTLE_MS = 100; // 100ms 节流
const viewContextCache = new Map(); // messageId -> boolean (是否为当前视图)
let currentViewSignature = null; // 当前视图的签名
let globalRenderLoopRunning = false;

// --- 新增：预缓冲系统 ---
const preBufferedChunks = new Map(); // messageId -> array of chunks waiting for initialization
const messageInitializationStatus = new Map(); // messageId -> 'pending' | 'ready' | 'finalized'

// --- 新增：消息上下文映射 ---
const messageContextMap = new Map(); // messageId -> {agentId, groupId, topicId, isGroupMessage}

// --- Local Reference Store ---
let refs = {};

// --- Pre-compiled Regular Expressions for Performance ---
const SPEAKER_TAG_REGEX = /^\[(?:(?!\]:\s).)*的发言\]:\s*/gm;
const NEWLINE_AFTER_CODE_REGEX = /^(\s*```)(?![\r\n])/gm;
const SPACE_AFTER_TILDE_REGEX = /(^|[^\w/\\=])~(?![\s~])/g;
const CODE_MARKER_INDENT_REGEX = /^(\s*)(```.*)/gm;
const IMG_CODE_SEPARATOR_REGEX = /(<img[^>]+>)\s*(```)/g;

/**
 * Initializes the Stream Manager with necessary dependencies from the main renderer.
 * @param {object} dependencies - An object containing all required functions and references.
 */
export function initStreamManager(dependencies) {
    refs = dependencies;
    // Assume morphdom is passed in dependencies, warn if not present.
    if (!refs.morphdom) {
        console.warn('[StreamManager] `morphdom` not provided. Streaming rendering will fall back to inefficient innerHTML updates.');
    }
}

function shouldEnableSmoothStreaming() {
    const globalSettings = refs.globalSettingsRef.get();
    return globalSettings.enableSmoothStreaming === true;
}

function messageIsFinalized(messageId) {
    // Don't rely on current history, check accumulated state
    const initStatus = messageInitializationStatus.get(messageId);
    return initStatus === 'finalized';
}

/**
 * 🟢 生成当前视图的唯一签名
 */
function getCurrentViewSignature() {
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicId = refs.currentTopicIdRef.get();
    return `${currentSelectedItem?.id || 'none'}-${currentTopicId || 'none'}`;
}

/**
 * 🟢 带缓存的视图检查
 */
function isMessageForCurrentView(context) {
    if (!context) return false;
    
    const newSignature = getCurrentViewSignature();
    
    // 如果视图切换了，清空缓存
    if (currentViewSignature !== newSignature) {
        currentViewSignature = newSignature;
        viewContextCache.clear();
    }
    
    const currentSelectedItem = refs.currentSelectedItemRef.get();
    const currentTopicId = refs.currentTopicIdRef.get();
    
    if (!currentSelectedItem || !currentTopicId) return false;
    
    const itemId = context.groupId || context.agentId;
    return itemId === currentSelectedItem.id && context.topicId === currentTopicId;
}

async function getHistoryForContext(context) {
    const { electronAPI } = refs;
    if (!context) return null;
    
    const { agentId, groupId, topicId, isGroupMessage } = context;
    const itemId = groupId || agentId;
    
    if (!itemId || !topicId) return null;
    
    try {
        const historyResult = isGroupMessage
            ? await electronAPI.getGroupChatHistory(itemId, topicId)
            : await electronAPI.getChatHistory(itemId, topicId);
        
        if (historyResult && !historyResult.error) {
            return historyResult;
        }
    } catch (e) {
        console.error(`[StreamManager] Failed to get history for context`, context, e);
    }
    
    return null;
}

// 🟢 历史保存防抖
const historySaveQueue = new Map(); // context signature -> {context, history, timerId}
const HISTORY_SAVE_DEBOUNCE = 1000; // 1秒防抖

async function debouncedSaveHistory(context, history) {
    if (!context || context.topicId === 'assistant_chat' || context.topicId?.startsWith('voicechat_')) {
        return; // 跳过临时聊天
    }
    
    const signature = `${context.groupId || context.agentId}-${context.topicId}`;
    
    // 清除之前的定时器
    const existing = historySaveQueue.get(signature);
    if (existing?.timerId) {
        clearTimeout(existing.timerId);
    }
    
    // 设置新的防抖定时器
    const timerId = setTimeout(async () => {
        const queuedData = historySaveQueue.get(signature);
        if (queuedData) {
            await saveHistoryForContext(queuedData.context, queuedData.history);
            historySaveQueue.delete(signature);
        }
    }, HISTORY_SAVE_DEBOUNCE);
    
    // 使用最新的 history 克隆以避免引用问题
    historySaveQueue.set(signature, { context, history: [...history], timerId });
}

async function saveHistoryForContext(context, history) {
    const { electronAPI } = refs;
    if (!context || context.isGroupMessage) {
        // For group messages, the main process (groupchat.js) is the single source of truth for history.
        // The renderer avoids saving to prevent race conditions and overwriting the correct history.
        return;
    }
    
    const { agentId, topicId } = context;
    
    if (!agentId || !topicId) return;
    
    const historyToSave = history.filter(msg => !msg.isThinking);
    
    try {
        await electronAPI.saveChatHistory(agentId, topicId, historyToSave);
    } catch (e) {
        console.error(`[StreamManager] Failed to save history for context`, context, e);
    }
}

/**
 * 批量应用流式渲染所需的轻量级预处理
 * 减少函数调用开销
 */
function applyStreamingPreprocessors(text) {
    if (!text) return '';
    
    // 🟢 重置 lastIndex（全局正则）
    SPEAKER_TAG_REGEX.lastIndex = 0;
    NEWLINE_AFTER_CODE_REGEX.lastIndex = 0;
    SPACE_AFTER_TILDE_REGEX.lastIndex = 0;
    CODE_MARKER_INDENT_REGEX.lastIndex = 0;
    IMG_CODE_SEPARATOR_REGEX.lastIndex = 0;
    
    return text
        .replace(SPEAKER_TAG_REGEX, '')
        .replace(NEWLINE_AFTER_CODE_REGEX, '$1\n')
        .replace(SPACE_AFTER_TILDE_REGEX, '$1~ ')
        .replace(CODE_MARKER_INDENT_REGEX, '$2')
        .replace(IMG_CODE_SEPARATOR_REGEX, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2');
}

/**
 * 获取或缓存消息的 DOM 引用
 */
function getCachedMessageDom(messageId) {
    let cached = messageDomCache.get(messageId);
    
    if (cached) {
        // 验证缓存是否仍然有效（元素还在 DOM 中）
        if (cached.messageItem.isConnected) {
            return cached;
        }
        // 缓存失效，删除
        messageDomCache.delete(messageId);
    }
    
    // 重新查询并缓存
    const { chatMessagesDiv } = refs;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    
    if (!messageItem) return null;
    
    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return null;
    
    cached = { messageItem, contentDiv };
    messageDomCache.set(messageId, cached);
    
    return cached;
}

/**
 * Renders a single frame of the streaming message using morphdom for efficient DOM updates.
 * This version performs minimal processing to keep it fast and avoid destroying JS state.
 * @param {string} messageId The ID of the message.
 */
function renderStreamFrame(messageId) {
    // 🟢 优先使用缓存
    let isForCurrentView = viewContextCache.get(messageId);
    
    // 如果没有缓存（可能是旧消息），回退到实时检查
    if (isForCurrentView === undefined) {
        const context = messageContextMap.get(messageId);
        isForCurrentView = isMessageForCurrentView(context);
        viewContextCache.set(messageId, isForCurrentView);
    }
    
    if (!isForCurrentView) return;

    // 🟢 使用缓存的 DOM 引用
    const cachedDom = getCachedMessageDom(messageId);
    if (!cachedDom) return;
    
    const { contentDiv } = cachedDom;

    const textForRendering = accumulatedStreamText.get(messageId) || "";

    // 移除思考指示器
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    // 🟢 使用批量处理函数
    const processedText = applyStreamingPreprocessors(textForRendering);
    const rawHtml = refs.markedInstance.parse(processedText);

    if (refs.morphdom) {
        refs.morphdom(contentDiv, `<div>${rawHtml}</div>`, {
            childrenOnly: true,
            // 🟢 添加性能优化配置
            onBeforeElUpdated: function(fromEl, toEl) {
                // 跳过没有变化的元素
                if (fromEl.isEqualNode(toEl)) {
                    return false;
                }
                return true;
            }
        });
    } else {
        contentDiv.innerHTML = rawHtml;
    }
}

/**
 * 🟢 节流版本的滚动函数
 */
function throttledScrollToBottom(messageId) {
    if (scrollThrottleTimers.has(messageId)) {
        return; // 节流期间，跳过
    }
    
    refs.uiHelper.scrollToBottom();
    
    const timerId = setTimeout(() => {
        scrollThrottleTimers.delete(messageId);
    }, SCROLL_THROTTLE_MS);
    
    scrollThrottleTimers.set(messageId, timerId);
}

function processAndRenderSmoothChunk(messageId) {
    const queue = streamingChunkQueues.get(messageId);
    if (!queue || queue.length === 0) return;

    const globalSettings = refs.globalSettingsRef.get();
    const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;

    // Drain a small batch from the queue. The rendering uses the accumulated text,
    // so we don't need the return value here. This just advances the stream.
    let processedChars = 0;
    while (queue.length > 0 && processedChars < minChunkSize) {
        processedChars += queue.shift().length;
    }

    // Render the current state of the accumulated text using our lightweight method.
    renderStreamFrame(messageId);
    
    // Scroll if the message is in the current view.
    const context = messageContextMap.get(messageId);
    if (isMessageForCurrentView(context)) {
        throttledScrollToBottom(messageId);
    }
}

function renderChunkDirectlyToDOM(messageId, textToAppend) {
    // For non-smooth streaming, we just render the new frame immediately using the lightweight method.
    // The check for whether it's in the current view is handled inside renderStreamFrame.
    renderStreamFrame(messageId);
}

export async function startStreamingMessage(message, passedMessageItem = null) {
    const messageId = message.id;
    
    // Store the context for this message - ensure proper context structure
    const context = {
        agentId: message.agentId || message.context?.agentId || (message.isGroupMessage ? undefined : refs.currentSelectedItemRef.get()?.id),
        groupId: message.groupId || message.context?.groupId || (message.isGroupMessage ? refs.currentSelectedItemRef.get()?.id : undefined),
        topicId: message.topicId || message.context?.topicId || refs.currentTopicIdRef.get(),
        isGroupMessage: message.isGroupMessage || message.context?.isGroupMessage || false,
        agentName: message.name || message.context?.agentName,
        avatarUrl: message.avatarUrl || message.context?.avatarUrl,
        avatarColor: message.avatarColor || message.context?.avatarColor,
    };
    
    // Validate context
    if (!context.topicId || (!context.agentId && !context.groupId)) {
        console.error(`[StreamManager] Invalid context for message ${messageId}`, context);
        return null;
    }
    
    messageContextMap.set(messageId, context);
    messageInitializationStatus.set(messageId, 'pending');
    activeStreamingMessageId = messageId;
    
    const { chatMessagesDiv, electronAPI, currentChatHistoryRef, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(context);
    // 🟢 缓存视图检查结果
    viewContextCache.set(messageId, isForCurrentView);
    
    // Get the correct history for this message's context
    let historyForThisMessage;
    // For assistant chat, always use a temporary in-memory history
    if (context.topicId === 'assistant_chat') {
        historyForThisMessage = currentChatHistoryRef.get();
    } else if (isForCurrentView) {
        // For current view, use in-memory history
        historyForThisMessage = currentChatHistoryRef.get();
    } else {
        // For background chats, load from disk
        historyForThisMessage = await getHistoryForContext(context);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for background message ${messageId}`, context);
            messageInitializationStatus.set(messageId, 'finalized');
            return null;
        }
    }
    
    // Only manipulate DOM for current view
    let messageItem = null;
    if (isForCurrentView) {
        messageItem = passedMessageItem || chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
        if (!messageItem) {
            const placeholderMessage = { 
                ...message, 
                content: message.content || '思考中...', // Show thinking text initially
                isThinking: true, // Mark as thinking
                timestamp: message.timestamp || Date.now(), 
                isGroupMessage: message.isGroupMessage || false 
            };
            messageItem = refs.renderMessage(placeholderMessage, false);
            if (!messageItem) {
                console.error(`[StreamManager] Failed to render message item for ${message.id}`);
                messageInitializationStatus.set(messageId, 'finalized');
                return null;
            }
        }
        // Add streaming class and remove thinking class when we have a valid messageItem
        if (messageItem && messageItem.classList) {
            messageItem.classList.add('streaming');
            messageItem.classList.remove('thinking');
        }
    }
    
    // Initialize streaming state
    if (shouldEnableSmoothStreaming()) {
        streamingChunkQueues.set(messageId, []);
    }
    accumulatedStreamText.set(messageId, '');
    
    // Prepare placeholder for history
    const placeholderForHistory = {
        ...message,
        content: '',
        isThinking: false,
        timestamp: message.timestamp || Date.now(),
        isGroupMessage: context.isGroupMessage,
        name: context.agentName,
        agentId: context.agentId
    };
    
    // Update the appropriate history
    const historyIndex = historyForThisMessage.findIndex(m => m.id === message.id);
    if (historyIndex === -1) {
        historyForThisMessage.push(placeholderForHistory);
    } else {
        historyForThisMessage[historyIndex] = { ...historyForThisMessage[historyIndex], ...placeholderForHistory };
    }
    
    // Save the history
    if (isForCurrentView) {
        // Update in-memory reference for current view
        currentChatHistoryRef.set([...historyForThisMessage]);
    }
    
    // 🟢 使用防抖保存
    if (context.topicId !== 'assistant_chat' && !context.topicId.startsWith('voicechat_')) {
        debouncedSaveHistory(context, historyForThisMessage);
    }
    
    // Initialization is complete, message is ready to process chunks.
    messageInitializationStatus.set(messageId, 'ready');
    
    // Process any chunks that were pre-buffered during initialization.
    const bufferedChunks = preBufferedChunks.get(messageId);
    if (bufferedChunks && bufferedChunks.length > 0) {
        console.log(`[StreamManager] Processing ${bufferedChunks.length} pre-buffered chunks for message ${messageId}`);
        for (const chunkData of bufferedChunks) {
            appendStreamChunk(messageId, chunkData.chunk, chunkData.context);
        }
        preBufferedChunks.delete(messageId);
    }
    
    if (isForCurrentView) {
        uiHelper.scrollToBottom();
    }
    
    return messageItem;
}

// 🟢 全局渲染循环（替代每个消息一个 interval）
function startGlobalRenderLoop() {
    if (globalRenderLoopRunning) return;
    
    globalRenderLoopRunning = true;
    
    function renderLoop() {
        if (streamingTimers.size === 0) {
            // 没有活动的流式消息，停止循环
            globalRenderLoopRunning = false;
            return;
        }
        
        // 处理所有活动的流式消息
        for (const [messageId, _] of streamingTimers) {
            processAndRenderSmoothChunk(messageId);
            
            const currentQueue = streamingChunkQueues.get(messageId);
            if ((!currentQueue || currentQueue.length === 0) && messageIsFinalized(messageId)) {
                streamingTimers.delete(messageId);
                
                const storedContext = messageContextMap.get(messageId);
                const isForCurrentView = viewContextCache.get(messageId) ?? isMessageForCurrentView(storedContext);
                
                if (isForCurrentView) {
                    const finalMessageItem = getCachedMessageDom(messageId)?.messageItem;
                    if (finalMessageItem) finalMessageItem.classList.remove('streaming');
                }
                
                streamingChunkQueues.delete(messageId);
            }
        }
        
        // 使用 rAF 而不是固定间隔，更流畅
        requestAnimationFrame(renderLoop);
    }
    
    requestAnimationFrame(renderLoop);
}

/**
 * 🟢 智能分块策略：按语义单位（词/短语）拆分，而非字符
 */
function intelligentChunkSplit(text) {
    const chunks = [];
    
    // 使用正则表达式按有意义的单位拆分
    // 优先保持：英文单词、中文词组、标点符号组
    const regex = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9\s]+|\s+/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
        chunks.push(match[0]);
    }
    
    return chunks;
}

export function appendStreamChunk(messageId, chunkData, context) {
    const initStatus = messageInitializationStatus.get(messageId);
    
    if (!initStatus || initStatus === 'pending') {
        if (!preBufferedChunks.has(messageId)) {
            preBufferedChunks.set(messageId, []);
            // 只在第一次创建缓冲区时打印日志
            console.log(`[StreamManager] Started pre-buffering for message ${messageId}`);
        }
        const buffer = preBufferedChunks.get(messageId);
        buffer.push({ chunk: chunkData, context });
        
        // 防止缓冲区无限增长 - 如果超过1000个chunks，可能有问题
        if (buffer.length > 1000) {
            console.error(`[StreamManager] Pre-buffer overflow for message ${messageId}! Forcing initialization...`);
            // 强制设置为ready状态以开始处理
            messageInitializationStatus.set(messageId, 'ready');
            // 处理缓冲的chunks
            for (const bufferedData of buffer) {
                appendStreamChunk(messageId, bufferedData.chunk, bufferedData.context);
            }
            preBufferedChunks.delete(messageId);
        }
        return;
    }
    
    if (initStatus === 'finalized') {
        console.warn(`[StreamManager] Received chunk for already finalized message ${messageId}. Ignoring.`);
        return;
    }
    
    // Extract text from chunk
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
    
    // Always maintain accumulated text
    let currentAccumulated = accumulatedStreamText.get(messageId) || "";
    currentAccumulated += textToAppend;
    accumulatedStreamText.set(messageId, currentAccumulated);
    
    // Update context if provided
    if (context) {
        const storedContext = messageContextMap.get(messageId);
        if (storedContext) {
            if (context.agentName) storedContext.agentName = context.agentName;
            if (context.agentId) storedContext.agentId = context.agentId;
            messageContextMap.set(messageId, storedContext);
        }
    }
    
    if (shouldEnableSmoothStreaming()) {
        const queue = streamingChunkQueues.get(messageId);
        if (queue) {
            // 🟢 新代码：智能分块
            const semanticChunks = intelligentChunkSplit(textToAppend);
            for (const chunk of semanticChunks) {
                queue.push(chunk);
            }
        } else {
            renderChunkDirectlyToDOM(messageId, textToAppend);
            return;
        }
        
        // 🟢 使用全局循环替代单独的定时器
        if (!streamingTimers.has(messageId)) {
            streamingTimers.set(messageId, true); // 只是标记，不存储实际的 timerId
            startGlobalRenderLoop(); // 启动或确保全局循环正在运行
        }
    } else {
        renderChunkDirectlyToDOM(messageId, textToAppend);
    }
}

export async function finalizeStreamedMessage(messageId, finishReason, context) {
    // With the global render loop, we no longer need to manually drain the queue here or clear timers.
    // The loop will continue to process chunks until the queue is empty and the message is finalized, then clean itself up.
    if (activeStreamingMessageId === messageId) {
        activeStreamingMessageId = null;
    }
    
    // 🟢 清理节流定时器
    const scrollTimer = scrollThrottleTimers.get(messageId);
    if (scrollTimer) {
        clearTimeout(scrollTimer);
        scrollThrottleTimers.delete(messageId);
    }
    
    messageInitializationStatus.set(messageId, 'finalized');
    
    // Get the stored context for this message
    const storedContext = messageContextMap.get(messageId) || context;
    if (!storedContext) {
        console.error(`[StreamManager] No context available for message ${messageId}`);
        return;
    }
    
    const { chatMessagesDiv, markedInstance, uiHelper } = refs;
    const isForCurrentView = isMessageForCurrentView(storedContext);
    
    // Get the correct history
    let historyForThisMessage;
    // For assistant chat, always use the in-memory history from the ref
    if (storedContext.topicId === 'assistant_chat') {
        historyForThisMessage = refs.currentChatHistoryRef.get();
    } else {
        // For all other chats, always fetch the latest history from the source of truth
        // to avoid race conditions with the UI state (currentChatHistoryRef).
        historyForThisMessage = await getHistoryForContext(storedContext);
        if (!historyForThisMessage) {
            console.error(`[StreamManager] Could not load history for finalization`, storedContext);
            return;
        }
    }
    
    // Find and update the message
    const finalFullText = accumulatedStreamText.get(messageId) || "";
    const messageIndex = historyForThisMessage.findIndex(msg => msg.id === messageId);
    
    if (messageIndex === -1) {
        // If it's an assistant chat and the message is not found,
        // it's likely the window was reset. Ignore gracefully.
        if (storedContext && storedContext.topicId === 'assistant_chat') {
            console.warn(`[StreamManager] Message ${messageId} not found in assistant history, likely due to reset. Ignoring.`);
            // Clean up just in case
            streamingChunkQueues.delete(messageId);
            accumulatedStreamText.delete(messageId);
            return;
        }
        console.error(`[StreamManager] Message ${messageId} not found in history`, storedContext);
        return;
    }
    
    const message = historyForThisMessage[messageIndex];
    message.content = finalFullText;
    message.finishReason = finishReason;
    message.isThinking = false;
    if (message.isGroupMessage && storedContext) {
        message.name = storedContext.agentName || message.name;
        message.agentId = storedContext.agentId || message.agentId;
    }
    
    // Update UI if it's the current view
    if (isForCurrentView) {
        refs.currentChatHistoryRef.set([...historyForThisMessage]);
        
        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.remove('streaming', 'thinking');
            
            const contentDiv = messageItem.querySelector('.md-content');
            if (contentDiv) {
                const globalSettings = refs.globalSettingsRef.get();
                // Use the more thorough preprocessFullContent for the final render
                const processedFinalText = refs.preprocessFullContent(finalFullText, globalSettings);
                const rawHtml = markedInstance.parse(processedFinalText);
                
                // Perform the final, high-quality render using the original global refresh method.
                // This ensures images, KaTeX, code highlighting, etc., are all processed correctly.
                refs.setContentAndProcessImages(contentDiv, rawHtml, messageId);
                
                // Step 1: Run synchronous processors (KaTeX, hljs, etc.)
                refs.processRenderedContent(contentDiv);

                // Step 2: Defer TreeWalker-based highlighters to ensure DOM is stable
                setTimeout(() => {
                    if (contentDiv && contentDiv.isConnected) {
                        refs.runTextHighlights(contentDiv);
                    }
                }, 0);

                // Step 3: Process animations
                if (globalSettings.enableAgentBubbleTheme && refs.processAnimationsInContent) {
                    refs.processAnimationsInContent(contentDiv);
                }
            }
            
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
            
            uiHelper.scrollToBottom();
        }
    }
    
    // 🟢 使用防抖保存
    if (storedContext.topicId !== 'assistant_chat') {
        debouncedSaveHistory(storedContext, historyForThisMessage);
    }
    
    // Cleanup
    streamingChunkQueues.delete(messageId);
    accumulatedStreamText.delete(messageId);
    
    // Delayed cleanup
    setTimeout(() => {
        messageDomCache.delete(messageId);
        messageInitializationStatus.delete(messageId);
        preBufferedChunks.delete(messageId);
        messageContextMap.delete(messageId);
        viewContextCache.delete(messageId);
    }, 5000);
}

// Expose to global scope for classic scripts
window.streamManager = {
    initStreamManager,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    getActiveStreamingMessageId: () => activeStreamingMessageId,
    isMessageInitialized: (messageId) => {
        // Check if message is being tracked by streamManager
        return messageInitializationStatus.has(messageId);
    }
};
