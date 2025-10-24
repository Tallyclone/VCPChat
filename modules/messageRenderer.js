// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { initializeImageHandler, setContentAndProcessImages, clearImageState, clearAllImageStates } from './renderer/imageHandler.js';
import { processAnimationsInContent } from './renderer/animation.js';
import { createMessageSkeleton } from './renderer/domBuilder.js';
import * as streamManager from './renderer/streamManager.js';
import * as emoticonUrlFixer from './renderer/emoticonUrlFixer.js';


import * as contentProcessor from './renderer/contentProcessor.js';
import * as contextMenu from './renderer/messageContextMenu.js';


// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
   try {
       const existingStyleElement = document.getElementById('vcp-enhanced-ui-styles');
       if (existingStyleElement) {
           // Style element already exists, no need to recreate
           return;
       }

       // Create link element to load external CSS
       const linkElement = document.createElement('link');
       linkElement.id = 'vcp-enhanced-ui-styles';
       linkElement.rel = 'stylesheet';
       linkElement.type = 'text/css';
       linkElement.href = 'styles/messageRenderer.css';
       document.head.appendChild(linkElement);

       // console.log('VCPSub Enhanced UI: External styles loaded.'); // Reduced logging
   } catch (error) {
       console.error('VCPSub Enhanced UI: Failed to load external styles:', error);
   }
}

// --- Core Logic ---

/**
 * A helper function to escape HTML special characters.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#039;');
}

/**
 * Generates a unique ID for scoping CSS.
 * @returns {string} A unique ID string (e.g., 'vcp-bubble-1a2b3c4d').
 */
function generateUniqueId() {
    // Use a combination of timestamp and random string for uniqueness
    const timestampPart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 9);
    return `vcp-bubble-${timestampPart}${randomPart}`;
}

/**
 * Renders Mermaid diagrams found within a given container.
 * Finds placeholders, replaces them with the actual Mermaid code,
 * and then calls the Mermaid API to render them.
 * @param {HTMLElement} container The container element to search within.
 */
async function renderMermaidDiagrams(container) {
    const placeholders = Array.from(container.querySelectorAll('.mermaid-placeholder'));
    if (placeholders.length === 0) return;

    // Prepare elements for rendering
    placeholders.forEach(placeholder => {
        const code = placeholder.dataset.mermaidCode;
        if (code) {
            try {
                // The placeholder div itself will become the mermaid container
                placeholder.textContent = decodeURIComponent(code);
                placeholder.classList.remove('mermaid-placeholder');
                placeholder.classList.add('mermaid');
            } catch (e) {
                console.error('Failed to decode mermaid code', e);
                placeholder.textContent = '[Mermaid code decoding error]';
            }
        }
    });

    // Get the list of actual .mermaid elements to render
    const elementsToRender = placeholders.filter(el => el.classList.contains('mermaid'));

    if (elementsToRender.length > 0 && typeof mermaid !== 'undefined') {
        try {
            // Initialize mermaid if it hasn't been already
            mermaid.initialize({ startOnLoad: false });
            await mermaid.run({ nodes: elementsToRender });
        } catch (error) {
            console.error("Error rendering Mermaid diagrams:", error);
            elementsToRender.forEach(el => {
                const originalCode = el.textContent;
                el.innerHTML = `<div class="mermaid-error">Mermaid render error: ${error.message}</div><pre>${escapeHtml(originalCode)}</pre>`;
            });
        }
    }
}

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
 * 应用所有匹配的正则规则到文本（前端版本）
 * @param {string} text - 输入文本
 * @param {Array} rules - 正则规则数组
 * @param {string} role - 消息角色 ('user' 或 'assistant')
 * @param {number} depth - 消息深度（0 = 最新消息）
 * @returns {string} 处理后的文本
 */
function applyFrontendRegexRules(text, rules, role, depth) {
    if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
        return text;
    }

    let processedText = text;
    
    rules.forEach(rule => {
        // 检查是否应该应用此规则
        
        // 1. 检查是否应用于前端
        if (!rule.applyToFrontend) return;
        
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
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @returns {string} The processed text with special blocks as HTML.
 */
function transformSpecialBlocks(text) {
    const toolRegex = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
    const noteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
    const toolResultRegex = /\[\[VCP调用结果信息汇总:(.*?)\]\]/gs;

    let processed = text;

    // Process VCP Tool Results
    processed = processed.replace(toolResultRegex, (match, rawContent) => {
        const content = rawContent.trim();
        const lines = content.split('\n').filter(line => line.trim() !== '');

        let toolName = 'Unknown Tool';
        let status = 'Unknown Status';
        const details = [];
        let otherContent = [];

        lines.forEach(line => {
            const kvMatch = line.match(/-\s*([^:]+):\s*(.*)/);
            if (kvMatch) {
                const key = kvMatch[1].trim();
                const value = kvMatch[2].trim();
                if (key === '工具名称') {
                    toolName = value;
                } else if (key === '执行状态') {
                    status = value;
                } else {
                    details.push({ key, value });
                }
            } else {
                otherContent.push(line);
            }
        });

        // Add 'collapsible' class for the new functionality, default to collapsed
        let html = `<div class="vcp-tool-result-bubble collapsible">`;
        html += `<div class="vcp-tool-result-header">`;
        html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
        html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
        html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`; // Toggle icon
        html += `</div>`;

        // Wrap details and footer in a new collapsible container
        html += `<div class="vcp-tool-result-collapsible-content">`;

        html += `<div class="vcp-tool-result-details">`;
        details.forEach(({ key, value }) => {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            let processedValue = escapeHtml(value);
            
            if ((key === '可访问URL' || key === '返回内容') && value.match(/\.(jpeg|jpg|png|gif)$/i)) {
                 processedValue = `<a href="${value}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${value}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
            } else {
                processedValue = processedValue.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
            }
            
            if (key === '返回内容') {
                processedValue = processedValue.replace(/###(.*?)###/g, '<strong>$1</strong>');
            }

            html += `<div class="vcp-tool-result-item">`;
            html += `<span class="vcp-tool-result-item-key">${escapeHtml(key)}:</span> `;
            html += `<span class="vcp-tool-result-item-value">${processedValue}</span>`;
            html += `</div>`;
        });
        html += `</div>`; // End of vcp-tool-result-details

        if (otherContent.length > 0) {
            html += `<div class="vcp-tool-result-footer"><pre>${escapeHtml(otherContent.join('\n'))}</pre></div>`;
        }

        html += `</div>`; // End of vcp-tool-result-collapsible-content
        html += `</div>`; // End of vcp-tool-result-bubble

        return html;
    });

    // Process Tool Requests
    processed = processed.replace(toolRegex, (match, content) => {
        // Regex to find tool name in either XML format (<tool_name>...</tool_name>) or key-value format (tool_name: ...)
        const toolNameRegex = /<tool_name>([\s\S]*?)<\/tool_name>|tool_name:\s*([^\n\r]*)/;
        const toolNameMatch = content.match(toolNameRegex);

        // The tool name will be in capture group 1 or 2. Default to a fallback.
        let toolName = 'Processing...';
        if (toolNameMatch) {
            // Use the first non-empty capture group
            let extractedName = (toolNameMatch[1] || toolNameMatch[2] || '').trim();
            
            // Clean the extracted name: remove special markers and trailing commas
            if (extractedName) {
                extractedName = extractedName.replace(/「始」|「末」/g, '').replace(/,$/, '').trim();
            }

            if (extractedName) {
                toolName = extractedName;
            }
        }

        const escapedFullContent = escapeHtml(content);
        // Construct the new HTML with a hidden details part
        return `<div class="vcp-tool-use-bubble">` +
               `<div class="vcp-tool-summary">` +
               `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
               `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
               `</div>` +
               `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
               `</div>`;
    });

    // Process Daily Notes
    processed = processed.replace(noteRegex, (match, rawContent) => {
        const content = rawContent.trim();
        const maidRegex = /Maid:\s*([^\n\r]*)/;
        const dateRegex = /Date:\s*([^\n\r]*)/;
        const contentRegex = /Content:\s*([\s\S]*)/;

        const maidMatch = content.match(maidRegex);
        const dateMatch = content.match(dateRegex);
        const contentMatch = content.match(contentRegex);

        const maid = maidMatch ? maidMatch[1].trim() : '';
        const date = dateMatch ? dateMatch[1].trim() : '';
        // The rest of the text after "Content:", or the full text if "Content:" is not found
        const diaryContent = contentMatch ? contentMatch[1].trim() : content;

        let html = `<div class="maid-diary-bubble">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">Maid's Diary</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;
        
        if (maid) {
            html += `<div class="diary-maid-info">`;
            html += `<span class="diary-maid-label">Maid:</span> `;
            html += `<span class="diary-maid-name">${escapeHtml(maid)}</span>`;
            html += `</div>`;
        }

        html += `<div class="diary-content">${escapeHtml(diaryContent)}</div>`;
        html += `</div>`;

        return html;
    });

    return processed;
}

/**
 * Transforms user's "clicked button" indicators into styled bubbles.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function transformUserButtonClick(text) {
    const buttonClickRegex = /\[\[点击按钮:(.*?)\]\]/gs;
    return text.replace(buttonClickRegex, (match, content) => {
        const escapedContent = escapeHtml(content.trim());
        return `<span class="user-clicked-button-bubble">${escapedContent}</span>`;
    });
}

function transformVCPChatCanvas(text) {
    const canvasPlaceholderRegex = /\{\{VCPChatCanvas\}\}/g;
    return text.replace(canvasPlaceholderRegex, () => {
        // Use a div for better block-level layout and margin behavior
        return `<div class="vcp-chat-canvas-placeholder">Canvas协同中<span class="thinking-indicator-dots">...</span></div>`;
    });
}

/**
 * Extracts <style> tags from content, scopes the CSS, and injects it into the document head.
 * @param {string} content - The raw message content string.
 * @param {string} scopeId - The unique ID for scoping.
 * @returns {{processedContent: string, styleInjected: boolean}} The content with <style> tags removed, and a flag indicating if styles were injected.
 */
function processAndInjectScopedCss(content, scopeId) {
    const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let cssContent = '';
    let styleInjected = false;

    const processedContent = content.replace(styleRegex, (match, css) => {
        cssContent += css.trim() + '\n';
        return ''; // Remove style tags from the content
    });

    if (cssContent.length > 0) {
        try {
            const scopedCss = contentProcessor.scopeCss(cssContent, scopeId);
            
            const styleElement = document.createElement('style');
            styleElement.type = 'text/css';
            styleElement.setAttribute('data-vcp-scope-id', scopeId);
            styleElement.textContent = scopedCss;
            document.head.appendChild(styleElement);
            styleInjected = true;
            
            console.log(`[ScopedCSS] Injected scoped styles for ID: #${scopeId}`);
        } catch (error) {
            console.error(`[ScopedCSS] Failed to scope or inject CSS for ID: ${scopeId}`, error);
        }
    }

    return { processedContent, styleInjected };
}


