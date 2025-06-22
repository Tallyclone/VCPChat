// modules/renderer/imageHandler.js

// This map holds the loading state for images within each message,
// preventing re-loading and solving the placeholder flicker issue during streaming.
// Structure: Map<messageId, Map<uniqueImageKey, { status: 'loading'|'loaded'|'error', element?: HTMLImageElement }>>
// uniqueImageKey is `${src}-${index}` to handle duplicate images in the same message.
const messageImageStates = new Map();

let imageHandlerRefs = {
    electronAPI: null,
    uiHelper: null,
    chatMessagesDiv: null,
};

export function initializeImageHandler(refs) {
    imageHandlerRefs.electronAPI = refs.electronAPI;
    imageHandlerRefs.uiHelper = refs.uiHelper;
    imageHandlerRefs.chatMessagesDiv = refs.chatMessagesDiv;
    console.log("[ImageHandler] Initialized.");
}

/**
 * 将内容设置到DOM元素，并处理其中的图片。
 * 此函数现在管理一个持久化的图片加载状态，以防止在流式渲染中重复加载和闪烁。
 * @param {HTMLElement} contentDiv - 要设置内容的DOM元素。
 * @param {string} rawHtml - 经过marked.parse()处理的原始HTML。
 * @param {string} messageId - 消息ID。
 */
export function setContentAndProcessImages(contentDiv, rawHtml, messageId) {
    // 确保该消息有一个图片状态Map
    if (!messageImageStates.has(messageId)) {
        messageImageStates.set(messageId, new Map());
    }
    const imageStates = messageImageStates.get(messageId);
    let imageCounter = 0;

    // 1. 替换HTML中的<img>标签，并启动新图片的加载过程
    const processedHtml = rawHtml.replace(/<img[^>]+>/g, (imgTagString) => {
        const srcMatch = imgTagString.match(/src="([^"]+)"/);
        if (!srcMatch) return ''; // 忽略没有src的标签
        const src = srcMatch[1];

       const uniqueImageKey = `${src}-${imageCounter}`;
       const placeholderId = `img-placeholder-${messageId}-${imageCounter}`;
       imageCounter++;

       const state = imageStates.get(uniqueImageKey);

       // 如果图片已经加载成功，直接返回最终的<img>元素字符串
       if (state && state.status === 'loaded' && state.element) {
           return state.element.outerHTML;
       }

       // 如果图片加载失败，返回错误占位符
       if (state && state.status === 'error') {
           return `<div class="image-placeholder" style="min-height: 50px; display: flex; align-items: center; justify-content: center;">图片加载失败</div>`;
       }

       const widthMatch = imgTagString.match(/width="([^"]+)"/);
       const displayWidth = widthMatch ? parseInt(widthMatch[1], 10) : 200;

       // 如果是新图片，则启动加载
       if (!state) {
           imageStates.set(uniqueImageKey, { status: 'loading' });

           const imageLoader = new Image();
            imageLoader.src = src;

            imageLoader.onload = () => {
                const aspectRatio = imageLoader.naturalHeight / imageLoader.naturalWidth;
                const displayHeight = displayWidth * aspectRatio;

                const finalImage = document.createElement('img');
                finalImage.src = src;
                finalImage.width = displayWidth;
                finalImage.style.height = `${displayHeight}px`;
                finalImage.style.cursor = 'pointer';
                finalImage.title = `点击在新窗口预览: ${finalImage.alt || src}\n右键可复制图片`;
                finalImage.addEventListener('click', (e) => {
                    e.stopPropagation();
                    imageHandlerRefs.electronAPI.openImageInNewWindow(src, finalImage.alt || src.split('/').pop() || 'AI 图片');
                });
                finalImage.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    imageHandlerRefs.electronAPI.showImageContextMenu(src);
                });

               // 更新状态
               const currentState = imageStates.get(uniqueImageKey);
               if (currentState) {
                   currentState.status = 'loaded';
                   currentState.element = finalImage;
               }

                // 替换DOM中的占位符 - 使用更智能的替换策略
                const placeholder = document.getElementById(placeholderId);
                if (placeholder && document.body.contains(placeholder)) {
                    // 检查占位符是否仍在正确的消息容器中
                    const messageContainer = placeholder.closest('.message-item');
                    if (messageContainer && messageContainer.dataset.messageId === messageId) {
                        placeholder.replaceWith(finalImage);
                        const chatContainer = imageHandlerRefs.chatMessagesDiv;
                        const isScrolledToBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 150;
                        if (isScrolledToBottom) {
                            imageHandlerRefs.uiHelper.scrollToBottom();
                        }
                    }
                }
            };

           imageLoader.onerror = () => {
               const currentState = imageStates.get(uniqueImageKey);
               if (currentState) {
                   currentState.status = 'error';
               }
                const placeholder = document.getElementById(placeholderId);
                if (placeholder && document.body.contains(placeholder)) {
                    const messageContainer = placeholder.closest('.message-item');
                    if (messageContainer && messageContainer.dataset.messageId === messageId) {
                        placeholder.textContent = '图片加载失败';
                        placeholder.style.minHeight = 'auto';
                    }
                }
            };
        }

        // 返回占位符
        return `<div id="${placeholderId}" class="image-placeholder" style="width: ${displayWidth}px; min-height: 100px;"></div>`;
    });

    // 2. 直接更新DOM内容
    // 简化逻辑：直接设置innerHTML。
    // 图片的加载和替换由其自身的onload回调处理，这使得该过程独立于messageRenderer的重绘。
    // 只要messageImageStates是持久的，即使innerHTML被多次重写，
    // 正在加载的图片状态也不会丢失。当图片加载完成时，它会找到正确的占位符并替换自己。
    contentDiv.innerHTML = processedHtml;
}

// Function to clear image state for a specific message
export function clearImageState(messageId) {
    messageImageStates.delete(messageId);
}

// Function to clear all image states
export function clearAllImageStates() {
    messageImageStates.clear();
}