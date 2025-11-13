// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { initializeImageHandler, setContentAndProcessImages } from './renderer/imageHandler.js';
import { processAnimationsInContent, cleanupAnimationsInContent } from './renderer/animation.js';
import { createMessageSkeleton } from './renderer/domBuilder.js';
import * as streamManager from './renderer/streamManager.js';
import * as emoticonUrlFixer from './renderer/emoticonUrlFixer.js';

const colorExtractionPromises = new Map();

async function getDominantAvatarColorCached(url) {
    if (!colorExtractionPromises.has(url)) {
        colorExtractionPromises.set(url, getDominantAvatarColor(url));
    }
    return colorExtractionPromises.get(url);
}

import * as contentProcessor from './renderer/contentProcessor.js';
import * as contextMenu from './renderer/messageContextMenu.js';


import * as middleClickHandler from './renderer/middleClickHandler.js';


// --- Pre-compiled Regular Expressions for Performance ---
const TOOL_REGEX = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
const NOTE_REGEX = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:(.*?)\]\]/gs;
const BUTTON_CLICK_REGEX = /\[\[点击按钮:(.*?)\]\]/gs;
const CANVAS_PLACEHOLDER_REGEX = /\{\{VCPChatCanvas\}\}/g;
const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_FENCE_CHECK_REGEX = /```\w*\n<!DOCTYPE html>/i;
const MERMAID_CODE_REGEX = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
const MERMAID_FENCE_REGEX = /```(mermaid|flowchart|graph)\n([\s\S]*?)```/g;
const CODE_FENCE_REGEX = /```\w*([\s\S]*?)```/g;


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
    let processed = text;

    // Process VCP Tool Results
    processed = processed.replace(TOOL_RESULT_REGEX, (match, rawContent) => {
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
    processed = processed.replace(TOOL_REGEX, (match, content) => {
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
    processed = processed.replace(NOTE_REGEX, (match, rawContent) => {
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
    return text.replace(BUTTON_CLICK_REGEX, (match, content) => {
        const escapedContent = escapeHtml(content.trim());
        return `<span class="user-clicked-button-bubble">${escapedContent}</span>`;
    });
}

function transformVCPChatCanvas(text) {
    return text.replace(CANVAS_PLACEHOLDER_REGEX, () => {
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
    let cssContent = '';
    let styleInjected = false;

    const processedContent = content.replace(STYLE_REGEX, (match, css) => {
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
    if (HTML_FENCE_CHECK_REGEX.test(text)) {
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
            return line;
        }
        
        // 🟢 新增：如果行内包含 <img>，不要拆分它
        if (!inFence && line.includes('<img')) {
            return line; // 保持原样
        }
        
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
                i--;
            }
            turns.push(turn); // ✅ 使用 push
        } else if (history[i].role === 'user') {
            turns.push({ assistant: null, user: history[i] });
        }
    }
    turns.reverse(); // ✅ 最后反转一次
    
    const turnIndex = turns.findIndex(t =>
        (t.assistant?.id === messageId) || (t.user?.id === messageId)
    );
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
        text = applyFrontendRegexRules(text, agentConfig.stripRegexes, messageRole, depth);
    }
    
    // 🟢 新增：第一层修复 - Markdown 图片语法修复
    text = fixEmoticonUrlsInMarkdown(text);
    
    // 一次性处理 Mermaid（合并两种情况）
    text = text.replace(MERMAID_CODE_REGEX, (match, lang, code) => {
        const tempEl = document.createElement('textarea');
        tempEl.innerHTML = code;
        const encodedCode = encodeURIComponent(tempEl.value.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });
    
    text = text.replace(MERMAID_FENCE_REGEX, (match, lang, code) => {
        const encodedCode = encodeURIComponent(code.trim());
        return `<div class="mermaid-placeholder" data-mermaid-code="${encodedCode}"></div>`;
    });

    // 🔴 关键修复：在提取代码块之前先处理缩进
    // 这样 deIndentMisinterpretedCodeBlocks 才能正确识别代码围栏
    text = contentProcessor.deIndentMisinterpretedCodeBlocks(text);
    text = deIndentHtml(text);
    
    // 保护代码块（优化：只在需要时创建 Map）
    let codeBlockMap = null;
    let placeholderId = 0;
    
    // Use a lookahead to test without consuming the match
    const hasCodeBlocks = /```/.test(text);
    
    if (hasCodeBlocks) {
        codeBlockMap = new Map();
        text = text.replace(CODE_FENCE_REGEX, (match) => {
            const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
            codeBlockMap.set(placeholder, match);
            placeholderId++;
            return placeholder;
        });
    }

    // The order of the remaining operations is critical.
    text = contentProcessor.deIndentToolRequestBlocks(text);
    text = transformSpecialBlocks(text);
    text = ensureHtmlFenced(text);
    
    // 批量应用内容处理器（减少函数调用）
    text = contentProcessor.applyContentProcessors(text);

    // 恢复代码块
    if (codeBlockMap) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            // Use a function for replacement to handle special characters in the block
            text = text.replace(placeholder, () => block);
        }
    }

    return text;
}