/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * An HTML document is identified by the `<!DOCTYPE html>` declaration.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function ensureHtmlFenced(text) {
    const doctypeTag = '<!DOCTYPE html>';
    const htmlCloseTag = '</html>';
    const lowerText = text.toLowerCase();

    // If it's already in a proper html code block, do nothing. This is the fix.
    // This regex now checks for any language specifier (or none) after the fences.
    if (/```\w*\n<!DOCTYPE html>/i.test(text)) {
        return text;
    }

    // Quick exit if no doctype is present.
    if (!lowerText.includes(doctypeTag.toLowerCase())) {
        return text;
    }

    let result = '';
    let lastIndex = 0;
    while (true) {
        const startIndex = text.toLowerCase().indexOf(doctypeTag.toLowerCase(), lastIndex);

        // Append the segment of text before the current HTML block.
        const textSegment = text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);
        result += textSegment;

        if (startIndex === -1) {
            break; // Exit loop if no more doctype markers are found.
        }

        // Find the corresponding </html> tag.
        const endIndex = text.toLowerCase().indexOf(htmlCloseTag.toLowerCase(), startIndex + doctypeTag.length);
        if (endIndex === -1) {
            // Malformed HTML (no closing tag), append the rest of the string and stop.
            result += text.substring(startIndex);
            break;
        }

        const block = text.substring(startIndex, endIndex + htmlCloseTag.length);
        
        // Check if we are currently inside an open code block by counting fences in the processed result.
        const fencesInResult = (result.match(/```/g) || []).length;

        if (fencesInResult % 2 === 0) {
            // Even number of fences means we are outside a code block.
            // Wrap the HTML block in new fences.
            result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
        } else {
            // Odd number of fences means we are inside a code block.
            // Append the HTML block as is.
            result += block;
        }

        // Move past the current HTML block.
        lastIndex = endIndex + htmlCloseTag.length;
    }

    return result;
}


/**
 * Removes leading whitespace from lines that appear to be HTML tags,
 * as long as they are not inside a fenced code block. This prevents
 * the markdown parser from misinterpreting indented HTML as an indented code block.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function deIndentHtml(text) {
    const lines = text.split('\n');
    let inFence = false;
    return lines.map(line => {
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
        }
        // If we are not in a fenced block, and a line is indented and looks like an HTML tag,
        // remove the leading whitespace. This is the key fix.
        // The regex now specifically targets indented `<p>` and `<div>` tags,
        // which are common block-level elements that can be misinterpreted as code blocks.
        // It is case-insensitive and handles tags spanning multiple lines.
        if (!inFence && /^\s+<(!|[a-zA-Z])/.test(line)) {
            return line.trimStart();
        }
        return line;
    }).join('\n');
}


/**
 * 根据对话轮次计算消息的深度。
 * @param {string} messageId - 目标消息的ID。
 * @param {Array<Message>} history - 完整的聊天记录数组。
 * @returns {number} - 计算出的深度（0代表最新一轮）。
 */
function calculateDepthByTurns(messageId, history) {
    const turns = [];
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') {
            const turn = { assistant: history[i], user: null };
            if (i > 0 && history[i - 1].role === 'user') {
                turn.user = history[i - 1];
                i--; // 跳过用户消息
            }
            turns.unshift(turn);
        } else if (history[i].role === 'user') {
            turns.unshift({ assistant: null, user: history[i] });
        }
    }
    
    const turnIndex = turns.findIndex(t => (t.assistant && t.assistant.id === messageId) || (t.user && t.user.id === messageId));
    
    // 如果找不到，默认为最新消息（深度0），这对于新消息渲染是安全的回退
    return turnIndex !== -1 ? (turns.length - 1 - turnIndex) : 0;
}


/**
 * A helper function to preprocess the full message content string before parsing.
 * @param {string} text The raw text content.
 * @returns {string} The processed text.
 */
function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    // --- 应用正则规则（前端）---
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const agentConfig = currentSelectedItem?.config || currentSelectedItem;

    if (agentConfig?.stripRegexes && Array.isArray(agentConfig.stripRegexes)) {
        // 应用前端正则规则，包含深度控制
        text = applyFrontendRegexRules(text, agentConfig.stripRegexes, messageRole, depth);
    }
    // --- 正则规则应用结束 ---

    const codeBlockMap = new Map();
    let placeholderId = 0;

    // Step 1: Handle Mermaid blocks, both in `<code>` tags and fenced blocks.
    // Case 1: AI wraps it in `<code>flowchart ...</code>`
    let processed = text.replace(/<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi, (match, lang, code) => {
        // Decode potential HTML entities like >
        const tempEl = document.createElement('textarea');
        tempEl.innerHTML = code;
        const decodedCode = tempEl.value;
        const encodedCode = encodeURIComponent(decodedCode.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });

    // Case 2: Standard fenced code blocks
    processed = processed.replace(/```(mermaid|flowchart|graph)\n([\s\S]*?)```/g, (match, lang, code) => {
        const encodedCode = encodeURIComponent(code.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });

    // Step 2: Find and protect all remaining fenced code blocks.
    // The regex looks for ``` followed by an optional language identifier, then anything until the next ```
    processed = processed.replace(/```\w*([\s\S]*?)```/g, (match) => {
        const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
        codeBlockMap.set(placeholder, match);
        placeholderId++;
        return placeholder;
    });

    // The order of the remaining operations is critical.
    // Step 3. Fix indented HTML that markdown might misinterpret as code blocks.
    processed = deIndentHtml(processed);

    // Step 3.1: Specifically de-indent VCP Tool Request blocks to prevent them from being parsed as code blocks.
    // This is a targeted fix for the race condition.
    processed = contentProcessor.deIndentToolRequestBlocks(processed);

    // Step 3.2. Directly transform special blocks (Tool/Diary) into styled HTML divs.
    processed = transformSpecialBlocks(processed);

    // Step 4. Ensure raw HTML documents are fenced to be displayed as code.
    processed = ensureHtmlFenced(processed);

    // Step 5. Run other standard content processors.
    processed = contentProcessor.ensureNewlineAfterCodeBlock(processed);
    processed = contentProcessor.ensureSpaceAfterTilde(processed);
    processed = contentProcessor.removeIndentationFromCodeBlockMarkers(processed);
    processed = contentProcessor.removeSpeakerTags(processed);
    processed = contentProcessor.ensureSeparatorBetweenImgAndCode(processed);

    // Step 6: Restore the protected code blocks.
    if (codeBlockMap.size > 0) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            processed = processed.replace(placeholder, block);
        }
    }

    return processed;
}

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {string} [id] 
 * @property {boolean} [isThinking]
 * @property {Array<{type: string, src: string, name: string}>} [attachments]
 * @property {string} [finishReason] 
 * @property {boolean} [isGroupMessage] // New: Indicates if it's a group message
 * @property {string} [agentId] // New: ID of the speaking agent in a group
 * @property {string} [name] // New: Name of the speaking agent in a group (can override default role name)
 * @property {string} [avatarUrl] // New: Specific avatar for this message (e.g. group member)
 * @property {string} [avatarColor] // New: Specific avatar color for this message
 */


/**
 * @typedef {Object} CurrentSelectedItem
 * @property {string|null} id - Can be agentId or groupId
 * @property {'agent'|'group'|null} type 
 * @property {string|null} name
 * @property {string|null} avatarUrl
 * @property {object|null} config - Full config of the selected item
 */


let mainRendererReferences = {
    currentChatHistoryRef: { get: () => [], set: () => {} }, // Ref to array
    currentSelectedItemRef: { get: () => ({ id: null, type: null, name: null, avatarUrl: null, config: null }), set: () => {} }, // Ref to object
    currentTopicIdRef: { get: () => null, set: () => {} }, // Ref to string/null
    globalSettingsRef: { get: () => ({ userName: '用户', userAvatarUrl: 'assets/default_user_avatar.png', userAvatarCalculatedColor: null }), set: () => {} }, // Ref to object

    chatMessagesDiv: null,
    electronAPI: null,
    markedInstance: null,
    uiHelper: {
        scrollToBottom: () => {},
        openModal: () => {},
        autoResizeTextarea: () => {},
        // ... other uiHelper functions ...
    },
    summarizeTopicFromMessages: async () => "",
    handleCreateBranch: () => {},
    // activeStreamingMessageId: null, // ID of the message currently being streamed - REMOVED
};


function removeMessageById(messageId, saveHistory = false) {
    const item = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (item) item.remove();
    
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const index = currentChatHistoryArray.findIndex(m => m.id === messageId);
    
    if (index > -1) {
        currentChatHistoryArray.splice(index, 1);
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
        
        if (saveHistory) {
            const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
            const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
            if (currentSelectedItemVal.id && currentTopicIdVal) {
                if (currentSelectedItemVal.type === 'agent') {
                    mainRendererReferences.electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                } else if (currentSelectedItemVal.type === 'group' && mainRendererReferences.electronAPI.saveGroupChatHistory) {
                    mainRendererReferences.electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                }
            }
        }
    }
    clearImageState(messageId); // Clean up image state for the deleted message
}

function clearChat() {
    if (mainRendererReferences.chatMessagesDiv) mainRendererReferences.chatMessagesDiv.innerHTML = '';
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
    clearAllImageStates(); // Clear all image loading states
}


