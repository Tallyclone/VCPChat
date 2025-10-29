// modules/renderer/imageHandler.js
import { fixEmoticonUrl } from './emoticonUrlFixer.js';
 
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
    if (!messageImageStates.has(messageId)) {
        messageImageStates.set(messageId, new Map());
    }
    const imageStates = messageImageStates.get(messageId);
    let imageCounter = 0;
    const loadedImagesToReplace = [];

    const processedHtml = rawHtml.replace(/<img[^>]+>/g, (imgTagString) => {
        const srcMatch = imgTagString.match(/src="([^"]+)"/);
        if (!srcMatch) return '';
        
        let src = srcMatch[1];
        
        // 🟢 第三层兜底：如果前面都没修复成功，这里再修复一次
        if (fixEmoticonUrl && src.includes('表情包')) {
            const fixedSrc = fixEmoticonUrl(src);
            if (fixedSrc !== src) {
                console.warn(`[ImageHandler兜底] 前置修复遗漏，补救修复: ${src}`);
                src = fixedSrc;
            }
        }

        const uniqueImageKey = `${src}-${imageCounter}`;
        const placeholderId = `img-placeholder-${messageId}-${imageCounter}`;
        imageCounter++;

        const state = imageStates.get(uniqueImageKey);

        if (state && state.status === 'loaded' && state.element) {
            loadedImagesToReplace.push({ placeholderId, element: state.element });
            return `<div id="${placeholderId}" class="image-placeholder-ready"></div>`;
        }

        if (state && state.status === 'error') {
            return `<div class="image-placeholder" style="min-height: 50px; display: flex; align-items: center; justify-content: center;">图片加载失败</div>`;
        }

        // 🟢 提取所有可能的属性
        const widthMatch = imgTagString.match(/width="([^"]+)"/);
        const heightMatch = imgTagString.match(/height="([^"]+)"/);
        const styleMatch = imgTagString.match(/style="([^"]+)"/);
        const classMatch = imgTagString.match(/class="([^"]+)"/);
        const altMatch = imgTagString.match(/alt="([^"]+)"/);
        
        const displayWidth = widthMatch ? parseInt(widthMatch[1], 10) : 200;

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
                
                // 🟢 保留原始 style 属性
                if (styleMatch) {
                    finalImage.setAttribute('style', styleMatch[1]);
                }
                
                // 🟢 设置高度（如果原始没有指定 style）
                if (!styleMatch || !styleMatch[1].includes('height')) {
                    finalImage.style.height = `${displayHeight}px`;
                }
                
                // 🟢 保留其他属性
                if (heightMatch) {
                    finalImage.height = parseInt(heightMatch[1], 10);
                }
                if (classMatch) {
                    finalImage.className = classMatch[1];
                }
                if (altMatch) {
                    finalImage.alt = altMatch[1];
                }
                
                // 添加交互样式（不覆盖原有 cursor）
                if (!styleMatch || !styleMatch[1].includes('cursor')) {
                    finalImage.style.cursor = 'pointer';
                }
                
                finalImage.title = `点击在新窗口预览: ${finalImage.alt || src}\n右键可复制图片`;
                
                finalImage.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    imageHandlerRefs.electronAPI.openImageViewer({
                        src: src,
                        title: finalImage.alt || src.split('/').pop() || 'AI 图片',
                        theme: currentTheme
                    });
                });

                finalImage.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); 
                    e.stopPropagation();
                    imageHandlerRefs.electronAPI.showImageContextMenu(src);
                });

                const currentState = imageStates.get(uniqueImageKey);
                if (currentState) {
                    currentState.status = 'loaded';
                    currentState.element = finalImage;
                }

                const placeholder = document.getElementById(placeholderId);
                if (placeholder && document.body.contains(placeholder)) {
                    const messageContainer = placeholder.closest('.message-item');
                    if (messageContainer && messageContainer.dataset.messageId === messageId) {
                        placeholder.replaceWith(finalImage);
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

        return `<div id="${placeholderId}" class="image-placeholder" style="width: ${displayWidth}px; min-height: 100px;"></div>`;
    });

    contentDiv.innerHTML = processedHtml;

    if (loadedImagesToReplace.length > 0) {
        for (const item of loadedImagesToReplace) {
            const placeholder = document.getElementById(item.placeholderId);
            if (placeholder) {
                placeholder.replaceWith(item.element);
            }
        }
    }
}
// Function to clear image state for a specific message
export function clearImageState(messageId) {
    messageImageStates.delete(messageId);
}

// Function to clear all image states
export function clearAllImageStates() {
    messageImageStates.clear();
}