/**
 * 🟢 在 Markdown 文本中修复表情包URL
 * 处理 ![alt](url) 和 <img src="url"> 两种形式
 */
function fixEmoticonUrlsInMarkdown(text) {
    if (!text || typeof text !== 'string') return text;
    
    // 1. 修复 Markdown 图片语法: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.log(`[PreprocessFix] Markdown图片: ${url} → ${fixedUrl}`);
            }
            return `![${alt}](${fixedUrl})`;
        }
        return match;
    });
    
    // 2. 修复 HTML img 标签: <img src="url" ...>
    text = text.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, url, after) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.log(`[PreprocessFix] HTML图片: ${url} → ${fixedUrl}`);
            }
            return `<img${before}src="${fixedUrl}"${after}>`;
        }
        return match;
    });
    
    return text;
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
    if (item) {
        // --- NEW: Cleanup dynamic content before removing from DOM ---
        const contentDiv = item.querySelector('.md-content');
        if (contentDiv) {
            cleanupAnimationsInContent(contentDiv);
        }
        item.remove();
    }
    
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
}

function clearChat() {
    if (mainRendererReferences.chatMessagesDiv) {
        // --- NEW: Cleanup all messages before clearing the container ---
        const allMessages = mainRendererReferences.chatMessagesDiv.querySelectorAll('.message-item');
        allMessages.forEach(item => {
            const contentDiv = item.querySelector('.md-content');
            if (contentDiv) {
                cleanupAnimationsInContent(contentDiv);
            }
        });
        mainRendererReferences.chatMessagesDiv.innerHTML = '';
    }
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
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

    // --- Event Delegation ---
    mainRendererReferences.chatMessagesDiv.addEventListener('click', (e) => {
        // 1. Handle collapsible tool results
        const header = e.target.closest('.vcp-tool-result-header');
        if (header) {
            const bubble = header.closest('.vcp-tool-result-bubble.collapsible');
            if (bubble) {
                bubble.classList.toggle('expanded');
            }
            return;
        }

        // 2. Avatar 点击停止 TTS（也使用委托）
        const avatar = e.target.closest('.message-avatar');
        if (avatar) {
            const messageItem = avatar.closest('.message-item');
            if (messageItem?.dataset.role === 'assistant') {
                mainRendererReferences.electronAPI.sovitsStop();
            }
        }
    });

    // Delegated context menu
    mainRendererReferences.chatMessagesDiv.addEventListener('contextmenu', (e) => {
        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;
        
        const messageId = messageItem.dataset.messageId;
        const message = mainRendererReferences.currentChatHistoryRef.get()
            .find(m => m.id === messageId);
        
        if (message && (message.role === 'assistant' || message.role === 'user')) {
            e.preventDefault();
            contextMenu.showContextMenu(e, messageItem, message);
        }
    });

    // Delegated middle mouse button click
    mainRendererReferences.chatMessagesDiv.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return; // 只处理中键
        
        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;
        
        const messageId = messageItem.dataset.messageId;
        const message = mainRendererReferences.currentChatHistoryRef.get()
            .find(m => m.id === messageId);
        
        if (message && (message.role === 'assistant' || message.role === 'user')) {
            e.preventDefault();
            e.stopPropagation();
            
            const globalSettings = mainRendererReferences.globalSettingsRef.get();
            if (globalSettings.enableMiddleClickQuickAction) {
                middleClickHandler.startMiddleClickTimer(e, messageItem, message, globalSettings.middleClickQuickAction);
                
                if (globalSettings.enableMiddleClickAdvanced) {
                    const delay = Math.max(1000, globalSettings.middleClickAdvancedDelay || 1000);
                    middleClickHandler.startAdvancedMiddleClickTimer(e, messageItem, message, globalSettings);
                }
            }
        }
    });
    // --- End Event Delegation ---

    // Create a new marked instance wrapper specifically for the stream manager.
    const originalMarkedParse = mainRendererReferences.markedInstance.parse.bind(mainRendererReferences.markedInstance);
    const streamingMarkedInstance = {
        ...mainRendererReferences.markedInstance,
        parse: (text) => {
            const globalSettings = mainRendererReferences.globalSettingsRef.get();
            const processedText = preprocessFullContent(text, globalSettings);
            return originalMarkedParse(processedText);
        }
    };

    contentProcessor.initializeContentProcessor(mainRendererReferences);

    const wrappedProcessRenderedContent = (contentDiv) => {
        const globalSettings = mainRendererReferences.globalSettingsRef.get();
        contentProcessor.processRenderedContent(contentDiv, globalSettings);
    };

    contextMenu.initializeContextMenu(mainRendererReferences, {
        removeMessageById: removeMessageById,
        finalizeStreamedMessage: finalizeStreamedMessage,
        renderMessage: renderMessage,
        startStreamingMessage: startStreamingMessage,
        setContentAndProcessImages: setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        renderAttachments: renderAttachments,
        interruptHandler: mainRendererReferences.interruptHandler,
    });

    if (typeof contextMenu.toggleEditMode === 'function') {
        window.toggleEditMode = contextMenu.toggleEditMode;
        window.messageContextMenu = contextMenu;
    }

    streamManager.initStreamManager({
        globalSettingsRef: mainRendererReferences.globalSettingsRef,
        currentChatHistoryRef: mainRendererReferences.currentChatHistoryRef,
        currentSelectedItemRef: mainRendererReferences.currentSelectedItemRef,
        currentTopicIdRef: mainRendererReferences.currentTopicIdRef,
        chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
        markedInstance: streamingMarkedInstance,
        electronAPI: mainRendererReferences.electronAPI,
        uiHelper: mainRendererReferences.uiHelper,
        morphdom: window.morphdom,
        renderMessage: renderMessage,
        showContextMenu: contextMenu.showContextMenu,
        setContentAndProcessImages: setContentAndProcessImages,
        processRenderedContent: wrappedProcessRenderedContent,
        runTextHighlights: contentProcessor.highlightAllPatternsInMessage,
        preprocessFullContent: preprocessFullContent,
        removeSpeakerTags: contentProcessor.removeSpeakerTags,
        ensureNewlineAfterCodeBlock: contentProcessor.ensureNewlineAfterCodeBlock,
        ensureSpaceAfterTilde: contentProcessor.ensureSpaceAfterTilde,
        removeIndentationFromCodeBlockMarkers: contentProcessor.removeIndentationFromCodeBlockMarkers,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks, // 🟢 传递新函数
        ensureSeparatorBetweenImgAndCode: contentProcessor.ensureSeparatorBetweenImgAndCode,
        processAnimationsInContent: processAnimationsInContent,
        emoticonUrlFixer: emoticonUrlFixer, // 🟢 Pass emoticon fixer for live updates
        enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
        ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
        DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
    });

    middleClickHandler.initialize(mainRendererReferences, {
        removeMessageById: removeMessageById,
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


    // 先确定颜色值（但不应用）
    let avatarColorToUse;
    let avatarUrlToUse; // This was the missing variable
    let customBorderColor = null; // 自定义边框颜色
    let customNameColor = null; // 自定义名称颜色
    let shouldApplyColorToName = false; // 是否应该将头像颜色也应用到名称
    let useThemeColors = false; // 是否使用主题颜色
    
    if (message.role === 'user') {
        avatarColorToUse = globalSettings.userAvatarCalculatedColor;
        avatarUrlToUse = globalSettings.userAvatarUrl;
        // 检查用户是否启用了"会话中使用主题颜色"
        useThemeColors = globalSettings.userUseThemeColorsInChat || false;
        
        if (!useThemeColors) {
            // 用户消息：获取自定义颜色（仅在未启用主题颜色时应用）
            customBorderColor = globalSettings.userAvatarBorderColor;
            customNameColor = globalSettings.userNameTextColor;
        }
        // 用户消息：头像颜色也应用到名称
        shouldApplyColorToName = true;
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarColorToUse = message.avatarColor;
            avatarUrlToUse = message.avatarUrl;
            // 群组消息中的Agent，获取其自定义颜色
            if (message.agentId) {
                const agentConfig = currentSelectedItem?.config?.agents?.find(a => a.id === message.agentId);
                if (agentConfig) {
                    useThemeColors = agentConfig.useThemeColorsInChat || false;
                    if (!useThemeColors) {
                        customBorderColor = agentConfig.avatarBorderColor;
                        customNameColor = agentConfig.nameTextColor;
                    }
                }
            }
        } else if (currentSelectedItem) {
            avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor
                            || currentSelectedItem.avatarCalculatedColor
                            || currentSelectedItem.config?.avatarColor
                            || currentSelectedItem.avatarColor;
            avatarUrlToUse = currentSelectedItem.avatarUrl;
            
            // 非群组消息，获取当前Agent的设置
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            if (agentConfig) {
                useThemeColors = agentConfig.useThemeColorsInChat || false;
                if (!useThemeColors) {
                    customBorderColor = agentConfig.avatarBorderColor;
                    customNameColor = agentConfig.nameTextColor;
                }
            }
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
        
        // 修复：清理 Markdown 解析器可能生成的损坏的 SVG viewBox 属性
        // 错误 "Unexpected end of attribute" 表明 viewBox 的值不完整, 例如 "0 "
        rawHtml = rawHtml.replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');
        
            // Synchronously set the base HTML content
            const finalHtml = rawHtml;
            contentDiv.innerHTML = finalHtml;

            // Define the post-processing logic as a function.
            // This allows us to control WHEN it gets executed.
            const runPostRenderProcessing = async () => {
                // This function should only be called when messageItem is connected to the DOM.
                
                // Process images, attachments, and synchronous content first.
                setContentAndProcessImages(contentDiv, finalHtml, message.id);
                renderAttachments(message, contentDiv);
                contentProcessor.processRenderedContent(contentDiv, globalSettings);
                await renderMermaidDiagrams(contentDiv); // Render mermaid diagrams

                // Defer TreeWalker-based highlighters with a hardcoded delay to ensure the DOM is stable.
                setTimeout(() => {
                    if (contentDiv && contentDiv.isConnected) {
                        contentProcessor.highlightAllPatternsInMessage(contentDiv);
                    }
                }, 0);

                // Finally, process any animations and execute scripts/3D scenes.
                processAnimationsInContent(contentDiv);
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
                
                // 如果需要，也应用到名称
                if (shouldApplyColorToName && senderNameDiv) {
                    senderNameDiv.style.color = colorStr;
                }
            } else {
                console.log(`[DEBUG] No color to apply, using default`);
                messageItem.style.removeProperty('--dynamic-avatar-color');
            }
        };

        // 如果启用了主题颜色模式，不应用任何自定义颜色，让CSS主题接管
        if (useThemeColors) {
            console.log(`[DEBUG] Using theme colors for message ${messageItem.dataset.messageId}`);
            messageItem.style.removeProperty('--dynamic-avatar-color');
            if (avatarImg) {
                avatarImg.style.removeProperty('border-color');
            }
            if (senderNameDiv) {
                senderNameDiv.style.removeProperty('color');
            }
        } else if (customBorderColor && avatarImg) {
            // 优先应用自定义颜色（如果启用且未启用主题颜色）
            console.log(`[DEBUG] Applying custom border color ${customBorderColor} to avatar`);
            avatarImg.style.borderColor = customBorderColor;
            avatarImg.style.borderWidth = '2px';
            avatarImg.style.borderStyle = 'solid';
        } else if (avatarColorToUse) {
            // 没有自定义颜色或禁用时，使用计算的颜色
            applyColorToElements(avatarColorToUse);
        } else if (avatarUrlToUse && !avatarUrlToUse.includes('default_')) { // No persisted color, try to extract
            // 🟢 Non-blocking color calculation
            // Immediately apply a default border, which will be overridden if color extraction succeeds.
            if (avatarImg) {
                avatarImg.style.borderColor = 'var(--border-color)';
            }

            getDominantAvatarColorCached(avatarUrlToUse).then(dominantColor => {
                if (dominantColor && messageItem.isConnected) {
                    // 只有在没有自定义边框颜色时才应用提取的颜色到边框
                    if (!customBorderColor) {
                        applyColorToElements(dominantColor);
                    } else if (shouldApplyColorToName && senderNameDiv) {
                        // 如果有自定义边框颜色但需要应用颜色到名称，单独处理
                        senderNameDiv.style.color = dominantColor;
                    }
                    
                    // Persist the extracted color
                    let typeToSave, idToSaveFor;
                    if (message.role === 'user') {
                        typeToSave = 'user'; idToSaveFor = 'user_global';
                    } else if (message.isGroupMessage && message.agentId) {
                        typeToSave = 'agent'; idToSaveFor = message.agentId;
                    } else if (currentSelectedItem && currentSelectedItem.type === 'agent') {
                        typeToSave = 'agent'; idToSaveFor = currentSelectedItem.id;
                    }

                    if (typeToSave && idToSaveFor) {
                        electronAPI.saveAvatarColor({ type: typeToSave, id: idToSaveFor, color: dominantColor })
                            .then(result => {
                                if (result.success) {
                                    if (typeToSave === 'user') {
                                        mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarCalculatedColor: dominantColor });
                                    } else if (typeToSave === 'agent' && idToSaveFor === currentSelectedItem.id) {
                                        if (currentSelectedItem.config) {
                                            currentSelectedItem.config.avatarCalculatedColor = dominantColor;
                                        } else {
                                            currentSelectedItem.avatarCalculatedColor = dominantColor;
                                        }
                                    }
                                }
                            });
                    }
                }
            }).catch(err => {
                console.warn(`[Color] Failed to extract dominant color for ${avatarUrlToUse}:`, err);
                // The default border is already applied, so no further action is needed on error.
            });
        } else if (!customBorderColor) { // Default avatar or no URL, reset to theme defaults (only if no custom color)
            // Remove the custom property. The CSS will automatically use its fallback values.
            messageItem.style.removeProperty('--dynamic-avatar-color');
        }
        
        // 应用自定义名称文字颜色
        if (customNameColor && senderNameDiv) {
            console.log(`[DEBUG] Applying custom name color ${customNameColor} to sender name`);
            senderNameDiv.style.color = customNameColor;
        }
        
        // 应用会话样式CSS到聊天消息
        if (message.role === 'assistant') {
            let chatCss = '';
            
            if (message.isGroupMessage && message.agentId) {
                // 群组消息中的Agent
                const agentConfig = currentSelectedItem?.config?.agents?.find(a => a.id === message.agentId);
                chatCss = agentConfig?.chatCss || '';
            } else if (currentSelectedItem) {
                // 非群组消息
                const agentConfig = currentSelectedItem.config || currentSelectedItem;
                chatCss = agentConfig?.chatCss || '';
            }
            
            // 通过动态注入<style>标签应用会话CSS
            if (chatCss && chatCss.trim()) {
                console.log(`[DEBUG] Applying chat CSS to message ${message.id}:`, chatCss);
                
                // 为此消息创建唯一的scope ID
                const chatScopeId = `vcp-chat-${message.id}`;
                messageItem.setAttribute('data-chat-scope', chatScopeId);
                
                // 检查是否已存在相同的style标签
                let existingStyle = document.head.querySelector(`style[data-chat-scope-id="${chatScopeId}"]`);
                if (existingStyle) {
                    existingStyle.remove();
                }
                
                // 创建scoped CSS（为当前消息添加作用域）
                const scopedChatCss = `[data-chat-scope="${chatScopeId}"] ${chatCss}`;
                
                // 注入到<head>
                const styleElement = document.createElement('style');
                styleElement.type = 'text/css';
                styleElement.setAttribute('data-chat-scope-id', chatScopeId);
                styleElement.textContent = scopedChatCss;
                document.head.appendChild(styleElement);
            }
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

    setContentAndProcessImages(contentDiv, rawHtml, messageId);

    // Apply post-processing in two steps
    // Step 1: Synchronous processing
    contentProcessor.processRenderedContent(contentDiv, globalSettings);
    await renderMermaidDiagrams(contentDiv);

    // Step 2: Asynchronous, deferred highlighting for DOM stability with a hardcoded delay
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.highlightAllPatternsInMessage(contentDiv);
        }
    }, 0);

    // After content is rendered, run animations/scripts/3D scenes
    processAnimationsInContent(contentDiv);

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

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    // 1. Set content and process images
    setContentAndProcessImages(contentDiv, rawHtml, messageId);

    // 2. Re-render attachments if they exist
    if (messageInHistory) {
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) existingAttachments.remove();
        renderAttachments({ ...messageInHistory, content: newContent }, contentDiv);
    }

    // 3. Synchronous processing (KaTeX, buttons, etc.)
    contentProcessor.processRenderedContent(contentDiv, globalSettings);
    renderMermaidDiagrams(contentDiv); // Fire-and-forget async rendering

    // 4. Asynchronous, deferred highlighting for DOM stability
    setTimeout(() => {
        if (contentDiv && contentDiv.isConnected) {
            contentProcessor.highlightAllPatternsInMessage(contentDiv);
        }
    }, 0);

    // 5. Re-run animations/scripts/3D scenes
    processAnimationsInContent(contentDiv);
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

    // 使用 Promise.allSettled 避免单个失败影响整体
    const results = await Promise.allSettled(
        messages.map(msg => renderMessage(msg, true, false))
    );

    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
            messageElements.push(result.value);
        } else {
            console.error(`Failed to render message ${messages[index].id}:`,
                result.reason);
        }
    });

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
/**
 * 智能批量渲染：使用 requestIdleCallback 在浏览器空闲时渲染
 */