function initializeMessageRenderer(refs) {
   Object.assign(mainRendererReferences, refs);

   initializeImageHandler({
       electronAPI: mainRendererReferences.electronAPI,
       uiHelper: mainRendererReferences.uiHelper,
       chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
   });

   // Start the emoticon fixer initialization, but don't wait for it here.
   // The await will happen inside renderMessage to ensure it's ready before rendering.
   emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

   // Add event listener for collapsible tool results
   mainRendererReferences.chatMessagesDiv.addEventListener('click', (event) => {
       const header = event.target.closest('.vcp-tool-result-header');
       if (header) {
           const bubble = header.closest('.vcp-tool-result-bubble.collapsible');
           if (bubble) {
               bubble.classList.toggle('expanded');
           }
       }
   });

   // Create a new marked instance wrapper specifically for the stream manager.
   // This ensures that any text passed to `marked.parse()` during streaming
   // is first processed by `deIndentHtml`. This robustly fixes the issue of
   // indented HTML being rendered as code blocks during live streaming,
   // without needing to modify the stream manager itself.
   const originalMarkedParse = mainRendererReferences.markedInstance.parse.bind(mainRendererReferences.markedInstance);
   const streamingMarkedInstance = {
       ...mainRendererReferences.markedInstance,
       parse: (text) => {
           const globalSettings = mainRendererReferences.globalSettingsRef.get();
           // Pass settings to the preprocessor so it can adjust its behavior.
           const processedText = preprocessFullContent(text, globalSettings);
           return originalMarkedParse(processedText);
       }
   };

   contentProcessor.initializeContentProcessor(mainRendererReferences);

   contextMenu.initializeContextMenu(mainRendererReferences, {
       // Pass functions that the context menu needs to call back into the main renderer
       removeMessageById: removeMessageById,
       finalizeStreamedMessage: finalizeStreamedMessage,
       renderMessage: renderMessage,
       startStreamingMessage: startStreamingMessage,
       setContentAndProcessImages: setContentAndProcessImages,
       processRenderedContent: contentProcessor.processRenderedContent,
       runTextHighlights: contentProcessor.runTextHighlights,
       preprocessFullContent: preprocessFullContent,
       renderAttachments: renderAttachments,
       interruptHandler: mainRendererReferences.interruptHandler, // Pass the interrupt handler
   });

   // Make toggleEditMode available globally for middle click functionality
   if (typeof contextMenu.toggleEditMode === 'function') {
       window.toggleEditMode = contextMenu.toggleEditMode;
       window.messageContextMenu = contextMenu; // Also expose the entire module for fallback
   }

   streamManager.initStreamManager({
       // Core Refs
       globalSettingsRef: mainRendererReferences.globalSettingsRef,
       currentChatHistoryRef: mainRendererReferences.currentChatHistoryRef,
       currentSelectedItemRef: mainRendererReferences.currentSelectedItemRef,
       currentTopicIdRef: mainRendererReferences.currentTopicIdRef,
       
       // DOM & API Refs
       chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
       markedInstance: streamingMarkedInstance, // Use the wrapped instance
       electronAPI: mainRendererReferences.electronAPI,
       uiHelper: mainRendererReferences.uiHelper,

       // Rendering & Utility Functions
       renderMessage: renderMessage,
       showContextMenu: contextMenu.showContextMenu,
       setContentAndProcessImages: setContentAndProcessImages,
       processRenderedContent: contentProcessor.processRenderedContent,
       runTextHighlights: contentProcessor.runTextHighlights,
       preprocessFullContent: preprocessFullContent,
       // Pass individual processors needed by streamManager
       removeSpeakerTags: contentProcessor.removeSpeakerTags,
       ensureNewlineAfterCodeBlock: contentProcessor.ensureNewlineAfterCodeBlock,
       ensureSpaceAfterTilde: contentProcessor.ensureSpaceAfterTilde,
       removeIndentationFromCodeBlockMarkers: contentProcessor.removeIndentationFromCodeBlockMarkers,
       ensureSeparatorBetweenImgAndCode: contentProcessor.ensureSeparatorBetweenImgAndCode,

       // Pass the main processor function
       processAnimationsInContent: processAnimationsInContent, // Pass the animation processor

       // Debouncing and Timers
       enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
       ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
       DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
   });


   injectEnhancedStyles();
   console.log("[MessageRenderer] Initialized. Current selected item type on init:", mainRendererReferences.currentSelectedItemRef.get()?.type);
}


function setCurrentSelectedItem(item) {
    // This function is mainly for renderer.js to update the shared state.
    // messageRenderer will read from currentSelectedItemRef.get() when rendering.
    // console.log("[MessageRenderer] setCurrentSelectedItem called with:", item);
}

function setCurrentTopicId(topicId) {
    // console.log("[MessageRenderer] setCurrentTopicId called with:", topicId);
}

// These are for specific avatar of the current *context* (agent or user), not for individual group member messages
function setCurrentItemAvatar(avatarUrl) { // Renamed from setCurrentAgentAvatar
    // This updates the avatar for the main selected agent/group, not individual group members in a message.
    // The currentSelectedItemRef should hold the correct avatar for the overall context.
}

function setUserAvatar(avatarUrl) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const oldUrl = globalSettings.userAvatarUrl;
    if (oldUrl && oldUrl !== (avatarUrl || 'assets/default_user_avatar.png')) {
        avatarColorCache.delete(oldUrl.split('?')[0]);
    }
    mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarUrl: avatarUrl || 'assets/default_user_avatar.png' });
}

function setCurrentItemAvatarColor(color) { // Renamed from setCurrentAgentAvatarColor
    // For the main selected agent/group
}

function setUserAvatarColor(color) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarCalculatedColor: color });
}


async function renderAttachments(message, contentDiv) {
    const { electronAPI } = mainRendererReferences;
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.classList.add('message-attachments');
        message.attachments.forEach(att => {
            let attachmentElement;
            if (att.type.startsWith('image/')) {
                attachmentElement = document.createElement('img');
                attachmentElement.src = att.src; // This src should be usable (e.g., file:// or data:)
                attachmentElement.alt = `附件图片: ${att.name}`;
                attachmentElement.title = `点击在新窗口预览: ${att.name}`;
                attachmentElement.classList.add('message-attachment-image-thumbnail');
                attachmentElement.onclick = (e) => {
                    e.stopPropagation();
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    electronAPI.openImageViewer({ src: att.src, title: att.name, theme: currentTheme });
                };
                 attachmentElement.addEventListener('contextmenu', (e) => { // Use attachmentElement here
                    e.preventDefault(); e.stopPropagation();
                    electronAPI.showImageContextMenu(att.src);
                });
            } else if (att.type.startsWith('audio/')) {
                attachmentElement = document.createElement('audio');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
            } else if (att.type.startsWith('video/')) {
                attachmentElement = document.createElement('video');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
                attachmentElement.style.maxWidth = '300px';
            } else { // Generic file
                attachmentElement = document.createElement('a');
                attachmentElement.href = att.src;
                attachmentElement.textContent = `📄 ${att.name}`;
                attachmentElement.title = `点击打开文件: ${att.name}`;
                attachmentElement.onclick = (e) => {
                    e.preventDefault();
                    if (electronAPI.sendOpenExternalLink && att.src.startsWith('file://')) {
                         electronAPI.sendOpenExternalLink(att.src);
                    } else {
                        console.warn("Cannot open local file attachment, API missing or path not a file URI:", att.src);
                    }
                };
            }
            if (attachmentElement) attachmentsContainer.appendChild(attachmentElement);
        });
        contentDiv.appendChild(attachmentsContainer);
    }
}

async function renderMessage(message, isInitialLoad = false, appendToDom = true) {
    console.log('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message))); // Log incoming message
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentChatHistory = mainRendererReferences.currentChatHistoryRef.get();

    // Prevent re-rendering if the message already exists in the DOM, unless it's a thinking message being replaced.
    const existingMessageDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (existingMessageDom && !existingMessageDom.classList.contains('thinking')) {
        // console.log(`[MessageRenderer] Message ${message.id} already in DOM. Skipping render.`);
        // return existingMessageDom;
    }

    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(message, globalSettings, currentSelectedItem);

    // --- NEW: Scoped CSS Implementation ---
    let scopeId = null;
    if (message.role === 'assistant') {
        scopeId = generateUniqueId();
        messageItem.id = scopeId; // Assign the unique ID to the message container
    }
    // --- END Scoped CSS Implementation ---

    // Attach context menu to all assistant and user messages, regardless of state.
    // The context menu itself will decide which options to show.
    if (message.role === 'assistant' || message.role === 'user') {
        messageItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            contextMenu.showContextMenu(e, messageItem, message);
        });

        // Add middle click quick action functionality with advanced grid selection
        messageItem.addEventListener('mousedown', (e) => {
            if (e.button === 1) { // Middle mouse button
                e.preventDefault();
                e.stopPropagation();

                const globalSettings = mainRendererReferences.globalSettingsRef.get();
                if (globalSettings.enableMiddleClickQuickAction) {
                    // Always start basic 1-second quick action timer if configured
                    if (globalSettings.middleClickQuickAction && globalSettings.middleClickQuickAction.trim() !== '') {
                        startMiddleClickTimer(e, messageItem, message, globalSettings.middleClickQuickAction);
                    }

                    // Start advanced mode timer if enabled and delay >= 1000ms
                    if (globalSettings.enableMiddleClickAdvanced) {
                        const delay = globalSettings.middleClickAdvancedDelay || 1000;
                        if (delay >= 1000) {
                            startAdvancedMiddleClickTimer(e, messageItem, message, globalSettings);
                        } else {
                            console.warn('[MiddleClick] Advanced mode delay must be >= 1000ms for compatibility. Current delay:', delay);
                            // Force delay to minimum 1000ms for compatibility
                            globalSettings.middleClickAdvancedDelay = 1000;
                            startAdvancedMiddleClickTimer(e, messageItem, message, globalSettings);
                        }
                    }
                }
            }
        });
    }

    // Add logic for stopping TTS by clicking the avatar
    // Add logic for stopping TTS by clicking the avatar
    // Simplified logic: always add the click listener to assistant avatars.
    // Clicking it will stop any ongoing TTS playback.
    if (avatarImg && message.role === 'assistant') {
        avatarImg.addEventListener('click', () => {
            console.log(`[MessageRenderer] Avatar clicked for message ${message.id}. Stopping TTS.`);
            mainRendererReferences.electronAPI.sovitsStop();
        });
    }

    // 先确定颜色值（但不应用）
    let avatarColorToUse;
    let avatarUrlToUse; // This was the missing variable
    if (message.role === 'user') {
        avatarColorToUse = globalSettings.userAvatarCalculatedColor;
        avatarUrlToUse = globalSettings.userAvatarUrl;
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarColorToUse = message.avatarColor;
            avatarUrlToUse = message.avatarUrl;
        } else if (currentSelectedItem) {
            avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor
                            || currentSelectedItem.avatarCalculatedColor
                            || currentSelectedItem.config?.avatarColor
                            || currentSelectedItem.avatarColor;
            avatarUrlToUse = currentSelectedItem.avatarUrl;
        }
    }

    // 先添加到DOM
    if (appendToDom) {
        chatMessagesDiv.appendChild(messageItem);
    }

    if (message.isThinking) {
        contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
        messageItem.classList.add('thinking');
    } else {
        let textToRender = "";
        if (typeof message.content === 'string') {
            textToRender = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            // This case handles objects like { text: "..." }, common for group messages before history saving
            textToRender = message.content.text;
        } else if (message.content === null || message.content === undefined) {
            textToRender = ""; // Handle null or undefined content gracefully
             console.warn('[MessageRenderer] message.content is null or undefined for message ID:', message.id);
        } else {
            // Fallback for other unexpected object structures, log and use a placeholder
            console.warn('[MessageRenderer] Unexpected message.content type. Message ID:', message.id, 'Content:', JSON.stringify(message.content));
            textToRender = "[消息内容格式异常]";
        }
        
        // Apply special formatting for user button clicks
        if (message.role === 'user') {
            textToRender = transformUserButtonClick(textToRender);
            textToRender = transformVCPChatCanvas(textToRender);
        } else if (message.role === 'assistant' && scopeId) {
            // --- Scoped CSS: Extract, scope, and inject styles from AI content ---
            const { processedContent: contentWithoutStyles } = processAndInjectScopedCss(textToRender, scopeId);
            textToRender = contentWithoutStyles;
            // --- END Scoped CSS ---
        }
        
        // --- 按“对话轮次”计算深度 ---
        // 如果是新消息，它此时还不在 history 数组里，先临时加进去计算
        const historyForDepthCalc = currentChatHistory.some(m => m.id === message.id)
            ? [...currentChatHistory]
            : [...currentChatHistory, message];
        const depth = calculateDepthByTurns(message.id, historyForDepthCalc);
        // --- 深度计算结束 ---

        const processedContent = preprocessFullContent(textToRender, globalSettings, message.role, depth);
        let rawHtml = markedInstance.parse(processedContent);
        
        // Create a temporary div to apply emoticon fixes before setting innerHTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = rawHtml;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
            const originalSrc = img.getAttribute('src');
            if (originalSrc) {
                const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
                if (originalSrc !== fixedSrc) {
                    img.src = fixedSrc;
                }
            }
        });
        
            // Synchronously set the base HTML content
            const finalHtml = tempDiv.innerHTML;
            contentDiv.innerHTML = finalHtml;

            // Define the post-processing logic as a function.
            // This allows us to control WHEN it gets executed.
            const runPostRenderProcessing = async () => {
                // This function should only be called when messageItem is connected to the DOM.
                
                // Process images, attachments, and synchronous content first.
                setContentAndProcessImages(contentDiv, finalHtml, message.id);
                renderAttachments(message, contentDiv);
                contentProcessor.processRenderedContent(contentDiv);
                await renderMermaidDiagrams(contentDiv); // Render mermaid diagrams

                // Defer TreeWalker-based highlighters with a hardcoded delay to ensure the DOM is stable.
                setTimeout(() => {
                    if (contentDiv && contentDiv.isConnected) {
                        contentProcessor.runTextHighlights(contentDiv);
                    }
                }, 0);

                // Finally, process any animations.
                if (globalSettings.enableAgentBubbleTheme) {
                    processAnimationsInContent(contentDiv);
                }
            };

            // If we are appending directly to the DOM, schedule the processing immediately.
            if (appendToDom) {
                // We still use requestAnimationFrame to ensure the element is painted before we process it.
                requestAnimationFrame(() => runPostRenderProcessing());
            } else {
                // If not, attach the processing function to the element itself.
                // The caller (e.g., a batch renderer) will be responsible for executing it
                // AFTER the element has been attached to the DOM.
                messageItem._vcp_process = () => runPostRenderProcessing();
            }
        }
    
    // 然后应用颜色（现在 messageItem.isConnected 是 true）
    if ((message.role === 'user' || message.role === 'assistant') && avatarImg && senderNameDiv) {
        const applyColorToElements = (colorStr) => {
            if (colorStr) {
                console.log(`[DEBUG] Applying color ${colorStr} to message item ${messageItem.dataset.messageId}`);
                messageItem.style.setProperty('--dynamic-avatar-color', colorStr);
                
                // 后备方案：直接应用到avatarImg
                if (avatarImg) {
                    avatarImg.style.borderColor = colorStr;
                    avatarImg.style.borderWidth = '2px';
                    avatarImg.style.borderStyle = 'solid';
                }
            } else {
                console.log(`[DEBUG] No color to apply, using default`);
                messageItem.style.removeProperty('--dynamic-avatar-color');
            }
        };

        if (avatarColorToUse) {
            applyColorToElements(avatarColorToUse);
        } else if (avatarUrlToUse && !avatarUrlToUse.includes('default_')) { // No persisted color, try to extract
            const dominantColor = await getDominantAvatarColor(avatarUrlToUse);
            if (dominantColor) { // Successfully extracted a color
                applyColorToElements(dominantColor);
                if (messageItem.isConnected) { // If extracted and still in DOM, try to persist
                    let typeToSave, idToSaveFor;
                    if (message.role === 'user') {
                        typeToSave = 'user'; idToSaveFor = 'user_global';
                    } else if (message.isGroupMessage && message.agentId) {
                        typeToSave = 'agent'; idToSaveFor = message.agentId; // Save for the specific group member
                    } else if (currentSelectedItem && currentSelectedItem.type === 'agent') {
                        typeToSave = 'agent'; idToSaveFor = currentSelectedItem.id; // Current agent
                    }

                    if (typeToSave && idToSaveFor) {
                        electronAPI.saveAvatarColor({ type: typeToSave, id: idToSaveFor, color: dominantColor })
                            .then(result => {
                                if (result.success) {
                                    if (typeToSave === 'user') {
                                        mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarCalculatedColor: dominantColor });
                                    } else if (typeToSave === 'agent' && idToSaveFor === currentSelectedItem.id) {
                                        if (currentSelectedItem.config) { // Handle nested structure
                                            currentSelectedItem.config.avatarCalculatedColor = dominantColor;
                                        } else { // Handle flat structure
                                            currentSelectedItem.avatarCalculatedColor = dominantColor;
                                        }
                                    }
                                }
                            });
                    }
                }
            } else { // Failed to extract color (e.g., CORS issue), apply a default border
                avatarImg.style.borderColor = 'var(--border-color)';
            }
        } else { // Default avatar or no URL, reset to theme defaults
            // Remove the custom property. The CSS will automatically use its fallback values.
            messageItem.style.removeProperty('--dynamic-avatar-color');
        }
    }


    // Attachments and content processing are now deferred within a requestAnimationFrame
    // to prevent race conditions during history loading. See the block above.
   
   // The responsibility of updating the history array is now moved to the caller (e.g., chatManager.handleSendMessage)
   // to ensure a single source of truth and prevent race conditions.
   /*
   if (!isInitialLoad && !message.isThinking) {
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        currentChatHistoryArray.push(message);
        mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray); // Update the ref

        if (currentSelectedItem.id && mainRendererReferences.currentTopicIdRef.get()) {
             if (currentSelectedItem.type === 'agent') {
                electronAPI.saveChatHistory(currentSelectedItem.id, mainRendererReferences.currentTopicIdRef.get(), currentChatHistoryArray);
             } else if (currentSelectedItem.type === 'group') {
                // Group history is usually saved by groupchat.js in main process after AI response
             }
        }
    }
    */
    if (isInitialLoad && message.isThinking) {
        // This case should ideally not happen if thinking messages aren't persisted.
        // If it does, remove the transient thinking message.
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        const thinkingMsgIndex = currentChatHistoryArray.findIndex(m => m.id === message.id && m.isThinking);
        if (thinkingMsgIndex > -1) {
            currentChatHistoryArray.splice(thinkingMsgIndex, 1);
            mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray);
        }
        messageItem.remove();
        return null;
    }

   // Highlighting is now part of processRenderedContent
   
   if (appendToDom) {
       mainRendererReferences.uiHelper.scrollToBottom();
   }
   return messageItem;
}

function startStreamingMessage(message, messageItem = null) {
    return streamManager.startStreamingMessage(message, messageItem);
}


function appendStreamChunk(messageId, chunkData, context) {
    streamManager.appendStreamChunk(messageId, chunkData, context);
}

async function finalizeStreamedMessage(messageId, finishReason, context) {
    // 责任完全在 streamManager 内部，它应该使用自己拼接好的文本。
    // 我们现在只传递必要的元数据。
    await streamManager.finalizeStreamedMessage(messageId, finishReason, context);

    // After the stream is finalized in the DOM, find the message and render any mermaid blocks.
    const messageItem = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (messageItem) {
        const contentDiv = messageItem.querySelector('.md-content');
        if (contentDiv) {
            await renderMermaidDiagrams(contentDiv);
        }
    }
}



/**
 * Renders a full, non-streamed message, replacing a 'thinking' placeholder.
 * @param {string} messageId - The ID of the message to update.
 * @param {string} fullContent - The full HTML or text content of the message.
 * @param {string} agentName - The name of the agent sending the message.
 * @param {string} agentId - The ID of the agent sending the message.
 */
async function renderFullMessage(messageId, fullContent, agentName, agentId) {
    console.log(`[MessageRenderer renderFullMessage] Rendering full message for ID: ${messageId}`);
    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    // --- Update History First ---
    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndex > -1) {
        const message = currentChatHistoryArray[messageIndex];
        message.content = fullContent;
        message.isThinking = false;
        message.finishReason = 'completed_non_streamed';
        message.name = agentName || message.name;
        message.agentId = agentId || message.agentId;
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);

        // Save history
        if (currentSelectedItem && currentSelectedItem.id && currentTopicIdVal && currentSelectedItem.type === 'group') {
            if (electronAPI.saveGroupChatHistory) {
                try {
                    await electronAPI.saveGroupChatHistory(currentSelectedItem.id, currentTopicIdVal, currentChatHistoryArray.filter(m => !m.isThinking));
                } catch (error) {
                    console.error(`[MR renderFullMessage] FAILED to save GROUP history for ${currentSelectedItem.id}, topic ${currentTopicIdVal}:`, error);
                }
            }
        }
    } else {
        console.warn(`[renderFullMessage] Message ID ${messageId} not found in history. UI will be updated, but history may be inconsistent.`);
        // Even if not in history, we might still want to render it if the DOM element exists (e.g., from a 'thinking' state)
    }

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        console.log(`[renderFullMessage] No DOM element for ${messageId}. History updated, UI skipped.`);
        return; // No UI to update, but history is now consistent.
    }

    messageItem.classList.remove('thinking', 'streaming');

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) {
        console.error(`[renderFullMessage] Could not find .md-content div for message ID ${messageId}.`);
        return;
    }

    // Update timestamp display if it was missing
    const nameTimeBlock = messageItem.querySelector('.name-time-block');
    if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
        const timestampDiv = document.createElement('div');
        timestampDiv.classList.add('message-timestamp');
        const messageFromHistory = currentChatHistoryArray.find(m => m.id === messageId);
        timestampDiv.textContent = new Date(messageFromHistory?.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        nameTimeBlock.appendChild(timestampDiv);
    }

    // --- Update DOM ---
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const processedFinalText = preprocessFullContent(fullContent, globalSettings, 'assistant');
    let rawHtml = markedInstance.parse(processedFinalText);

    // Create a temporary div to apply emoticon fixes before setting innerHTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    const images = tempDiv.querySelectorAll('img');
    images.forEach(img => {
        const originalSrc = img.getAttribute('src');
        if (originalSrc) {
            const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
            if (originalSrc !== fixedSrc) {
                img.src = fixedSrc;
            }
        }
    });

    setContentAndProcessImages(contentDiv, tempDiv.innerHTML, messageId);

    // Apply post-processing in two steps
    // Step 1: Synchronous processing
    contentProcessor.processRenderedContent(contentDiv);
    await renderMermaidDiagrams(contentDiv);

    // Step 2: Asynchronous, deferred highlighting for DOM stability with a hardcoded delay
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.runTextHighlights(contentDiv);
        }
    }, 0);

    // After content is rendered, check if we need to run animations
    if (globalSettings.enableAgentBubbleTheme) {
        processAnimationsInContent(contentDiv);
    }

    mainRendererReferences.uiHelper.scrollToBottom();
}