async function renderOlderMessagesInBatches(olderMessages, batchSize, batchDelay) {
    const totalBatches = Math.ceil(olderMessages.length / batchSize);
    
    for (let i = totalBatches - 1; i >= 0; i--) {
        const startIndex = i * batchSize;
        const endIndex = Math.min(startIndex + batchSize, olderMessages.length);
        const batch = olderMessages.slice(startIndex, endIndex);
        
        // 创建批次 fragment
        const batchFragment = document.createDocumentFragment();
        const elementsForProcessing = [];
        
        for (const msg of batch) {
            const messageElement = await renderMessage(msg, true, false);
            if (messageElement) {
                batchFragment.appendChild(messageElement);
                elementsForProcessing.push(messageElement);
            }
        }
        
        // 🟢 使用 requestIdleCallback 在空闲时插入（降级到 requestAnimationFrame）
        await new Promise(resolve => {
            const insertBatch = () => {
                const chatMessagesDiv = mainRendererReferences.chatMessagesDiv;
                let insertPoint = chatMessagesDiv.firstChild;
                while (insertPoint?.classList?.contains('topic-timestamp-bubble')) {
                    insertPoint = insertPoint.nextSibling;
                }
                
                if (insertPoint) {
                    chatMessagesDiv.insertBefore(batchFragment, insertPoint);
                } else {
                    chatMessagesDiv.appendChild(batchFragment);
                }

                elementsForProcessing.forEach(el => {
                    if (typeof el._vcp_process === 'function') {
                        el._vcp_process();
                        delete el._vcp_process;
                    }
                });

                resolve();
            };

            // 优先使用 requestIdleCallback，不支持时降级到 rAF
            if ('requestIdleCallback' in window) {
                requestIdleCallback(insertBatch, { timeout: 1000 });
            } else {
                requestAnimationFrame(insertBatch);
            }
        });
        
        // 动态调整延迟：如果批次小，减少延迟
        if (i > 0 && batchDelay > 0) {
            const actualDelay = batch.length < batchSize / 2 ? batchDelay / 2 : batchDelay;
            await new Promise(resolve => setTimeout(resolve, actualDelay));
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