function updateMessageContent(messageId, newContent) {
    const { chatMessagesDiv, markedInstance, globalSettingsRef } = mainRendererReferences;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const globalSettings = globalSettingsRef.get();
    let textToRender = (typeof newContent === 'string') ? newContent : (newContent?.text || "[内容格式异常]");
    
    // --- 深度计算 (用于历史消息渲染) ---
    const currentChatHistoryForUpdate = mainRendererReferences.currentChatHistoryRef.get();
    const messageInHistory = currentChatHistoryForUpdate.find(m => m.id === messageId);
    
    // --- 按“对话轮次”计算深度 ---
    const depthForUpdate = calculateDepthByTurns(messageId, currentChatHistoryForUpdate);
    // --- 深度计算结束 ---
    const processedContent = preprocessFullContent(textToRender, globalSettings, messageInHistory?.role || 'assistant', depthForUpdate);
    let rawHtml = markedInstance.parse(processedContent);

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    const images = tempDiv.querySelectorAll('img');
    images.forEach(img => {
        const originalSrc = img.getAttribute('src');
        if (originalSrc) {
            const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
            if (originalSrc !== fixedSrc) {
                img.src = fixedSrc;
            }
        }
    });

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    // 1. Set content and process images
    setContentAndProcessImages(contentDiv, tempDiv.innerHTML, messageId);

    // 2. Re-render attachments if they exist
    if (messageInHistory) {
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) existingAttachments.remove();
        renderAttachments({ ...messageInHistory, content: newContent }, contentDiv);
    }

    // 3. Synchronous processing (KaTeX, buttons, etc.)
    contentProcessor.processRenderedContent(contentDiv);
    renderMermaidDiagrams(contentDiv); // Fire-and-forget async rendering

    // 4. Asynchronous, deferred highlighting for DOM stability
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.runTextHighlights(contentDiv);
        }
    }, 0);

    // 5. Re-run animations
    if (globalSettings.enableAgentBubbleTheme) {
        processAnimationsInContent(contentDiv);
    }
}

// Expose methods to renderer.js
/**
 * Renders a complete chat history with progressive loading for better UX.
 * First shows the latest 5 messages, then loads older messages in batches of 10.
 * @param {Array<Message>} history The chat history to render.
 * @param {Object} options Rendering options
 * @param {number} options.initialBatch - Number of latest messages to show first (default: 5)
 * @param {number} options.batchSize - Size of subsequent batches (default: 10)
 * @param {number} options.batchDelay - Delay between batches in ms (default: 100)
 */
async function renderHistory(history, options = {}) {
    const {
        initialBatch = 5,
        batchSize = 10,
        batchDelay = 100
    } = options;

    // 核心修复：在开始批量渲染前，只等待一次依赖项。
    await emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

    if (!history || history.length === 0) {
        return Promise.resolve();
    }

    // 如果消息数量很少，直接使用原来的方式渲染
    if (history.length <= initialBatch) {
        return renderHistoryLegacy(history);
    }

    console.log(`[MessageRenderer] 开始分批渲染 ${history.length} 条消息，首批 ${initialBatch} 条，后续每批 ${batchSize} 条`);

    // 分离最新的消息和历史消息
    const latestMessages = history.slice(-initialBatch);
    const olderMessages = history.slice(0, -initialBatch);

    // 第一阶段：立即渲染最新的消息
    await renderMessageBatch(latestMessages, true);
    console.log(`[MessageRenderer] 首批 ${latestMessages.length} 条最新消息已渲染`);

    // 第二阶段：分批渲染历史消息（从旧到新）
    if (olderMessages.length > 0) {
        await renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay);
    }

    // 最终滚动到底部
    mainRendererReferences.uiHelper.scrollToBottom();
    console.log(`[MessageRenderer] 所有 ${history.length} 条消息渲染完成`);
}

/**
 * 渲染一批消息
 * @param {Array<Message>} messages 要渲染的消息数组
 * @param {boolean} scrollToBottom 是否滚动到底部
 */
async function renderMessageBatch(messages, scrollToBottom = false) {
    const fragment = document.createDocumentFragment();
    const messageElements = [];

    // 在内存中创建所有消息元素
    for (const msg of messages) {
        const messageElement = await renderMessage(msg, true, false);
        if (messageElement) {
            messageElements.push(messageElement);
        }
    }

    // 一次性添加到 fragment
    messageElements.forEach(el => fragment.appendChild(el));
    
    // 使用 requestAnimationFrame 确保 DOM 更新不阻塞 UI
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            // Step 1: Append all elements to the DOM at once.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);
            
            // Step 2: Now that they are in the DOM, run the deferred processing for each.
            messageElements.forEach(el => {
                if (typeof el._vcp_process === 'function') {
                    el._vcp_process();
                    delete el._vcp_process; // Clean up to avoid memory leaks
                }
            });

            if (scrollToBottom) {
                mainRendererReferences.uiHelper.scrollToBottom();
            }
            resolve();
        });
    });
}

/**
 * 分批渲染历史消息
 * @param {Array<Message>} olderMessages 历史消息数组
 * @param {number} batchSize 每批大小
 * @param {number} batchDelay 批次间延迟
 */
async function renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay) {
    const totalBatches = Math.ceil(olderMessages.length / batchSize);
    
    // 从最新的历史消息开始，向前渲染（这样插入顺序就是正确的）
    for (let i = totalBatches - 1; i >= 0; i--) {
        const startIndex = i * batchSize;
        const endIndex = Math.min(startIndex + batchSize, olderMessages.length);
        const batch = olderMessages.slice(startIndex, endIndex);
        
        console.log(`[MessageRenderer] 渲染历史消息批次 ${totalBatches - i}/${totalBatches} (${batch.length} 条)`);
        
        // 创建批次的 fragment
        const batchFragment = document.createDocumentFragment();
        
        const elementsForProcessing = [];
        for (const msg of batch) {
            const messageElement = await renderMessage(msg, true, false);
            if (messageElement) {
                batchFragment.appendChild(messageElement);
                elementsForProcessing.push(messageElement);
            }
        }
        
        // 将批次插入到已渲染内容的最前面（在系统消息之后）
        await new Promise(resolve => {
            requestAnimationFrame(() => {
                const chatMessagesDiv = mainRendererReferences.chatMessagesDiv;
                
                // 找到第一个非系统消息作为插入点
                let insertPoint = chatMessagesDiv.firstChild;
                while (insertPoint && insertPoint.classList && insertPoint.classList.contains('topic-timestamp-bubble')) {
                    insertPoint = insertPoint.nextSibling;
                }
                
                if (insertPoint) {
                    chatMessagesDiv.insertBefore(batchFragment, insertPoint);
                } else {
                    chatMessagesDiv.appendChild(batchFragment);
                }

                // Run processors for the newly added batch
                elementsForProcessing.forEach(el => {
                    if (typeof el._vcp_process === 'function') {
                        el._vcp_process();
                        delete el._vcp_process;
                    }
                });

                resolve();
            });
        });
        
        // 批次间延迟，避免阻塞 UI
        if (i > 0 && batchDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, batchDelay));
        }
    }
}

/**
 * 原始的历史渲染方法（用于少量消息的情况）
 * @param {Array<Message>} history 聊天历史
 */
async function renderHistoryLegacy(history) {
    const fragment = document.createDocumentFragment();
    const allMessageElements = [];

    // Phase 1: Create all message elements in memory without appending to DOM
    for (const msg of history) {
        const messageElement = await renderMessage(msg, true, false);
        if (messageElement) {
            allMessageElements.push(messageElement);
        }
    }

    // Phase 2: Append all created elements at once using a DocumentFragment
    allMessageElements.forEach(el => fragment.appendChild(el));
    
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            // Step 1: Append all elements to the DOM.
            mainRendererReferences.chatMessagesDiv.appendChild(fragment);

            // Step 2: Run the deferred processing for each element now that it's attached.
            allMessageElements.forEach(el => {
                if (typeof el._vcp_process === 'function') {
                    el._vcp_process();
                    delete el._vcp_process; // Clean up
                }
            });

            mainRendererReferences.uiHelper.scrollToBottom();
            resolve();
        });
    });
}


// Store active middle click timers for cleanup
let activeMiddleClickTimers = new Map();

// Middle click grid state
let middleClickGrid = null;
let currentGridSelection = '';
let isAdvancedModeActive = false;
let isDeletingMessage = false; // Flag to suppress grid cancellation messages during delete
let freezeGridCancellation = false; // Flag to completely freeze grid cancellation logic

/**
 * 检查气泡是否处于完成状态，可以进行中键操作
 * @param {Object} message - 消息对象
 * @param {HTMLElement} messageItem - 消息DOM元素
 * @returns {boolean} - 是否可以进行中键操作
 */
function canPerformMiddleClickAction(message, messageItem) {
    if (!message || !messageItem) {
        return false;
    }

    const messageId = message.id;

    // 多重状态检查，确保消息真正完成
    const isThinking = message.isThinking;
    const isStreaming = messageItem.classList.contains('streaming');
    const hasStreamingIndicator = messageItem.querySelector('.streaming-indicator, .thinking-indicator');

    // 检查消息是否在streamManager中被标记为已完成
    let isStreamManagerFinalized = false;
    if (window.streamManager && typeof window.streamManager.isMessageInitialized === 'function') {
        // 如果消息不在streamManager中跟踪，说明已经完成
        isStreamManagerFinalized = !window.streamManager.isMessageInitialized(messageId);
    }

    // 检查消息是否有完成理由（表示已完成）
    const hasFinishReason = message.finishReason && message.finishReason !== 'null';

    // 检查消息内容是否完整（非流式消息的标志）
    const hasCompleteContent = message.content &&
        (typeof message.content === 'string' ? message.content.length > 0 : true);

    // 增强的状态判断逻辑 - 只要满足以下任一条件即可认为完成：
    // 1. 传统检查：非思考且非流式
    // 2. 有完成理由（表示已完成）
    // 3. StreamManager确认已完成
    // 4. 有完整内容且无流式指示器
    const isCompleted = (!isThinking && !isStreaming) ||
                       hasFinishReason ||
                       isStreamManagerFinalized ||
                       (hasCompleteContent && !hasStreamingIndicator && !isStreaming);

    console.log(`[MiddleClick] Checking message ${messageId}: thinking=${isThinking}, streaming=${isStreaming}, hasIndicator=${!!hasStreamingIndicator}, streamFinalized=${isStreamManagerFinalized}, finishReason=${message.finishReason}, completed=${isCompleted}`);

    return isCompleted;
}

/**
 * Starts the advanced middle click timer mechanism with grid selection
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {Object} globalSettings - The global settings object
 */
function startAdvancedMiddleClickTimer(event, messageItem, message, globalSettings) {
    // 首先检查气泡是否处于完成状态
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[AdvancedMiddleClick] Ignoring advanced middle click on incomplete message: ${message?.id}`);
        return;
    }

    const timerId = `advanced_middle_click_${message.id}_${Date.now()}`;

    // Add visual feedback - change cursor and add a subtle highlight
    messageItem.style.cursor = 'grabbing';
    messageItem.style.backgroundColor = 'rgba(128, 128, 128, 0.1)';

    const startTime = Date.now();
    const delay = globalSettings.middleClickAdvancedDelay || 1000;

    // Create cleanup function
    const cleanup = () => {
        messageItem.style.cursor = '';
        messageItem.style.backgroundColor = '';
        if (middleClickGrid) {
            middleClickGrid.remove();
            middleClickGrid = null;
        }
        currentGridSelection = '';
        isAdvancedModeActive = false;
        isDeletingMessage = false;
        freezeGridCancellation = false;
        // 恢复原始的 showToastNotification 函数
        if (mainRendererReferences.uiHelper.showToastNotification &&
            mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
            mainRendererReferences.uiHelper.showToastNotification =
                mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
        }
        activeMiddleClickTimers.delete(timerId);
    };

    // Set up event listeners for mouseup and mouseleave
    const handleMouseUp = (e) => {
        if (e.button === 1) { // Middle mouse button
            e.preventDefault();
            e.stopPropagation();

            const holdTime = Date.now() - startTime;

            if (holdTime <= delay) {
                // Within delay time - let basic mode handle this (don't interfere)
                console.log(`[AdvancedMiddleClick] Within delay (${holdTime}ms < ${delay}ms) - letting basic mode handle`);
            } else {
                // After delay time - check if a valid selection was made
                if (currentGridSelection && currentGridSelection !== '' && currentGridSelection !== 'none') {
                    console.log(`[AdvancedMiddleClick] Setting quick action to: ${currentGridSelection}`);
                    // Update the global setting only if a valid function was selected
                    updateMiddleClickQuickAction(currentGridSelection);
                } else if (currentGridSelection === 'none') {
                    console.log('[AdvancedMiddleClick] Setting quick action to none (empty)');
                    // Update the global setting to empty only if "none" was explicitly selected
                    updateMiddleClickQuickAction('');
                } else {
                    console.log('[AdvancedMiddleClick] No valid selection made - keeping current setting');
                    // Don't change the setting if no valid selection was made
                    // Show a brief message to indicate cancellation (unless we're deleting a message or cancellation is frozen)
                    if (!isDeletingMessage && !freezeGridCancellation) {
                        const globalSettings = mainRendererReferences.globalSettingsRef.get();
                        if (globalSettings.middleClickQuickAction && globalSettings.middleClickQuickAction.trim() !== '') {
                            const actionNames = {
                                'edit': '编辑消息',
                                'copy': '复制文本',
                                'createBranch': '创建分支',
                                'readAloud': '朗读气泡',
                                'readMode': '阅读模式',
                                'regenerate': '重新回复',
                                'forward': '转发消息',
                                'delete': '删除消息'
                            };
                            mainRendererReferences.uiHelper.showToastNotification(`九宫格操作已取消，当前中键功能保持为: ${actionNames[globalSettings.middleClickQuickAction] || globalSettings.middleClickQuickAction}`, 'info');
                        } else {
                            mainRendererReferences.uiHelper.showToastNotification('九宫格操作已取消，中键快速功能未设置', 'info');
                        }
                    }
                }
            }

            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
            document.removeEventListener('mousemove', handleMouseMove);
        }
    };

    const handleMouseLeave = () => {
        console.log('[AdvancedMiddleClick] Mouse left element - cancelling');
        cleanup();
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseleave', handleMouseLeave);
        document.removeEventListener('mousemove', handleMouseMove);
    };

    const handleMouseMove = (e) => {
        if (middleClickGrid) {
            updateGridSelection(e.clientX, e.clientY);
        }
    };

    // Set timeout to show grid after delay
    const timeoutId = setTimeout(() => {
        // Only show grid if advanced mode is still active and no cleanup happened
        if (activeMiddleClickTimers.has(timerId) && !isAdvancedModeActive) {
            console.log(`[AdvancedMiddleClick] Showing grid after ${delay}ms delay`);
            isAdvancedModeActive = true;
            showMiddleClickGrid(event.clientX, event.clientY, messageItem, message);
            document.addEventListener('mousemove', handleMouseMove);

            // Set initial selection to center (none)
            currentGridSelection = 'none';

            // Ensure grid background persists by adding a CSS class
            if (middleClickGrid) {
                middleClickGrid.classList.add('persistent-background');
            }
        }
    }, delay);

    // Add immediate mouseup listener for quick release
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);

    // Store the timer for potential cleanup
    activeMiddleClickTimers.set(timerId, {
        cleanup,
        handleMouseUp,
        handleMouseLeave,
        handleMouseMove,
        timeoutId
    });
}

/**
 * Starts the middle click timer mechanism
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {string} quickAction - The quick action to perform
 */
function startMiddleClickTimer(event, messageItem, message, quickAction) {
    // 首先检查气泡是否处于完成状态
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[MiddleClick] Ignoring middle click on incomplete message: ${message?.id}`);
        return;
    }

    const timerId = `middle_click_${message.id}_${Date.now()}`;

    // Add visual feedback - change cursor and add a subtle highlight
    messageItem.style.cursor = 'grabbing';
    messageItem.style.backgroundColor = 'rgba(128, 128, 128, 0.1)';

    const startTime = Date.now();

    // Create cleanup function
    const cleanup = () => {
        messageItem.style.cursor = '';
        messageItem.style.backgroundColor = '';
        isDeletingMessage = false;
        freezeGridCancellation = false;
        // 恢复原始的 showToastNotification 函数
        if (mainRendererReferences.uiHelper.showToastNotification &&
            mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
            mainRendererReferences.uiHelper.showToastNotification =
                mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
        }
        activeMiddleClickTimers.delete(timerId);
    };

    // Set up event listeners for mouseup and mouseleave
    const handleMouseUp = (e) => {
        if (e.button === 1) { // Middle mouse button
            e.preventDefault();
            e.stopPropagation();

            const holdTime = Date.now() - startTime;

            if (holdTime <= 1000) { // Within 1 second
                console.log(`[MiddleClick] Executing quick action after ${holdTime}ms: ${quickAction}`);
                handleMiddleClickQuickAction(event, messageItem, message, quickAction);
            } else {
                console.log(`[MiddleClick] Cancelled - held for ${holdTime}ms (> 1s)`);
            }

            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
        }
    };

    const handleMouseLeave = () => {
        console.log('[MiddleClick] Cancelled - mouse left element');
        cleanup();
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseleave', handleMouseLeave);
    };

    // Add event listeners to document to catch mouseup even if mouse moves away
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);

    // Store the timer for potential cleanup
    activeMiddleClickTimers.set(timerId, {
        cleanup,
        handleMouseUp,
        handleMouseLeave,
        timeoutId: setTimeout(() => {
            console.log('[MiddleClick] Cancelled - 1 second timeout reached');
            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
        }, 1000)
    });
}

/**
 * Handles middle click quick action based on user settings
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {string} quickAction - The quick action to perform
 */
function handleMiddleClickQuickAction(event, messageItem, message, quickAction) {
    const { electronAPI, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    // 在执行操作前再次检查气泡状态（使用与初始检查相同的逻辑）
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[MiddleClick] Cancelling action on message ${message?.id} - no longer in completed state`);
        uiHelper.showToastNotification("操作已取消：气泡未完成", "warning");
        return;
    }

    console.log(`[MiddleClick] Executing quick action: ${quickAction} for message: ${message.id}`);

    switch (quickAction) {
        case 'edit':
            // 编辑消息（带智能保存功能）
            // Check if message is currently in edit mode
            const isEditing = messageItem.classList.contains('message-item-editing');
            const textarea = messageItem.querySelector('.message-edit-textarea');

            if (isEditing && textarea) {
                // Currently in edit mode - perform save operation
                console.log(`[MiddleClick] Message ${message.id} is in edit mode, performing save`);

                // Find the save button and click it
                const saveButton = messageItem.querySelector('.message-edit-controls button:first-child');
                if (saveButton) {
                    saveButton.click();
                    uiHelper.showToastNotification("中键保存完成", "success");
                } else {
                    uiHelper.showToastNotification("保存按钮未找到", "warning");
                }
            } else {
                // Not in edit mode - enter edit mode with enhanced content validation and retry mechanism
                console.log(`[MiddleClick] Entering edit mode for message ${message.id}`);

                // Enhanced content validation with retry mechanism
                const editWithRetry = async (retryCount = 0) => {
                    const maxRetries = 3;
                    const retryDelay = 200; // ms

                    try {
                        // First, try to get the most up-to-date content from multiple sources
                        let currentContent = null;

                        // Source 1: Current message object
                        if (typeof message.content === 'string' && message.content.trim() !== '') {
                            currentContent = message.content;
                        } else if (message.content && typeof message.content.text === 'string' && message.content.text.trim() !== '') {
                            currentContent = message.content.text;
                        }

                        // Source 2: If content is empty, try to get it from current chat history
                        if (!currentContent || currentContent.trim() === '') {
                            console.log(`[MiddleClick] Content appears empty, checking current chat history for message ${message.id}`);
                            const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
                            const messageInHistory = currentChatHistoryArray.find(m => m.id === message.id);

                            if (messageInHistory) {
                                if (typeof messageInHistory.content === 'string' && messageInHistory.content.trim() !== '') {
                                    currentContent = messageInHistory.content;
                                    message.content = messageInHistory.content; // Update message object
                                } else if (messageInHistory.content && typeof messageInHistory.content.text === 'string' && messageInHistory.content.text.trim() !== '') {
                                    currentContent = messageInHistory.content.text;
                                    message.content = messageInHistory.content; // Update message object
                                }
                            }
                        }

                        // Source 3: If still empty, try to get it from history file (with retry)
                        if (!currentContent || currentContent.trim() === '') {
                            console.log(`[MiddleClick] Content still empty, trying to fetch from history file for message ${message.id} (attempt ${retryCount + 1}/${maxRetries})`);

                            try {
                                const result = await electronAPI.getOriginalMessageContent(
                                    currentSelectedItemVal.id,
                                    currentSelectedItemVal.type,
                                    currentTopicIdVal,
                                    message.id
                                );

                                if (result.success && result.content) {
                                    if (typeof result.content === 'string' && result.content.trim() !== '') {
                                        currentContent = result.content;
                                        message.content = result.content;
                                    } else if (result.content.text && typeof result.content.text === 'string' && result.content.text.trim() !== '') {
                                        currentContent = result.content.text;
                                        message.content = result.content;
                                    }
                                }
                            } catch (error) {
                                console.error(`[MiddleClick] Failed to fetch content from history (attempt ${retryCount + 1}):`, error);
                            }
                        }

                        // Final validation - if still no content, retry or show error
                        if (!currentContent || currentContent.trim() === '') {
                            if (retryCount < maxRetries) {
                                console.log(`[MiddleClick] Content still empty, retrying in ${retryDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                                setTimeout(() => editWithRetry(retryCount + 1), retryDelay);
                                return;
                            } else {
                                uiHelper.showToastNotification("无法获取消息内容进行编辑，请稍后重试", "error");
                                return;
                            }
                        }

                        // Ensure content is properly formatted for editing
                        if (currentContent !== message.content) {
                            message.content = currentContent;
                        }

                        console.log(`[MiddleClick] Successfully obtained content for editing (${currentContent.length} characters)`);

                        // Now proceed with edit mode
                        try {
                            if (typeof window.toggleEditMode === 'function') {
                                window.toggleEditMode(messageItem, message);
                            } else if (contextMenu && typeof contextMenu.toggleEditMode === 'function') {
                                contextMenu.toggleEditMode(messageItem, message);
                            } else {
                                uiHelper.showToastNotification("编辑功能暂时不可用", "warning");
                            }
                        } catch (error) {
                            console.error('Failed to call toggleEditMode:', error);
                            uiHelper.showToastNotification("编辑功能暂时不可用", "warning");
                        }

                    } catch (error) {
                        console.error(`[MiddleClick] Error in editWithRetry (attempt ${retryCount + 1}):`, error);
                        if (retryCount < maxRetries) {
                            setTimeout(() => editWithRetry(retryCount + 1), retryDelay);
                        } else {
                            uiHelper.showToastNotification("编辑功能出现错误，请稍后重试", "error");
                        }
                    }
                };

                // Execute the enhanced edit function with retry mechanism
                editWithRetry();
            }
            break;

        case 'copy':
            // 复制文本
            const contentDiv = messageItem.querySelector('.md-content');
            let textToCopy = '';

            if (contentDiv) {
                const contentClone = contentDiv.cloneNode(true);
                contentClone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble').forEach(el => el.remove());
                textToCopy = contentClone.innerText.trim();
            } else {
                let contentToProcess = message.content;
                if (typeof message.content === 'object' && message.content !== null && typeof message.content.text === 'string') {
                    contentToProcess = message.content.text;
                } else if (typeof message.content !== 'string') {
                    contentToProcess = '';
                }
                textToCopy = contentToProcess.replace(/<img[^>]*>/g, '').trim();
            }

            navigator.clipboard.writeText(textToCopy).then(() => {
                uiHelper.showToastNotification("已复制渲染后的文本。", "success");
            }).catch(err => {
                console.error('Failed to copy text:', err);
                uiHelper.showToastNotification("复制失败", "error");
            });
            break;

        case 'createBranch':
            // 创建分支
            if (typeof mainRendererReferences.handleCreateBranch === 'function') {
                mainRendererReferences.handleCreateBranch(message);
                uiHelper.showToastNotification("已开始创建分支", "success");
            } else {
                uiHelper.showToastNotification("创建分支功能暂时不可用", "warning");
            }
            break;

        case 'forward':
            // 转发消息 - 执行与右键菜单完全相同的功能
            if (typeof window.showForwardModal === 'function') {
                window.showForwardModal(message);
                uiHelper.showToastNotification("已打开转发对话框", "success");
            } else {
                uiHelper.showToastNotification("转发功能暂时不可用", "warning");
            }
            break;

        case 'readAloud':
            // 朗读气泡
            if (message.role === 'assistant') {
                // Ensure audio context is activated
                if (typeof window.ensureAudioContext === 'function') {
                    window.ensureAudioContext();
                }

                const agentId = message.agentId || currentSelectedItemVal.id;
                if (!agentId) {
                    uiHelper.showToastNotification("无法确定Agent身份，无法朗读。", "error");
                    return;
                }

                electronAPI.getAgentConfig(agentId).then(agentConfig => {
                    if (agentConfig && agentConfig.ttsVoicePrimary) {
                        const contentDiv = messageItem.querySelector('.md-content');
                        let textToRead = '';
                        if (contentDiv) {
                            const contentClone = contentDiv.cloneNode(true);
                            contentClone.querySelectorAll('.vcp-tool-use-bubble').forEach(el => el.remove());
                            contentClone.querySelectorAll('.vcp-tool-result-bubble').forEach(el => el.remove());
                            textToRead = contentClone.innerText || '';
                        }

                        if (textToRead.trim()) {
                            electronAPI.sovitsSpeak({
                                text: textToRead,
                                voice: agentConfig.ttsVoicePrimary,
                                speed: agentConfig.ttsSpeed || 1.0,
                                msgId: message.id,
                                ttsRegex: agentConfig.ttsRegexPrimary,
                                voiceSecondary: agentConfig.ttsVoiceSecondary,
                                ttsRegexSecondary: agentConfig.ttsRegexSecondary
                            });
                        } else {
                            uiHelper.showToastNotification("此消息没有可朗读的文本内容。", "info");
                        }
                    } else {
                        uiHelper.showToastNotification("此Agent未配置语音模型。", "warning");
                    }
                }).catch(error => {
                    console.error("获取Agent配置以进行朗读时出错:", error);
                    uiHelper.showToastNotification("获取Agent配置失败。", "error");
                });
            } else {
                uiHelper.showToastNotification("朗读功能仅适用于助手消息。", "warning");
            }
            break;

        case 'readMode':
            // 阅读模式
            if (!currentSelectedItemVal.id || !currentTopicIdVal || !message.id) {
                uiHelper.showToastNotification("无法打开阅读模式: 上下文信息不完整。", "error");
                return;
            }

            electronAPI.getOriginalMessageContent(
                currentSelectedItemVal.id,
                currentSelectedItemVal.type,
                currentTopicIdVal,
                message.id
            ).then(result => {
                if (result.success && result.content !== undefined) {
                    const rawContent = result.content;
                    const contentString = (typeof rawContent === 'string') ? rawContent : (rawContent?.text || '');

                    const windowTitle = `阅读: ${message.id.substring(0, 10)}...`;
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';

                    if (electronAPI && typeof electronAPI.openTextInNewWindow === 'function') {
                        electronAPI.openTextInNewWindow(contentString, windowTitle, currentTheme);
                    }
                } else {
                    uiHelper.showToastNotification(`无法加载原始消息: ${result.error || '未知错误'}`, "error");
                }
            }).catch(error => {
                console.error("调用 getOriginalMessageContent 时出错:", error);
                uiHelper.showToastNotification("加载阅读模式时发生错误。", "error");
            });
            break;

        case 'regenerate':
            // 重新回复
            if (message.role === 'assistant') {
                // 获取全局设置来检查保险机制是否开启
                const globalSettings = mainRendererReferences.globalSettingsRef.get();
                const enableConfirmation = globalSettings.enableRegenerateConfirmation !== false;

                if (enableConfirmation) {
                    // 检查当前消息是否是最后一条消息
                    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
                    const lastAssistantMessage = [...currentChatHistoryArray]
                        .reverse()
                        .find(msg => msg.role === 'assistant');

                    const isLastMessage = lastAssistantMessage && lastAssistantMessage.id === message.id;

                    // 如果不是最后一条消息，显示警告对话框
                    if (!isLastMessage) {
                        const confirmRegenerate = confirm(
                            `当前消息不是最后一条消息，确定要重新生成此消息的回复吗？`
                        );

                        if (!confirmRegenerate) {
                            uiHelper.showToastNotification("重新回复操作已取消", "info");
                            return;
                        }
                    }
                }

                if (message.isGroupMessage) {
                    // 群聊重新回复逻辑
                    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
                    const currentTopicId = mainRendererReferences.currentTopicIdRef.get();

                    if (currentSelectedItem.type === 'group' && currentTopicId && message.id && message.agentId) {
                        // 调用群聊重新回复的IPC接口
                        if (mainRendererReferences.electronAPI && mainRendererReferences.electronAPI.redoGroupChatMessage) {
                            mainRendererReferences.electronAPI.redoGroupChatMessage(
                                currentSelectedItem.id,
                                currentTopicId,
                                message.id,
                                message.agentId
                            );
                            uiHelper.showToastNotification("已开始重新生成回复", "success");
                        } else {
                            uiHelper.showToastNotification("群聊重新回复功能暂时不可用", "warning");
                        }
                    } else {
                        uiHelper.showToastNotification("无法重新回复：缺少群聊上下文信息。", "error");
                    }
                } else {
                    // 非群聊重新回复逻辑（原有逻辑）
                    if (contextMenu && typeof contextMenu.handleRegenerateResponse === 'function') {
                        contextMenu.handleRegenerateResponse(message);
                        uiHelper.showToastNotification("已开始重新生成回复", "success");
                    } else {
                        uiHelper.showToastNotification("重新回复功能暂时不可用", "warning");
                    }
                }
            } else {
                uiHelper.showToastNotification("重新回复功能仅适用于助手消息。", "warning");
            }
            break;

        case 'delete':
            // 删除消息 - 完全阻止九宫格取消提示
            let textForConfirm = "";
            if (typeof message.content === 'string') {
                textForConfirm = message.content;
            } else if (message.content && typeof message.content.text === 'string') {
                textForConfirm = message.content.text;
            } else {
                textForConfirm = '[消息内容无法预览]';
            }

            if (confirm(`确定要删除此消息吗？\n"${textForConfirm.substring(0, 50)}${textForConfirm.length > 50 ? '...' : ''}"`)) {
                // 设置标志位阻止九宫格取消提示
                isDeletingMessage = true;
                freezeGridCancellation = true;

                // 立即清理所有中键相关状态和定时器
                cleanupAllMiddleClickTimers();

                // 立即重置九宫格显示状态
                if (middleClickGrid) {
                    middleClickGrid.remove();
                    middleClickGrid = null;
                }
                currentGridSelection = '';
                isAdvancedModeActive = false;

                // 创建临时的提示函数，过滤掉九宫格相关提示
                const originalShowToast = uiHelper.showToastNotification;
                let tempShowToast = function(message, type) {
                    // 拦截所有九宫格相关的提示
                    if (message.includes('九宫格操作已取消') ||
                        message.includes('中键快速功能保持为') ||
                        message.includes('中键快速功能未设置')) {
                        console.log('[Delete] Blocked grid cancellation message:', message);
                        return;
                    }
                    // 其他提示正常显示
                    return originalShowToast.call(this, message, type);
                };

                // 保存原始函数引用并临时替换
                tempShowToast.originalShowToast = originalShowToast;
                uiHelper.showToastNotification = tempShowToast;

                // 执行删除操作
                if (typeof removeMessageById === 'function') {
                    removeMessageById(message.id, true);
                    // 显示删除成功提示
                    setTimeout(() => {
                        uiHelper.showToastNotification("消息已删除", "success");
                    }, 10);
                } else {
                    setTimeout(() => {
                        uiHelper.showToastNotification("删除功能暂时不可用", "warning");
                    }, 10);
                }

                // 延迟恢复原始函数
                setTimeout(() => {
                    uiHelper.showToastNotification = originalShowToast;
                }, 200);

                // 延迟清理标志位，确保删除操作完全完成
                setTimeout(() => {
                    isDeletingMessage = false;
                    freezeGridCancellation = false;
                }, 300);
            }
            break;

        default:
            // 如果是空值或其他未知值，不执行任何操作，也不显示任何消息
            if (quickAction && quickAction.trim() !== '') {
                uiHelper.showToastNotification(`未知的快速操作: ${quickAction}`, "warning");
            }
            // 如果是空值，静默忽略，不做任何操作
    }
}

/**
 * Shows the middle click function selection grid
 * @param {number} x - Mouse X position
 * @param {number} y - Mouse Y position
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 */
function showMiddleClickGrid(x, y, messageItem, message) {
    // Remove existing grid if any
    if (middleClickGrid) {
        middleClickGrid.remove();
    }

    // Create grid container
    middleClickGrid = document.createElement('div');
    middleClickGrid.id = 'middleClickGrid';
    middleClickGrid.className = 'middle-click-grid persistent-background';
    middleClickGrid.style.position = 'fixed';
    middleClickGrid.style.left = `${x - 100}px`;
    middleClickGrid.style.top = `${y - 100}px`;
    middleClickGrid.style.width = '200px';
    middleClickGrid.style.height = '200px';
    middleClickGrid.style.zIndex = '10000';
    middleClickGrid.style.backgroundColor = 'var(--modal-bg)';
    middleClickGrid.style.border = '2px solid var(--accent-color)';
    middleClickGrid.style.borderRadius = '10px';
    middleClickGrid.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
    middleClickGrid.style.display = 'grid';
    middleClickGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    middleClickGrid.style.gridTemplateRows = 'repeat(3, 1fr)';
    middleClickGrid.style.gap = '2px';
    middleClickGrid.style.padding = '5px';

    // Grid layout: 8 functions + center "none"
    const gridFunctions = [
        'edit', 'copy', 'createBranch',
        'readAloud', 'none', 'readMode',
        'regenerate', 'forward', 'delete'
    ];

    const functionLabels = {
        'edit': '编辑',
        'copy': '复制',
        'createBranch': '分支',
        'readAloud': '朗读',
        'none': '无',
        'readMode': '阅读',
        'regenerate': '重回',
        'forward': '转发',
        'delete': '删除'
    };

    gridFunctions.forEach((func, index) => {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.function = func;
        cell.textContent = functionLabels[func];
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        cell.style.backgroundColor = 'var(--button-bg)';
        cell.style.borderRadius = '5px';
        cell.style.cursor = 'pointer';
        cell.style.fontSize = '12px';
        cell.style.fontWeight = 'bold';
        cell.style.transition = 'all 0.1s ease';

        cell.addEventListener('mouseenter', () => {
            cell.style.backgroundColor = 'var(--accent-color)';
            cell.style.color = 'white';
            currentGridSelection = func;
        });

        cell.addEventListener('mouseleave', () => {
            cell.style.backgroundColor = 'var(--button-bg)';
            cell.style.color = 'var(--primary-text)';
        });

        middleClickGrid.appendChild(cell);
    });

    // Add to body
    document.body.appendChild(middleClickGrid);

    // Ensure grid is within viewport
    const rect = middleClickGrid.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth) {
        middleClickGrid.style.left = `${viewportWidth - rect.width - 10}px`;
    }
    if (rect.bottom > viewportHeight) {
        middleClickGrid.style.top = `${viewportHeight - rect.height - 10}px`;
    }
    if (rect.left < 0) {
        middleClickGrid.style.left = '10px';
    }
    if (rect.top < 0) {
        middleClickGrid.style.top = '10px';
    }

    // Initialize current selection to center (none)
    currentGridSelection = 'none';
}

/**
 * Updates the grid selection based on mouse position
 * @param {number} mouseX - Mouse X position
 * @param {number} mouseY - Mouse Y position
 */
function updateGridSelection(mouseX, mouseY) {
    if (!middleClickGrid) return;

    const rect = middleClickGrid.getBoundingClientRect();
    const relativeX = mouseX - rect.left;
    const relativeY = mouseY - rect.top;

    // Calculate which cell the mouse is over (3x3 grid)
    const cellWidth = rect.width / 3;
    const cellHeight = rect.height / 3;

    const col = Math.floor(relativeX / cellWidth);
    const row = Math.floor(relativeY / cellHeight);

    // Ensure within bounds
    if (col >= 0 && col < 3 && row >= 0 && row < 3) {
        const cellIndex = row * 3 + col;
        const cells = middleClickGrid.querySelectorAll('.grid-cell');
        const targetCell = cells[cellIndex];

        if (targetCell) {
            // Reset all cells to default state
            cells.forEach(cell => {
                const func = cell.dataset.function;
                if (func === 'none') {
                    cell.style.backgroundColor = 'var(--button-bg)';
                    cell.style.color = 'var(--primary-text)';
                } else {
                    cell.style.backgroundColor = 'var(--bg-color)';
                    cell.style.color = 'var(--primary-text)';
                }
            });

            // Highlight target cell
            targetCell.style.backgroundColor = 'var(--accent-color)';
            targetCell.style.color = 'white';

            currentGridSelection = func;
        }
    } else {
        // Mouse is outside grid - reset selection
        currentGridSelection = '';
    }
}

/**
 * Updates the global middle click quick action setting
 * @param {string} newAction - The new action to set
 */
function updateMiddleClickQuickAction(newAction) {
    const globalSettings = mainRendererReferences.globalSettingsRef.get();

    // Update the setting
    mainRendererReferences.globalSettingsRef.set({
        ...globalSettings,
        middleClickQuickAction: newAction
    });

    // Update the UI select element
    const selectElement = document.getElementById('middleClickQuickAction');
    if (selectElement) {
        selectElement.value = newAction;
    }

    // Save settings
    if (mainRendererReferences.electronAPI && mainRendererReferences.electronAPI.saveSettings) {
        mainRendererReferences.electronAPI.saveSettings({
            ...globalSettings,
            middleClickQuickAction: newAction
        }).then(result => {
            if (result.success) {
                const actionNames = {
                    'edit': '编辑消息',
                    'copy': '复制文本',
                    'createBranch': '创建分支',
                    'readAloud': '朗读气泡',
                    'none': '无',
                    'readMode': '阅读模式',
                    'regenerate': '重新回复',
                    'forward': '转发消息',
                    'delete': '删除消息'
                };

                const actionName = actionNames[newAction] || newAction;
                if (newAction && newAction.trim() !== '') {
                    mainRendererReferences.uiHelper.showToastNotification(`中键快速功能已设置为: ${actionName}`, 'success');
                } else {
                    mainRendererReferences.uiHelper.showToastNotification('中键快速功能已清空', 'info');
                }
            } else {
                mainRendererReferences.uiHelper.showToastNotification('设置保存失败', 'error');
            }
        });
    }
}

/**
 * Test function to show the middle click grid (for testing purposes)
 */
function showTestMiddleClickGrid() {
    showMiddleClickGrid(400, 300, null, null);

    // Auto-remove after 5 seconds for testing
    setTimeout(() => {
        if (middleClickGrid) {
            middleClickGrid.remove();
            middleClickGrid = null;
        }
    }, 5000);
}

/**
 * Cleans up all active middle click timers
 */
function cleanupAllMiddleClickTimers() {
    console.log(`[MiddleClick] Cleaning up ${activeMiddleClickTimers.size} active timers`);
    for (const [timerId, timerData] of activeMiddleClickTimers.entries()) {
        if (timerData.timeoutId) {
            clearTimeout(timerData.timeoutId);
        }
        if (timerData.cleanup) {
            timerData.cleanup();
        }
    }
    activeMiddleClickTimers.clear();

    // Reset global state
    if (middleClickGrid) {
        middleClickGrid.remove();
        middleClickGrid = null;
    }
    currentGridSelection = '';
    isAdvancedModeActive = false;
    isDeletingMessage = false;
    freezeGridCancellation = false;

    // 恢复原始的 showToastNotification 函数
    if (mainRendererReferences.uiHelper.showToastNotification &&
        mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
        mainRendererReferences.uiHelper.showToastNotification =
            mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
    }
}

// Add cleanup on page unload
window.addEventListener('beforeunload', () => {
    cleanupAllMiddleClickTimers();
    isDeletingMessage = false;
    freezeGridCancellation = false;

    // 恢复原始的 showToastNotification 函数
    if (mainRendererReferences.uiHelper.showToastNotification &&
        mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
        mainRendererReferences.uiHelper.showToastNotification =
            mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
    }
});

// Also expose cleanup function for manual cleanup if needed
window.cleanupMiddleClickTimers = cleanupAllMiddleClickTimers;
window.showMiddleClickGrid = showTestMiddleClickGrid;

// Expose state for debugging
window.getMiddleClickState = () => ({
    activeTimers: activeMiddleClickTimers.size,
    gridVisible: !!middleClickGrid,
    currentSelection: currentGridSelection,
    advancedModeActive: isAdvancedModeActive,
    isDeletingMessage: isDeletingMessage,
    freezeGridCancellation: freezeGridCancellation,
    toastFunctionModified: !!(mainRendererReferences.uiHelper.showToastNotification &&
                             mainRendererReferences.uiHelper.showToastNotification.tempShowToast)
});

window.messageRenderer = {
    initializeMessageRenderer,
    setCurrentSelectedItem, // Keep for renderer.js to call
    setCurrentTopicId,      // Keep for renderer.js to call
    setCurrentItemAvatar,   // Renamed for clarity
    setUserAvatar,
    setCurrentItemAvatarColor, // Renamed
    setUserAvatarColor,
    renderMessage,
    renderHistory, // Expose the new progressive batch rendering function
    renderHistoryLegacy, // Expose the legacy rendering for compatibility
    renderMessageBatch, // Expose batch rendering utility
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    renderFullMessage,
    clearChat,
    removeMessageById,
    updateMessageContent, // Expose the new function
    isMessageInitialized: (messageId) => {
        // Check if message exists in DOM or is being tracked by streamManager
        const messageInDom = mainRendererReferences.chatMessagesDiv?.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageInDom) return true;

        // Also check if streamManager is tracking this message
        if (streamManager && typeof streamManager.isMessageInitialized === 'function') {
            return streamManager.isMessageInitialized(messageId);
        }

        return false;
    },
    summarizeTopicFromMessages: async (history, agentName) => { // Example: Keep this if it's generic enough
        // This function was passed in, so it's likely defined in renderer.js or another module.
        // If it's meant to be internal to messageRenderer, its logic would go here.
        // For now, assume it's an external utility.
        if (mainRendererReferences.summarizeTopicFromMessages) {
            return mainRendererReferences.summarizeTopicFromMessages(history, agentName);
        }
        return null;
    },
    setContextMenuDependencies: (deps) => {
        if (contextMenu && typeof contextMenu.setContextMenuDependencies === 'function') {
            contextMenu.setContextMenuDependencies(deps);
        } else {
            console.error("contextMenu or setContextMenuDependencies not available.");
        }
    }
};

