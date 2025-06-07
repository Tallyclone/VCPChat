// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

// --- Smooth Streaming Constants & State ---
// const ENABLE_SMOOTH_STREAMING = false; // Master switch for the feature - Will be read from globalSettings
// const SMOOTH_STREAM_INTERVAL_MS = 25; // Interval for processing the chunk queue (ms) - Will be read from globalSettings
// const MIN_CHUNK_BUFFER_SIZE = 1; // Minimum characters to try to batch for rendering in one go. - Will be read from globalSettings

const streamingChunkQueues = new Map(); // messageId -> array of original chunk strings
const streamingTimers = new Map();      // messageId -> intervalId
// Stores the full text received so far, even if not yet rendered by the smooth timer.
// This is crucial for features like VCP/Diary block detection that need the complete context.
const accumulatedStreamText = new Map(); // messageId -> string
// pendingRenderBuffer is no longer needed with per-character queuing and batching in processAndRenderSmoothChunk


// Cache for dominant avatar colors
const avatarColorCache = new Map();

// --- Helper functions for color conversion ---
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, l * 100]; // Hue in degrees, S/L in %
}

function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    let c = (1 - Math.abs(2 * l - 1)) * s,
        x = c * (1 - Math.abs((h / 60) % 2 - 1)),
        m = l - c / 2,
        r = 0, g = 0, b = 0;

    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else if (300 <= h && h < 360) { r = c; g = 0; b = x; }
    
    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    return `rgb(${r},${g},${b})`;
}

// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
    const css = `
            /* Keyframes for animations */
            @keyframes vcp-bubble-background-flow-kf {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }

            @keyframes vcp-bubble-border-flow-kf {
                0% { background-position: 0% 50%; }
                50% { background-position: 200% 50%; } /* Adjusted for more color travel */
                100% { background-position: 0% 50%; }
            }

            @keyframes vcp-icon-rotate {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            @keyframes vcp-icon-heartbeat {
                0% { transform: scale(1); opacity: 0.6; }
                50% { transform: scale(1.15); opacity: 0.9; }
                100% { transform: scale(1); opacity: 0.6; }
            }

            @keyframes vcp-toolname-color-flow-kf {
                0% { background-position: 0% 50%; }
                50% { background-position: 150% 50%; } /* Adjusted for smoother flow with 300% background-size */
                100% { background-position: 0% 50%; }
            }


            /* Loading dots animation */
            @keyframes vcp-loading-dots {
              0%, 20% {
                color: rgba(0,0,0,0);
                text-shadow:
                  .25em 0 0 rgba(0,0,0,0),
                  .5em 0 0 rgba(0,0,0,0);
              }
              40% {
                color: currentColor; /* Or a specific color */
                text-shadow:
                  .25em 0 0 rgba(0,0,0,0),
                  .5em 0 0 rgba(0,0,0,0);
              }
              60% {
                text-shadow:
                  .25em 0 0 currentColor, /* Or a specific color */
                  .5em 0 0 rgba(0,0,0,0);
              }
              80%, 100% {
                text-shadow:
                  .25em 0 0 currentColor, /* Or a specific color */
                  .5em 0 0 currentColor; /* Or a specific color */
              }
            }

            .thinking-indicator-dots {
              display: inline-block;
              font-size: 1em; /* Match parent font-size by default */
              line-height: 1; /* Ensure it doesn't add extra height */
              vertical-align: baseline; /* Align with the text */
              animation: vcp-loading-dots 1.4s infinite;
            }

            /* 主气泡样式 - VCP ToolUse */
            .vcp-tool-use-bubble {
                background: linear-gradient(145deg, #3a7bd5 0%, #00d2ff 100%) !important;
                background-size: 200% 200% !important; 
                animation: vcp-bubble-background-flow-kf 20s ease-in-out infinite;
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; 
                color: #ffffff !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                position: relative;
                overflow: hidden; 
                line-height: 1.5;
                display: inline-block !important; /* Allow bubble to shrink to content width */
            }

            /* Animated Border for VCP ToolUse */
            .vcp-tool-use-bubble::after {
                content: "";
                position: absolute;
                box-sizing: border-box; 
                top: 0; left: 0; width: 100%; height: 100%;
                border-radius: inherit;
                padding: 2px; /* Border thickness */
                background: linear-gradient(60deg, #76c4f7, #00d2ff, #3a7bd5, #ffffff, #3a7bd5, #00d2ff, #76c4f7);
                background-size: 300% 300%;
                animation: vcp-bubble-border-flow-kf 7s linear infinite;
                -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                z-index: 0; 
                pointer-events: none;
            }


            /* 内部 code 和 span 的重置 - VCP ToolUse */
            .vcp-tool-use-bubble code,
            .vcp-tool-use-bubble code span,
            .vcp-tool-use-bubble .vcp-tool-label, 
            .vcp-tool-use-bubble .vcp-tool-name-highlight 
             {
                background: none !important; border: none !important;
                padding: 0 !important; margin: 0 !important;
                box-shadow: none !important; color: inherit !important;
                display: inline !important;
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
                font-size: 0.95em !important;
                vertical-align: baseline;
                position: relative; 
                z-index: 1;
            }

            /* "VCP-ToolUse:" 标签 */
            .vcp-tool-use-bubble .vcp-tool-label {
                font-weight: bold; color: #f1c40f; margin-right: 6px;
            }

            /* 工具名高亮 - VCP ToolUse */
            .vcp-tool-use-bubble .vcp-tool-name-highlight {
                background: linear-gradient(90deg, #f1c40f, #ffffff, #00d2ff, #f1c40f) !important; 
                background-size: 300% 100% !important; 
                -webkit-background-clip: text !important;
                background-clip: text !important;
                -webkit-text-fill-color: transparent !important;
                text-fill-color: transparent !important;
                font-style: normal !important;
                font-weight: bold !important;
                padding: 1px 3px !important; 
                border-radius: 4px !important;
                animation: vcp-toolname-color-flow-kf 4s linear infinite; 
                margin-left: 2px; 
            }

            /* 左上角齿轮图标 - VCP ToolUse */
            .vcp-tool-use-bubble::before {
                content: "⚙️";
                position: absolute;
                top: 8px;
                left: 10px;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.75); 
                z-index: 2; 
                animation: vcp-icon-rotate 4s linear infinite;
                transform-origin: center center; 
            }

            /* 隐藏 VCP 气泡内的复制按钮 */
            .vcp-tool-use-bubble code .code-copy { /* This might target <code> inside <pre class="vcp-tool-use-bubble"> */
                display: none !important;
            }
             /* Also hide if copy button is direct child of the bubble (if no inner code element) */
            .vcp-tool-use-bubble > .code-copy {
                display: none !important;
            }
            .vcp-tool-request-bubble > strong { display: none !important; } /* Hide "VCP工具调用:" strong tag if it was ever added */


            /* 女仆日记气泡样式 */
            .maid-diary-bubble {
                background: linear-gradient(145deg, #fdeff2 0%, #fce4ec 100%) !important; 
                background-size: 200% 200% !important; 
                animation: vcp-bubble-background-flow-kf 14s ease-in-out infinite; 
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; 
                color: #5d4037 !important; 
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
                margin-bottom: 10px !important;
                position: relative;
                overflow: hidden; /* Keep for safety, though wrapping should prevent overflow */
                line-height: 1.5;
                /* Styles for the <pre> tag itself to ensure wrapping */
                display: block; /* Or inline-block if shrink-to-fit is desired */
                white-space: normal !important; /* Crucial: Override <pre> default */
                word-break: break-word !important; /* Crucial: Allow long words to break */
                font-family: 'Georgia', 'Times New Roman', serif !important; /* Match inner content font */
            }

            /* Animated Border for Maid Diary */
            .maid-diary-bubble::after {
                content: "";
                position: absolute;
                box-sizing: border-box; 
                top: 0; left: 0; width: 100%; height: 100%;
                border-radius: inherit;
                padding: 2px; /* Border thickness */
                background: linear-gradient(60deg, #f8bbd0, #fce4ec, #e91e63, #ffffff, #e91e63, #fce4ec, #f8bbd0);
                background-size: 300% 300%;
                animation: vcp-bubble-border-flow-kf 20s linear infinite; 
                -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                z-index: 0; 
                pointer-events: none;
            }

            /* 女仆日记气泡内部 code 和 span 的重置 */
            .maid-diary-bubble code, /* If there's an inner <code> */
            .maid-diary-bubble code span,
            .maid-diary-bubble .maid-label 
            {
                background: none !important; border: none !important;
                padding: 0 !important; margin: 0 !important;
                box-shadow: none !important; color: inherit !important;
                display: block !important; /* Changed for proper wrapping */
                white-space: normal !important; /* Allow text to wrap normally */
                word-break: break-word !important; /* Break words if they are too long */
                font-family: 'Georgia', 'Times New Roman', serif !important; 
                font-size: 0.98em !important;
                vertical-align: baseline;
                position: relative; 
                z-index: 1;
            }
             .maid-diary-bubble .maid-label {
                display: block !important; 
                margin-bottom: 5px !important; 
            }


            /* 女仆日记气泡 "Maid" 标签 */
            .maid-diary-bubble .maid-label {
                font-weight: bold; color: #c2185b; margin-right: 6px; 
                font-family: 'Georgia', 'Times New Roman', serif !important; 
            }

            /* 女仆日记气泡左上角图标 */
            .maid-diary-bubble::before {
                content: "🎀"; 
                position: absolute;
                top: 8px;
                left: 10px;
                font-size: 16px;
                color: rgba(227, 96, 140, 0.85); 
                z-index: 2; 
                animation: vcp-icon-heartbeat 2.5s ease-in-out infinite;
                transform-origin: center center; 
            }

            /* 隐藏女仆日记气泡内的复制按钮 */
            .maid-diary-bubble code .code-copy { /* If copy is inside <code> */
                display: none !important;
            }
            .maid-diary-bubble > .code-copy { /* If copy is direct child of <pre> */
                 display: none !important;
            }

            /* HTML5 音频播放器样式 */
            audio[controls] {
                background: transparent !important; /* 将背景设置为透明 */
                border: none !important; /* 移除边框 */
                border-radius: 10px !important;
                padding: 10px 15px !important;
                color: #ffffff !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                display: block;
                width: 350px;
                position: relative; /* Added for pseudo-element positioning */
                overflow: hidden; /* Added to contain the pseudo-element */
                z-index: 1; /* Ensure audio player is above the pseudo-element */
            }
            /* Animated Border for Audio Player */
            audio[controls]::after {
                content: "";
                position: absolute;
                box-sizing: border-box;
                top: 0; left: 0; width: 100%; height: 100%;
                border-radius: inherit;
                padding: 2px; /* Border thickness */
                background: linear-gradient(60deg, #76c4f7, #00d2ff, #3a7bd5, #ffffff, #3a7bd5, #00d2ff, #76c4f7); /* Same gradient as VCP ToolUse bubble */
                background-size: 300% 300%;
                animation: vcp-bubble-border-flow-kf 7s linear infinite; /* Same animation as VCP ToolUse bubble */
                -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                z-index: 0; /* Place behind the actual audio controls */
                pointer-events: none;
            }
            audio[controls]::-webkit-media-controls-panel {
                background: #ffffff !important;
                border-radius: 9px !important;
                margin: 5px !important;
                padding: 5px !important;
                box-sizing: border-box !important;
                position: relative; /* Ensure panel is above the pseudo-element */
                z-index: 2; /* Increase z-index for the panel to be on top of the pseudo-element */
            }
            audio[controls]::-webkit-media-controls-play-button,
            audio[controls]::-webkit-media-controls-mute-button,
            audio[controls]::-webkit-media-controls-fullscreen-button,
            audio[controls]::-webkit-media-controls-overflow-button {
                filter: brightness(0.3) contrast(1.5) !important;
            }
            audio[controls]::-webkit-media-controls-current-time-display,
            audio[controls]::-webkit-media-controls-time-remaining-display {
                color: #181818 !important;
                text-shadow: none !important;
            }
            audio[controls]::-webkit-media-controls-timeline {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 4px !important;
                height: 6px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-webkit-slider-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0, 0, 0, 0.3) !important;
                box-shadow: 0 0 2px rgba(0,0,0,0.3) !important;
                height: 12px !important;
                width: 12px !important;
                border-radius: 50% !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-moz-range-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0, 0, 0, 0.3) !important;
                height: 12px !important;
                width: 12px !important;
                border-radius: 50% !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-moz-range-track {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 4px !important;
                height: 6px !important;
            }
            audio[controls]::-webkit-media-controls-volume-slider {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 3px !important;
                height: 4px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-volume-slider::-webkit-slider-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0,0,0,0.3) !important;
                height: 10px !important;
                width: 10px !important;
                border-radius: 50% !important;
            }

           /* Context Menu Item Colors */
           .context-menu-item.danger-item {
               color:hsl(1, 83.80%, 61.20%) !important; /* Red */
           }
           .context-menu-item.danger-item:hover {
               background-color: rgba(229, 57, 53, 0.1) !important;
           }
           .context-menu-item.info-item {
               color:rgb(90, 171, 238) !important; /* Lighter Blue */
           }
           .context-menu-item.info-item:hover {
               background-color: rgba(30, 136, 229, 0.1) !important;
           }
           .context-menu-item.regenerate-text {
               color: #43A047 !important; /* Green for regenerate */
           }
           .context-menu-item.regenerate-text:hover {
               background-color: rgba(67, 160, 71, 0.1) !important;
           }

           /* Highlight for quoted text */
           .md-content .highlighted-quote { /* Increased specificity */
               color: var(--quoted-text) !important; /* Use CSS variable and !important */
               /* font-style: italic; */ /* Optional: if italics are desired */
           }

           /* AI 发送的链接样式 */
           .md-content a {
               color: #87CEEB !important; /* 柔和的天蓝色 */
           }
   `;
    try {
        const existingStyleElement = document.getElementById('vcp-enhanced-ui-styles');
        if (existingStyleElement) {
            existingStyleElement.textContent = css; 
        } else {
            const styleElement = document.createElement('style');
            styleElement.id = 'vcp-enhanced-ui-styles';
            styleElement.textContent = css;
            document.head.appendChild(styleElement);
        }
        // console.log('VCPSub Enhanced UI: Styles injected/updated.'); // Reduced logging
    } catch (error) {
        console.error('VCPSub Enhanced UI: Failed to inject styles:', error);
    }
}

function shouldEnableSmoothStreaming(/* messageId */) {
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const enabled = globalSettings.enableSmoothStreaming === true; // Ensure it's explicitly true
    // console.log('[SmoothStreamCheck] shouldEnableSmoothStreaming called. Global setting:', globalSettings.enableSmoothStreaming, 'Returning:', enabled);
    return enabled;
}

/**
 * Extracts a more vibrant and representative color from an image.
 * @param {string} imageUrl The URL of the image.
 * @param {function(string|null)} callback Called with the CSS color string (e.g., "rgb(r,g,b)") or null on error.
 */
async function getDominantAvatarColor(imageUrl) {
    if (!imageUrl) return null;

    const cacheKey = imageUrl.split('?')[0];
    if (avatarColorCache.has(cacheKey)) {
        return avatarColorCache.get(cacheKey);
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = imageUrl;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const tempCanvasSize = 30;
            canvas.width = tempCanvasSize;
            canvas.height = tempCanvasSize;
            ctx.drawImage(img, 0, 0, tempCanvasSize, tempCanvasSize);

            let bestHue = null;
            let maxSaturation = -1;
            let r_sum = 0, g_sum = 0, b_sum = 0, pixelCount = 0;

            try {
                const imageData = ctx.getImageData(0, 0, tempCanvasSize, tempCanvasSize);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i+1], b = data[i+2], alpha = data[i+3];
                    if (alpha < 128) continue;
                    const [h, s, l] = rgbToHsl(r, g, b);
                    if (s > 20 && l >= 30 && l <= 80) {
                        if (s > maxSaturation) { maxSaturation = s; bestHue = h; }
                        r_sum += r; g_sum += g; b_sum += b; pixelCount++;
                    }
                }
                let finalColorString = null;
                if (bestHue !== null) {
                    finalColorString = hslToRgb(bestHue, 75, 55);
                } else if (pixelCount > 0) {
                    const [h_avg, s_avg, l_avg] = rgbToHsl(r_sum/pixelCount, g_sum/pixelCount, b_sum/pixelCount);
                    finalColorString = hslToRgb(h_avg, s_avg, Math.max(40, Math.min(70, l_avg)));
                }
                avatarColorCache.set(cacheKey, finalColorString);
                resolve(finalColorString);
            } catch (e) {
                console.error(`[AvatarColor] Error processing ${imageUrl}:`, e);
                avatarColorCache.set(cacheKey, null);
                resolve(null);
            }
        };
        img.onerror = () => {
            console.warn(`Failed to load image for color extraction: ${imageUrl}`);
            avatarColorCache.set(cacheKey, null);
            resolve(null);
        };
    });
}

// --- Enhanced Rendering Core Logic ---

/**
 * Ensures that triple backticks for code blocks are followed by a newline.
 * @param {string} text The input string.
 * @returns {string} The processed string with newlines after ``` if they were missing.
 */
function ensureNewlineAfterCodeBlock(text) {
    if (typeof text !== 'string') return text;
    // Replace ``` (possibly with leading spaces) not followed by \n or \r\n with the same ``` (and spaces) followed by \n
    return text.replace(/^(\s*```)(?![\r\n])/gm, '$1\n');
}

/**
 * Ensures that a tilde (~) is followed by a space.
 * @param {string} text The input string.
 * @returns {string} The processed string with spaces after tildes where they were missing.
 */
function ensureSpaceAfterTilde(text) {
    if (typeof text !== 'string') return text;
    // Replace ~ not followed by a space with ~ followed by a space
    return text.replace(/~(?![\s~])/g, '~ ');
}

/**
 * Removes leading whitespace from lines starting with ``` (code block markers).
 * @param {string} text The input string.
 * @returns {string} The processed string.
 */
function removeIndentationFromCodeBlockMarkers(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/^(\s*)(```.*)/gm, '$2');
}

/**
 * Removes speaker tags like "[Sender's speech]: " from the beginning of a string.
 * @param {string} text The input string.
 * @returns {string} The processed string without the leading speaker tag.
 */
function removeSpeakerTags(text) {
    if (typeof text !== 'string') return text;
    const speakerTagRegex = /^\[(?:(?!\]:\s).)*的发言\]:\s*/;
    let newText = text;
    // Loop to remove all occurrences of the speaker tag at the beginning of the string
    while (speakerTagRegex.test(newText)) {
        newText = newText.replace(speakerTagRegex, '');
    }
    return newText;
}

/**
 * Parses VCP tool_name from content.
 * Example: tool_name:「始」SciCalculator「末」
 * @param {string} toolContent - The raw string content of the tool request (text between <<<TOOL_REQUEST>>> and <<<END_TOOL_REQUEST>>>).
 * @returns {string|null} The extracted tool name or null.
 */
function extractVcpToolName(toolContent) {
    const match = toolContent.match(/tool_name:\s*「始」([^「」]+)「末」/);
    return match ? match[1] : null;
}

/**
 * Prettifies a single <pre> code block for DailyNote or VCP ToolUse.
 * @param {HTMLElement} preElement - The <pre> element to prettify.
 * @param {'dailynote' | 'vcptool'} type - The type of block.
 * @param {string} relevantContent - For VCP, it's the text between tool markers. For DailyNote, it's text between diary markers.
 */
function prettifySinglePreElement(preElement, type, relevantContent) {
    if (!preElement || preElement.dataset.vcpPrettified === "true" || preElement.dataset.maidDiaryPrettified === "true") {
        return;
    }

    let targetContentElement = preElement.querySelector('code') || preElement; 

    const copyButton = targetContentElement.querySelector('.code-copy, .fa-copy');
    if (copyButton) {
        copyButton.remove(); // Remove existing copy button
    }
    
    if (type === 'vcptool') {
        preElement.classList.add('vcp-tool-use-bubble');
        const toolName = extractVcpToolName(relevantContent); 

        let newInnerHtml = `<span class="vcp-tool-label">ToolUse:</span>`;
        if (toolName) {
            newInnerHtml += `<span class="vcp-tool-name-highlight">${toolName}</span>`;
        } else {
            newInnerHtml += `<span class="vcp-tool-name-highlight">UnknownTool</span>`; 
        }
        
        targetContentElement.innerHTML = newInnerHtml; 
        preElement.dataset.vcpPrettified = "true";

    } else if (type === 'dailynote') {
        preElement.classList.add('maid-diary-bubble');
        let actualNoteContent = relevantContent.trim(); 
        
        let finalHtml = "";
        const lines = actualNoteContent.split('\n');
        const firstLineTrimmed = lines[0] ? lines[0].trim() : "";

        if (firstLineTrimmed.startsWith('Maid:')) {
            finalHtml = `<span class="maid-label">${lines.shift().trim()}</span>`;
            finalHtml += lines.join('\n');
        } else if (firstLineTrimmed.startsWith('Maid')) { 
            finalHtml = `<span class="maid-label">${lines.shift().trim()}</span>`;
            finalHtml += lines.join('\n');
        } else {
            finalHtml = actualNoteContent; 
        }
        
        targetContentElement.innerHTML = finalHtml.replace(/\n/g, '<br>');
        preElement.dataset.maidDiaryPrettified = "true";
    }
}

/**
 * Highlights @tag patterns within the text nodes of a given HTML element.
 * This function should be called AFTER Markdown and LaTeX rendering.
 * @param {HTMLElement} messageElement - The HTML element containing the message content.
 */
function highlightTagsInMessage(messageElement) {
    if (!messageElement) return;

    const tagRegex = /@([\u4e00-\u9fa5A-Za-z0-9_]+)/g;
    const walker = document.createTreeWalker(
        messageElement,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    let node;
    const nodesToProcess = [];

    while (node = walker.nextNode()) {
        if (node.parentElement.tagName === 'STYLE' ||
            node.parentElement.tagName === 'SCRIPT' ||
            node.parentElement.classList.contains('highlighted-tag')) {
            continue;
        }

        const text = node.nodeValue;
        let match;
        const matches = [];
        tagRegex.lastIndex = 0;
        while ((match = tagRegex.exec(text)) !== null) {
            matches.push({
                index: match.index,
                tagText: match[0],
                tagName: match[1]
            });
        }

        if (matches.length > 0) {
            nodesToProcess.push({ node, matches });
        }
    }

    for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node, matches } = nodesToProcess[i];
        let currentNode = node;

        for (let j = matches.length - 1; j >= 0; j--) {
            const matchInfo = matches[j];
            const textAfterMatch = currentNode.splitText(matchInfo.index + matchInfo.tagText.length);
            
            const span = document.createElement('span');
            span.className = 'highlighted-tag';
            span.textContent = matchInfo.tagText;

            currentNode.parentNode.insertBefore(span, textAfterMatch);
            currentNode.nodeValue = currentNode.nodeValue.substring(0, matchInfo.index);
        }
    }
}


/**
 * Highlights text within double quotes in a given HTML element.
 * This function should be called AFTER Markdown and LaTeX rendering.
 * @param {HTMLElement} messageElement - The HTML element containing the message content.
 */
function highlightQuotesInMessage(messageElement) {
    if (!messageElement) return;

    const quoteRegex = /(?:"([^"]*)"|“([^”]*)”)/g; // Matches English "..." and Chinese “...”
    const walker = document.createTreeWalker(
        messageElement,
        NodeFilter.SHOW_TEXT,
        (node) => { // Filter to exclude nodes inside already highlighted quotes or tags, or style/script/pre/code/katex
            let parent = node.parentElement;
            while (parent && parent !== messageElement && parent !== document.body) {
                if (parent.classList.contains('highlighted-quote') ||
                    parent.classList.contains('highlighted-tag') ||
                    parent.classList.contains('katex') || // Ensure KaTeX elements are skipped
                    parent.tagName === 'STYLE' ||
                    parent.tagName === 'SCRIPT' ||
                    parent.tagName === 'PRE' ||
                    parent.tagName === 'CODE') {
                    return NodeFilter.FILTER_REJECT;
                }
                parent = parent.parentElement;
            }
            // Direct parent check (should be redundant if loop is correct, but safe)
            if (node.parentElement && (
                node.parentElement.classList.contains('highlighted-quote') ||
                node.parentElement.classList.contains('highlighted-tag') ||
                node.parentElement.classList.contains('katex') || // Ensure KaTeX elements are skipped
                node.parentElement.tagName === 'STYLE' ||
                node.parentElement.tagName === 'SCRIPT' ||
                node.parentElement.tagName === 'PRE' ||
                node.parentElement.tagName === 'CODE')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
        false
    );

    let node;
    const nodesToProcess = [];

    while (node = walker.nextNode()) {
        const text = node.nodeValue;
        let match;
        const matches = [];
        quoteRegex.lastIndex = 0; // Reset regex state for each node
        while ((match = quoteRegex.exec(text)) !== null) {
            // Check if any of the capturing groups (content inside quotes) have content
            const contentGroup1 = match[1]; // Content for "..."
            const contentGroup2 = match[2]; // Content for “...”
            
            if ((contentGroup1 && contentGroup1.length > 0) ||
                (contentGroup2 && contentGroup2.length > 0)) {
                matches.push({
                    index: match.index,
                    fullMatch: match[0], // The full quoted string, e.g., "text" or “text”
                });
            }
        }

        if (matches.length > 0) {
            nodesToProcess.push({ node, matches });
        }
    }

    for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node, matches } = nodesToProcess[i];
        
        // Ensure matches are processed in the order they appear in the text
        // The regex exec loop already provides them in order.

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        const originalText = node.nodeValue;

        for (const matchInfo of matches) { // Iterate matches in the order they appeared
            // Text before the current match
            if (matchInfo.index > lastIndex) {
                fragment.appendChild(document.createTextNode(originalText.substring(lastIndex, matchInfo.index)));
            }
            
            // The highlighted match
            const span = document.createElement('span');
            span.className = 'highlighted-quote';
            span.textContent = matchInfo.fullMatch; // matchInfo.fullMatch includes the quotes themselves
            fragment.appendChild(span);

            lastIndex = matchInfo.index + matchInfo.fullMatch.length;
        }

        // Text after the last match
        if (lastIndex < originalText.length) {
            fragment.appendChild(document.createTextNode(originalText.substring(lastIndex)));
        }

        // Replace the original text node with the fragment
        if (node.parentNode) { // Ensure node is still in the DOM
            node.parentNode.replaceChild(fragment, node);
        }
    }
}


/**
 * Processes all relevant <pre> blocks within a message's contentDiv AFTER marked.parse().
 * @param {HTMLElement} contentDiv - The div containing the parsed Markdown.
 */
function processAllPreBlocksInContentDiv(contentDiv) {
    if (!contentDiv) return;

    const allPreElements = contentDiv.querySelectorAll('pre');
    allPreElements.forEach(preElement => {
        if (preElement.dataset.vcpPrettified === "true" || preElement.dataset.maidDiaryPrettified === "true") {
            return; // Already processed
        }

        const codeElement = preElement.querySelector('code'); 
        const blockText = codeElement ? (codeElement.textContent || "") : (preElement.textContent || "");

        // Check for VCP Tool Request
        if (blockText.includes('<<<[TOOL_REQUEST]>>>') && blockText.includes('<<<[END_TOOL_REQUEST]>>>')) {
            const vcpContentMatch = blockText.match(/<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/);
            const actualVcpText = vcpContentMatch ? vcpContentMatch[1].trim() : ""; 
            prettifySinglePreElement(preElement, 'vcptool', actualVcpText);
        } 
        // Check for DailyNote (ensure it's not already processed as VCP)
        else if (blockText.includes('<<<DailyNoteStart>>>') && blockText.includes('<<<DailyNoteEnd>>>') && !preElement.dataset.vcpPrettified) {
            const dailyNoteContentMatch = blockText.match(/<<<DailyNoteStart>>>([\s\S]*?)<<<DailyNoteEnd>>>/); // Corrected closing tag <<<DailyNoteEnd>>>
            const actualDailyNoteText = dailyNoteContentMatch ? dailyNoteContentMatch[1].trim() : ""; 
            prettifySinglePreElement(preElement, 'dailynote', actualDailyNoteText);
        }
    });
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

function initializeMessageRenderer(refs) {
    mainRendererReferences.currentChatHistoryRef = refs.currentChatHistoryRef;
    mainRendererReferences.currentSelectedItemRef = refs.currentSelectedItemRef;
    mainRendererReferences.currentTopicIdRef = refs.currentTopicIdRef;
    mainRendererReferences.globalSettingsRef = refs.globalSettingsRef;
    mainRendererReferences.chatMessagesDiv = refs.chatMessagesDiv;
    mainRendererReferences.electronAPI = refs.electronAPI;
    mainRendererReferences.markedInstance = refs.markedInstance;
    mainRendererReferences.uiHelper = refs.uiHelper || mainRendererReferences.uiHelper; // Merge if some helpers are passed
    mainRendererReferences.summarizeTopicFromMessages = refs.summarizeTopicFromMessages;
    mainRendererReferences.handleCreateBranch = refs.handleCreateBranch;
    
    injectEnhancedStyles();
    console.log("[MessageRenderer] Initialized. Current selected item type on init:", mainRendererReferences.currentSelectedItemRef.get().type);
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


async function renderMessage(message, isInitialLoad = false) {
    console.log('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message))); // Log incoming message
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentChatHistory = mainRendererReferences.currentChatHistoryRef.get();


    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const messageItem = document.createElement('div');
    messageItem.classList.add('message-item', message.role);
    if (message.isGroupMessage) messageItem.classList.add('group-message-item');
    messageItem.dataset.timestamp = String(message.timestamp);
    messageItem.dataset.messageId = message.id;
    if (message.agentId) messageItem.dataset.agentId = message.agentId; // For group messages

    if (message.role !== 'system' && !message.isThinking) {
        messageItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, messageItem, message);
        });
    }
    
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('md-content');

    let avatarImg, nameTimeDiv, senderNameDiv, detailsAndBubbleWrapper;
    let avatarUrlToUse, senderNameToUse, avatarColorToUse;

    if (message.role === 'user') {
        avatarUrlToUse = globalSettings.userAvatarUrl || 'assets/default_user_avatar.png';
        senderNameToUse = message.name || globalSettings.userName || '你'; // message.name for user if provided (e.g. in group chat history)
        avatarColorToUse = globalSettings.userAvatarCalculatedColor;
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            // This is a message from an agent within a group
            if (message.avatarUrl) { // If the specific agent in the group has an avatar
                avatarUrlToUse = message.avatarUrl;
            } else { // Agent in group has no specific avatar, use a default AGENT avatar
                avatarUrlToUse = 'assets/default_avatar.png';
            }
            senderNameToUse = message.name || '群成员';
            avatarColorToUse = message.avatarColor;
        } else if (currentSelectedItem && currentSelectedItem.avatarUrl) {
            // This is a message from a directly selected agent (not in a group context for this message)
            // OR it's a fallback if somehow a group message didn't get its specific avatar logic handled above (less likely now)
            avatarUrlToUse = currentSelectedItem.avatarUrl;
            senderNameToUse = message.name || currentSelectedItem.name || 'AI';
            avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor;
        } else { // Absolute fallback (e.g., no selected item, or selected item has no avatar)
            avatarUrlToUse = 'assets/default_avatar.png';
            senderNameToUse = message.name || 'AI';
            avatarColorToUse = null;
        }
    }
    console.log(`[MessageRenderer renderMessage] For message ID ${message.id}, role ${message.role}, isGroup: ${message.isGroupMessage}, determined avatarUrlToUse: ${avatarUrlToUse}, senderNameToUse: ${senderNameToUse}`);
 
    if (message.role === 'user' || message.role === 'assistant') {
        avatarImg = document.createElement('img');
        avatarImg.classList.add('chat-avatar');
        avatarImg.src = avatarUrlToUse;
        avatarImg.alt = `${senderNameToUse} 头像`;
        avatarImg.onerror = () => { avatarImg.src = message.role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png'; };

        nameTimeDiv = document.createElement('div');
        nameTimeDiv.classList.add('name-time-block');
        
        senderNameDiv = document.createElement('div');
        senderNameDiv.classList.add('sender-name');
        senderNameDiv.textContent = senderNameToUse;

        nameTimeDiv.appendChild(senderNameDiv);

        if (message.timestamp && !message.isThinking) {
            const timestampDiv = document.createElement('div');
            timestampDiv.classList.add('message-timestamp');
            timestampDiv.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            nameTimeDiv.appendChild(timestampDiv);
        }
        
        detailsAndBubbleWrapper = document.createElement('div');
        detailsAndBubbleWrapper.classList.add('details-and-bubble-wrapper');
        detailsAndBubbleWrapper.appendChild(nameTimeDiv);
        detailsAndBubbleWrapper.appendChild(contentDiv);

        messageItem.appendChild(avatarImg);
        messageItem.appendChild(detailsAndBubbleWrapper);
    } else { // system messages
        messageItem.appendChild(contentDiv);
        messageItem.classList.add('system-message-layout');
    }

    chatMessagesDiv.appendChild(messageItem);

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
        
        let processedContent = ensureNewlineAfterCodeBlock(textToRender);
        processedContent = ensureSpaceAfterTilde(processedContent);
        processedContent = removeIndentationFromCodeBlockMarkers(processedContent);
        processedContent = removeSpeakerTags(processedContent); // Remove speaker tags before parsing
        contentDiv.innerHTML = markedInstance.parse(processedContent);
        processAllPreBlocksInContentDiv(contentDiv);

        const imagesInContent = contentDiv.querySelectorAll('img');
        imagesInContent.forEach(img => {
            // Add an onload event listener to each image.
            // This helps prevent the "flicker" or "jump" when an image loads
            // by ensuring the chat scrolls to the bottom *after* the image has
            // taken up its space in the layout.
            img.addEventListener('load', () => {
                const chatContainer = mainRendererReferences.chatMessagesDiv;
                // Only scroll if the user is already near the bottom, to avoid interrupting them
                // if they have scrolled up to read previous messages.
                const isScrolledToBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 150; // 150px tolerance
                if (isScrolledToBottom) {
                    uiHelper.scrollToBottom();
                }
            });

            if (!img.classList.contains('message-attachment-image-thumbnail')) { // Avoid re-adding listeners to attachment thumbs
                img.style.cursor = 'pointer';
                img.title = `点击在新窗口预览: ${img.alt || img.src}\n右键可复制图片`;
                img.addEventListener('click', (e) => {
                    e.stopPropagation();
                    electronAPI.openImageInNewWindow(img.src, img.alt || img.src.split('/').pop() || 'AI 图片');
                });
                img.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    electronAPI.showImageContextMenu(img.src);
                });
            }
        });
    }
    
    // Avatar Color Application (after messageItem is in DOM)
    if ((message.role === 'user' || message.role === 'assistant') && avatarImg && senderNameDiv) {
        const applyColorToElements = (colorStr) => {
            if (colorStr && messageItem.isConnected) { // Check if still in DOM
                senderNameDiv.style.color = colorStr;
                avatarImg.style.borderColor = colorStr;
            }
        };

        if (avatarColorToUse) { // If a specific color was passed (e.g. for group member or persisted user/agent color)
            applyColorToElements(avatarColorToUse);
        } else if (avatarUrlToUse && !avatarUrlToUse.includes('default_')) { // No persisted color, try to extract
            const dominantColor = await getDominantAvatarColor(avatarUrlToUse);
            applyColorToElements(dominantColor);
            if (dominantColor && messageItem.isConnected) { // If extracted and still in DOM, try to persist
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
                                } else if (typeToSave === 'agent' && idToSaveFor === currentSelectedItem.id && currentSelectedItem.config) {
                                    // Update currentSelectedItem.config if it's the active agent
                                    currentSelectedItem.config.avatarCalculatedColor = dominantColor;
                                }
                                // For group messages, the individual agent's config isn't directly held in currentSelectedItem.config
                                // The color is applied directly to the message. If persistence is needed for each group member,
                                // it should happen when their main config is loaded/saved.
                            }
                        });
                }
            }
        } else { // Default avatar or no URL, reset to theme defaults
            senderNameDiv.style.color = message.role === 'user' ? 'var(--secondary-text)' : 'var(--highlight-text)';
            avatarImg.style.borderColor = 'transparent';
        }
    }


    // Attachments (ensure contentDiv is the bubble's content div)
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
                    electronAPI.openImageInNewWindow(att.src, att.name);
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
    
    if (!message.isThinking && window.renderMathInElement) {
        window.renderMathInElement(contentDiv, {
            delimiters: [
                {left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false},
                {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}
            ],
            throwOnError: false
        });
    }
    processAllPreBlocksInContentDiv(contentDiv);
    // Moved highlightTagsInMessage and highlightQuotesInMessage to be called after MathJax/KaTeX rendering
    
    if (!isInitialLoad && !message.isThinking) {
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        currentChatHistoryArray.push(message);
        mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray); // Update the ref

        if (currentSelectedItem.id && mainRendererReferences.currentTopicIdRef.get()) {
             if (currentSelectedItem.type === 'agent') {
                electronAPI.saveChatHistory(currentSelectedItem.id, mainRendererReferences.currentTopicIdRef.get(), currentChatHistoryArray);
             } else if (currentSelectedItem.type === 'group') {
                // Group history is usually saved by groupchat.js in main process after AI response
                // If we need to save user's message immediately for groups too, add IPC for it.
                // For now, this saveChatHistory call is agent-specific.
             }
        }
    } else if (isInitialLoad && message.isThinking) {
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

    // Call highlighting functions AFTER all other DOM manipulations on contentDiv are done
    highlightTagsInMessage(contentDiv);
    highlightQuotesInMessage(contentDiv);
    
    uiHelper.scrollToBottom();
    return messageItem;
}

function startStreamingMessage(message) { // message can now include agentName, agentId for group messages
    console.log('[MessageRenderer startStreamingMessage] Received message:', JSON.parse(JSON.stringify(message)));
    const { chatMessagesDiv, uiHelper } = mainRendererReferences;
    if (!message || !message.id) {
        console.error("[MessageRenderer startStreamingMessage] Message or message.id is undefined.", message);
        return null;
    }
    // mainRendererReferences.activeStreamingMessageId = message.id; // REMOVED

    let messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);

    if (!messageItem) { // If no "thinking" placeholder, create one
        const placeholderMessage = { 
            ...message, // Includes role, name, agentId, avatarUrl, avatarColor from group stream start
            content: '', 
            isThinking: false, // It's now streaming, not just thinking
            timestamp: message.timestamp || Date.now(),
            isGroupMessage: message.isGroupMessage || false,
        };
        messageItem = renderMessage(placeholderMessage, false); 
        if (!messageItem) {
           console.error(`startStreamingMessage: Failed to render placeholder for new stream ${message.id}. Aborting stream start.`);
           mainRendererReferences.activeStreamingMessageId = null; 
           return null;
        }
    }
    
    messageItem.classList.add('streaming');
    messageItem.classList.remove('thinking'); 

    const contentDiv = messageItem.querySelector('.md-content');
    if (contentDiv) { // Prepare for stream
        // contentDiv.innerHTML = ''; // Let appendStreamChunk handle the replacement of thinking indicator
        // Optionally add a subtle "receiving" indicator if desired, but often just letting content flow is fine.
        // contentDiv.innerHTML = `<span class="streaming-indicator"></span>`;
    }
    
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const historyIndex = currentChatHistoryArray.findIndex(m => m.id === message.id);

    let initialContentForHistory = '';
    if (shouldEnableSmoothStreaming(message.id)) {
        console.log(`[SmoothStream START] Initializing smooth streaming for messageId: ${message.id}`);
        streamingChunkQueues.set(message.id, []); // This will store individual characters
        accumulatedStreamText.set(message.id, '');
        // pendingRenderBuffer.set(message.id, ""); // No longer needed
        // For smooth streaming, the history's content will be updated by the timer.
        // The `accumulatedStreamText` will hold the "true" full content as chunks arrive.
        // The `content` in `currentChatHistoryArray` will reflect what's *visibly rendered* by the timer.
    }

    if (historyIndex === -1) { // New message for the stream
        currentChatHistoryArray.push({
            ...message, // Includes role, name, agentId etc.
            content: initialContentForHistory, // Start with empty or specific initial content
            isThinking: false,
            timestamp: message.timestamp || Date.now(),
            isGroupMessage: message.isGroupMessage || false,
        });
    } else { // Update existing placeholder in history
        currentChatHistoryArray[historyIndex].isThinking = false;
        currentChatHistoryArray[historyIndex].content = initialContentForHistory; // Reset content
        currentChatHistoryArray[historyIndex].timestamp = message.timestamp || Date.now();
        currentChatHistoryArray[historyIndex].name = message.name || currentChatHistoryArray[historyIndex].name;
        currentChatHistoryArray[historyIndex].agentId = message.agentId || currentChatHistoryArray[historyIndex].agentId;
        currentChatHistoryArray[historyIndex].isGroupMessage = message.isGroupMessage || currentChatHistoryArray[historyIndex].isGroupMessage || false;
    }
    mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray);


    uiHelper.scrollToBottom();
    return messageItem;
}


// This is the new core processing function that will be called by the timer
function processAndRenderSmoothChunk(messageId) {
    // console.log(`[SmoothStream PROCESS] Timer fired for messageId: ${messageId}`);
    const { chatMessagesDiv, markedInstance, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem || !document.body.contains(messageItem)) {
        if (streamingTimers.has(messageId)) { // Check before clearing
            clearTimeout(streamingTimers.get(messageId)); // Should be clearInterval
            streamingTimers.delete(messageId);
        }
        streamingChunkQueues.delete(messageId);
        accumulatedStreamText.delete(messageId);
        // pendingRenderBuffer.delete(messageId); // No longer needed
        return;
    }

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const queue = streamingChunkQueues.get(messageId); // This queue now contains individual characters

    if (!queue || queue.length === 0) {
        return; // Nothing to process from the character queue
    }

    let textBatchToRender = "";
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const minChunkSize = globalSettings.minChunkBufferSize !== undefined && globalSettings.minChunkBufferSize >= 1 ? globalSettings.minChunkBufferSize : 1;

    while (queue.length > 0 && textBatchToRender.length < minChunkSize) {
        textBatchToRender += queue.shift(); // Take one character at a time
    }
    
    const chunkToProcess = textBatchToRender;

    // console.log(`[SmoothStream PROCESS] Timer for ${messageId}. Batch to render: "${chunkToProcess}". Chars in batch: ${chunkToProcess.length}. Queue left: ${queue.length}`);

    if (!chunkToProcess) {
        return;
    }

    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
        console.warn(`[ProcessSmoothChunk] Message ID ${messageId} not found in history. Aborting render for this chunk.`);
        return;
    }

    // Append new chunk to the *history* content, which is the source of truth for rendering
    currentChatHistoryArray[messageIndex].content += chunkToProcess;
    mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]); // Update history reference

    // The `accumulatedStreamText` is already up-to-date from `appendStreamChunk`.
    // For rendering, we use the content from history, which is now updated.
    const textForRendering = currentChatHistoryArray[messageIndex].content;
    
    // --- Core Rendering Logic (similar to original appendStreamChunk's rendering part) ---
    const streamingIndicator = contentDiv.querySelector('.streaming-indicator, .thinking-indicator');
    if (streamingIndicator) streamingIndicator.remove();

    let processedTextForParse = removeSpeakerTags(textForRendering);
    processedTextForParse = ensureNewlineAfterCodeBlock(processedTextForParse);
    processedTextForParse = ensureSpaceAfterTilde(processedTextForParse);
    processedTextForParse = removeIndentationFromCodeBlockMarkers(processedTextForParse);
    contentDiv.innerHTML = markedInstance.parse(processedTextForParse);

    // Debounced enhanced rendering (VCP Tool, Diary) - uses accumulatedStreamText for detection
    const fullAccumulatedText = accumulatedStreamText.get(messageId) || ""; // Get the most up-to-date raw text
    if (messageItem) {
        let currentDelay = ENHANCED_RENDER_DEBOUNCE_DELAY;
        if (fullAccumulatedText.includes("<<<DailyNoteStart>>>") || fullAccumulatedText.includes("<<<[TOOL_REQUEST]>>>")) {
            currentDelay = DIARY_RENDER_DEBOUNCE_DELAY;
        }

        if (enhancedRenderDebounceTimers.has(messageItem)) {
            clearTimeout(enhancedRenderDebounceTimers.get(messageItem));
        }
        enhancedRenderDebounceTimers.set(messageItem, setTimeout(() => {
            if (document.body.contains(messageItem)) {
                const targetContentDiv = messageItem.querySelector('.md-content');
                if (targetContentDiv) {
                    targetContentDiv.querySelectorAll('pre[data-vcp-prettified="true"], pre[data-maid-diary-prettified="true"]').forEach(pre => {
                        delete pre.dataset.vcpPrettified;
                        delete pre.dataset.maidDiaryPrettified;
                    });
                    
                    // Re-parse with the *currently rendered* text for visual consistency of this step
                    // but detection was based on full accumulated text.
                    let processedForDebounce = removeSpeakerTags(textForRendering); // Use textForRendering
                    processedForDebounce = ensureNewlineAfterCodeBlock(processedForDebounce);
                    processedForDebounce = ensureSpaceAfterTilde(processedForDebounce);
                    processedForDebounce = removeIndentationFromCodeBlockMarkers(processedForDebounce);
                    targetContentDiv.innerHTML = markedInstance.parse(processedForDebounce);

                    if (window.renderMathInElement) {
                        window.renderMathInElement(targetContentDiv, {
                            delimiters: [ {left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true} ],
                            throwOnError: false
                        });
                    }
                    processAllPreBlocksInContentDiv(targetContentDiv);
                    // Call highlighting functions AFTER all other DOM manipulations on targetContentDiv
                    highlightTagsInMessage(targetContentDiv);
                    highlightQuotesInMessage(targetContentDiv);
                }
            }
            enhancedRenderDebounceTimers.delete(messageItem);
        }, currentDelay));
    }
    // --- End Core Rendering Logic ---
    
    uiHelper.scrollToBottom();
}


function appendStreamChunk(messageId, chunkData, agentNameForGroup, agentIdForGroup) { // Added agentName/Id for group context
    // if (messageId !== mainRendererReferences.activeStreamingMessageId) { // REMOVED CHECK
    //     // console.warn(`appendStreamChunk: Received chunk for inactive/mismatched stream ${messageId}. Current active: ${mainRendererReferences.activeStreamingMessageId}`);
    //     return;
    // }
    const { chatMessagesDiv, markedInstance, uiHelper } = mainRendererReferences; // Keep for direct access if needed
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();

    let textToAppend = "";
    // Standard OpenAI-like chunk structure
    if (chunkData && chunkData.choices && chunkData.choices.length > 0 && chunkData.choices[0].delta && chunkData.choices[0].delta.content) {
        textToAppend = chunkData.choices[0].delta.content;
    }
    // Anthropic-like or other direct delta content
    else if (chunkData && chunkData.delta && typeof chunkData.delta.content === 'string') {
        textToAppend = chunkData.delta.content;
    }
    else if (chunkData && typeof chunkData.content === 'string') { // Simpler structure with direct content
        textToAppend = chunkData.content;
    }
    else if (typeof chunkData === 'string') { // Direct string chunk
        textToAppend = chunkData;
    } else if (chunkData && chunkData.raw) { // Raw data with potential error
        textToAppend = chunkData.raw + (chunkData.error ? ` (解析错误)` : "");
    }

    if (!textToAppend) return; // No actual text to append

    if (shouldEnableSmoothStreaming(messageId)) {
        const queue = streamingChunkQueues.get(messageId); // This queue expects individual characters
        if (queue) {
            // Split the incoming server chunk into individual characters
            const chars = textToAppend.split('');
            for (const char of chars) {
                queue.push(char);
            }
        } else {
            // Should not happen if startStreamingMessage initialized correctly
            console.warn(`[appendStreamChunk] No queue for ${messageId}, rendering directly (fallback).`);
            // Fallback to old direct rendering if queue is missing (should be rare)
            renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup); // Implement this helper if needed
            return;
        }
        
        // Update accumulated text for detection features
        let currentAccumulated = accumulatedStreamText.get(messageId) || "";
        currentAccumulated += textToAppend;
        accumulatedStreamText.set(messageId, currentAccumulated);

        // Ensure name/agentId are set in history for group messages (using accumulated text for first chunk context)
        const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
        if (messageIndex > -1 && currentChatHistoryArray[messageIndex].isGroupMessage) {
            if (agentNameForGroup && !currentChatHistoryArray[messageIndex].name) currentChatHistoryArray[messageIndex].name = agentNameForGroup;
            if (agentIdForGroup && !currentChatHistoryArray[messageIndex].agentId) currentChatHistoryArray[messageIndex].agentId = agentIdForGroup;
            // Note: The actual `content` field in history is updated by the timer.
        }
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);


        if (!streamingTimers.has(messageId)) {
            const globalSettings = mainRendererReferences.globalSettingsRef.get(); // Ensure globalSettings is accessible
            const timerId = setInterval(() => {
                processAndRenderSmoothChunk(messageId); // This updates message.content and DOM
                
                const currentQueue = streamingChunkQueues.get(messageId);
                if ((!currentQueue || currentQueue.length === 0) && messageIsFinalized(messageId)) {
                    clearInterval(streamingTimers.get(messageId));
                    streamingTimers.delete(messageId);
                    console.log(`[SmoothStream END] Timer cleared for ${messageId}. Queue empty and message finalized.`);
                    
                    const finalMessageItem = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
                    if (finalMessageItem) {
                        finalMessageItem.classList.remove('streaming'); // Remove streaming class here for smooth streaming
                    }
                    
                    // Perform a final explicit render pass to ensure all elements (like pre blocks, tags) are correctly processed on the *absolute final* content.
                    const finalHistory = mainRendererReferences.currentChatHistoryRef.get();
                    const finalMsgIdx = finalHistory.findIndex(m => m.id === messageId);
                    const completeAccumulatedText = accumulatedStreamText.get(messageId) || ""; // Get the full text first

                    if (finalMsgIdx > -1) {
                        // Update the history content with the complete accumulated text
                        if (finalHistory[finalMsgIdx].content !== completeAccumulatedText) {
                            console.log(`[SmoothStream END] Updating history content for ${messageId} from accumulated text. Old length: ${finalHistory[finalMsgIdx].content.length}, New length: ${completeAccumulatedText.length}`);
                            finalHistory[finalMsgIdx].content = completeAccumulatedText;
                            mainRendererReferences.currentChatHistoryRef.set([...finalHistory]); // Update the ref
                        }
                    } else if (finalMessageItem) { // Message item exists but not in history (should be rare)
                         console.warn(`[SmoothStream END] Message ${messageId} not found in finalHistory array during final render pass, but messageItem exists. Will render with accumulated text.`);
                    }
                    
                    const textForFinalPass = completeAccumulatedText; // Use this for final rendering

                    if (finalMessageItem) { // Proceed with rendering if message item exists
                        const finalContentDiv = finalMessageItem.querySelector('.md-content');
                        // Ensure textForFinalPass is a string before using it in markedInstance.parse
                        if (finalContentDiv && typeof textForFinalPass === 'string') {
                            if (enhancedRenderDebounceTimers.has(finalMessageItem)) {
                                clearTimeout(enhancedRenderDebounceTimers.get(finalMessageItem));
                                enhancedRenderDebounceTimers.delete(finalMessageItem);
                            }
                            finalContentDiv.querySelectorAll('pre[data-vcp-prettified="true"], pre[data-maid-diary-prettified="true"]').forEach(pre => {
                                delete pre.dataset.vcpPrettified;
                                delete pre.dataset.maidDiaryPrettified;
                            });

                            let processedText = removeSpeakerTags(textForFinalPass);
                            processedText = ensureNewlineAfterCodeBlock(processedText);
                            processedText = ensureSpaceAfterTilde(processedText);
                            processedText = removeIndentationFromCodeBlockMarkers(processedText);
                            finalContentDiv.innerHTML = mainRendererReferences.markedInstance.parse(processedText);

                            if (window.renderMathInElement) {
                                window.renderMathInElement(finalContentDiv, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}], throwOnError: false });
                           }
                           processAllPreBlocksInContentDiv(finalContentDiv);
                           // Call highlighting functions AFTER all other DOM manipulations on finalContentDiv
                           highlightTagsInMessage(finalContentDiv);
                           highlightQuotesInMessage(finalContentDiv);
                           mainRendererReferences.uiHelper.scrollToBottom();
                        }
                    }
                    // Clean up maps after everything is done for this stream
                    streamingChunkQueues.delete(messageId);
                    accumulatedStreamText.delete(messageId);
                    console.log(`[SmoothStream CLEANUP] Queue and accumulated text cleared for ${messageId}.`);
                }
            }, globalSettings.smoothStreamIntervalMs !== undefined && globalSettings.smoothStreamIntervalMs >= 1 ? globalSettings.smoothStreamIntervalMs : 25);
            streamingTimers.set(messageId, timerId);
        }
    } else {
        // Original direct rendering logic if smooth streaming is disabled
        renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup);
    }
}

// Helper function to conceptualize direct rendering if needed for fallback or when smooth streaming is off
// This would encapsulate the original rendering logic from appendStreamChunk
function renderChunkDirectlyToDOM(messageId, textToAppend, agentNameForGroup, agentIdForGroup) {
    const { chatMessagesDiv, markedInstance, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();

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
        console.warn(`[RenderDirect] Message ID ${messageId} not found in history. Appending to DOM directly.`);
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = contentDiv.innerHTML; // Get current DOM content
        fullCurrentText = (tempContainer.textContent || "") + textToAppend; // Approximate
    }
    mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);

    let processedFullCurrentTextForParse = removeSpeakerTags(fullCurrentText);
    processedFullCurrentTextForParse = ensureNewlineAfterCodeBlock(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = ensureSpaceAfterTilde(processedFullCurrentTextForParse);
    processedFullCurrentTextForParse = removeIndentationFromCodeBlockMarkers(processedFullCurrentTextForParse);
    contentDiv.innerHTML = markedInstance.parse(processedFullCurrentTextForParse);

    // Debounced enhanced rendering
    if (messageItem) {
        let currentDelay = ENHANCED_RENDER_DEBOUNCE_DELAY;
        if (fullCurrentText.includes("<<<DailyNoteStart>>>") || fullCurrentText.includes("<<<[TOOL_REQUEST]>>>")) {
            currentDelay = DIARY_RENDER_DEBOUNCE_DELAY;
        }
        if (enhancedRenderDebounceTimers.has(messageItem)) {
            clearTimeout(enhancedRenderDebounceTimers.get(messageItem));
        }
        enhancedRenderDebounceTimers.set(messageItem, setTimeout(() => {
            if (document.body.contains(messageItem)) {
                const targetContentDiv = messageItem.querySelector('.md-content');
                if (targetContentDiv) {
                    targetContentDiv.querySelectorAll('pre[data-vcp-prettified="true"], pre[data-maid-diary-prettified="true"]').forEach(pre => {
                        delete pre.dataset.vcpPrettified;
                        delete pre.dataset.maidDiaryPrettified;
                    });
                    let processedForDebounce = removeSpeakerTags(fullCurrentText);
                    processedForDebounce = ensureNewlineAfterCodeBlock(processedForDebounce);
                    processedForDebounce = ensureSpaceAfterTilde(processedForDebounce);
                    processedForDebounce = removeIndentationFromCodeBlockMarkers(processedForDebounce);
                    targetContentDiv.innerHTML = markedInstance.parse(processedForDebounce);
                    if (window.renderMathInElement) {
                        window.renderMathInElement(targetContentDiv, { delimiters: [ {left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true} ], throwOnError: false });
                }
                processAllPreBlocksInContentDiv(targetContentDiv);
                // Call highlighting functions AFTER all other DOM manipulations on targetContentDiv
                highlightTagsInMessage(targetContentDiv);
                highlightQuotesInMessage(targetContentDiv);
            }
            }
            enhancedRenderDebounceTimers.delete(messageItem);
        }, currentDelay));
    }
    uiHelper.scrollToBottom();
}

// Conceptual function, needs a real mechanism to know if finalize has been called for this messageId
// This might involve setting a flag on the message object in history or a separate map.
// For now, finalizeStreamedMessage will be the primary clearer of timers.
function messageIsFinalized(messageId) {
    const history = mainRendererReferences.currentChatHistoryRef.get();
    const msg = history.find(m => m.id === messageId);
    return msg && (msg.finishReason || msg.isError); // Example: consider finalized if it has a finishReason or an error flag
}


async function finalizeStreamedMessage(messageId, finishReason, fullResponseText, agentNameForGroup, agentIdForGroup) {
    // if (messageId !== mainRendererReferences.activeStreamingMessageId) { // REMOVED CHECK
    //    console.warn(`finalizeStreamedMessage: Received end for inactive/mismatched stream ${messageId}. Current: ${mainRendererReferences.activeStreamingMessageId}.`);
    //     return;
    // }
    // mainRendererReferences.activeStreamingMessageId = null; // REMOVED

    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = mainRendererReferences;
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        // Clean up any orphaned timer or queue if messageItem is gone
        if (streamingTimers.has(messageId)) {
            clearInterval(streamingTimers.get(messageId));
            streamingTimers.delete(messageId);
        }
        streamingChunkQueues.delete(messageId);
        accumulatedStreamText.delete(messageId);
        return;
    }

    // Only remove 'streaming' class here if smooth streaming is NOT enabled.
    // For smooth streaming, it's removed when the timer finishes and queue is empty.
    if (!shouldEnableSmoothStreaming(messageId)) {
        messageItem.classList.remove('streaming');
    }
    
    // --- Smooth Streaming Finalization ---
    // For smooth streaming, we no longer clear the timer or process remaining queue here.
    // The timer will continue until the queue is empty and messageIsFinalized() is true.
    // We only set the finishReason and update accumulatedStreamText if fullResponseText is provided.
    // --- End Smooth Streaming Finalization ---

    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    let finalFullTextForRender;

    if (messageIndex > -1) {
        const message = currentChatHistoryArray[messageIndex];
        message.finishReason = finishReason; // Set finishReason so messageIsFinalized() works for the timer
        message.isThinking = false;

        let authoritativeTextForHistory = message.content; // Default to existing content from history

        if (typeof fullResponseText === 'string' && fullResponseText.trim() !== '') {
            const correctedText = fullResponseText.replace(/^重新生成中\.\.\./, '').trim();
            authoritativeTextForHistory = correctedText; // Prioritize fullResponseText
            if (shouldEnableSmoothStreaming(messageId)) {
                // If fullResponseText is the authority, ensure accumulatedStreamText is also updated
                accumulatedStreamText.set(messageId, correctedText);
            }
        } else if (shouldEnableSmoothStreaming(messageId)) {
            // If fullResponseText is NOT provided for smooth streaming,
            // use the content from accumulatedStreamText as it should contain all received chunks.
            const accumulated = accumulatedStreamText.get(messageId);
            if (typeof accumulated === 'string' && accumulated.length > 0) { // Check if accumulated is a non-empty string
                authoritativeTextForHistory = accumulated;
            } else {
                 console.warn(`[finalizeStreamedMessage] For smooth stream ${messageId}, fullResponseText was not provided, and accumulatedStreamText was empty or not a string. Using existing message.content for history: "${message.content.substring(0,50)}..."`);
            }
        }
        // For non-smooth streaming without fullResponseText, message.content (already built by renderChunkDirectlyToDOM) is the best version we have.
        // So, authoritativeTextForHistory would correctly remain as message.content (the default).

        message.content = authoritativeTextForHistory; // Update the history object
        
        // finalFullTextForRender is used for the non-smooth final render pass later in this function.
        // It should reflect the most authoritative text determined above.
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
                showContextMenu(e, messageItem, message);
            });
        }
        
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);

        if (currentSelectedItem && currentSelectedItem.id && currentTopicIdVal) {
            const historyToSave = currentChatHistoryArray.filter(msg => !msg.isThinking);
            if (currentSelectedItem.type === 'agent') {
                try {
                    await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicIdVal, historyToSave);
                } catch (error) {
                    console.error(`[MR finalizeStreamedMessage] FAILED to save AGENT history for ${currentSelectedItem.id}, topic ${currentTopicIdVal}:`, error);
                }
            } else if (currentSelectedItem.type === 'group') {
                if (electronAPI.saveGroupChatHistory) {
                    try {
                        await electronAPI.saveGroupChatHistory(currentSelectedItem.id, currentTopicIdVal, historyToSave);
                    } catch (error) {
                        console.error(`[MR finalizeStreamedMessage] FAILED to save GROUP history via IPC for ${currentSelectedItem.id}, topic ${currentTopicIdVal}:`, error);
                    }
                } else {
                    console.warn("MessageRenderer: electronAPI.saveGroupChatHistory is not defined.");
                }
            }
        }
    } else {
        console.warn(`finalizeStreamedMessage: Message ID ${messageId} not found in history at finalization.`);
        // If message not in history, and smooth streaming was active, still need to clean up maps and timer
        if (shouldEnableSmoothStreaming(messageId)) {
            if (streamingTimers.has(messageId)) {
                clearInterval(streamingTimers.get(messageId));
                streamingTimers.delete(messageId);
            }
        }
        // For non-smooth, try to render what we have
        finalFullTextForRender = (typeof fullResponseText === 'string' && fullResponseText.trim() !== '')
                               ? fullResponseText.replace(/^重新生成中\.\.\./, '').trim()
                               : accumulatedStreamText.get(messageId) || `(消息 ${messageId} 历史记录未找到，结束: ${finishReason})`;
        const directContentDiv = messageItem.querySelector('.md-content');
        if(directContentDiv && (finishReason === 'error' || !fullResponseText || !shouldEnableSmoothStreaming(messageId))) {
             directContentDiv.innerHTML = markedInstance.parse(finalFullTextForRender);
        }
    }
    
    // Final Render Pass - ONLY for non-smooth streaming.
    // Smooth streaming handles its final render in the timer's cleanup logic.
    if (!shouldEnableSmoothStreaming(messageId)) {
        const contentDiv = messageItem.querySelector('.md-content');
        if (contentDiv) {
            const thinkingIndicator = contentDiv.querySelector('.thinking-indicator, .streaming-indicator');
            if (thinkingIndicator) thinkingIndicator.remove();
            
            // Use finalFullTextForRender which should be correctly set for non-smooth path
            let textForNonSmoothRender = finalFullTextForRender;
            if (messageIndex > -1) { // Ensure we use the content from history if available
                textForNonSmoothRender = currentChatHistoryArray[messageIndex].content;
            }

            let processedFinalText = removeSpeakerTags(textForNonSmoothRender);
            processedFinalText = ensureNewlineAfterCodeBlock(processedFinalText);
            processedFinalText = ensureSpaceAfterTilde(processedFinalText);
            processedFinalText = removeIndentationFromCodeBlockMarkers(processedFinalText);
            contentDiv.innerHTML = markedInstance.parse(processedFinalText);

            if (window.renderMathInElement) {
                 window.renderMathInElement(contentDiv, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}], throwOnError: false });
            }
            
            if (enhancedRenderDebounceTimers.has(messageItem)) {
                clearTimeout(enhancedRenderDebounceTimers.get(messageItem));
                enhancedRenderDebounceTimers.delete(messageItem);
            }
            contentDiv.querySelectorAll('pre[data-vcp-prettified="true"], pre[data-maid-diary-prettified="true"]').forEach(pre => {
                delete pre.dataset.vcpPrettified;
                delete pre.dataset.maidDiaryPrettified;
            });
            processAllPreBlocksInContentDiv(contentDiv);
            // Call highlighting functions AFTER all other DOM manipulations on contentDiv
            highlightTagsInMessage(contentDiv);
            highlightQuotesInMessage(contentDiv);
        }
    }

    // For smooth streaming, queue and accumulated text are cleared by the timer when it finishes.
    // The timer itself will delete streamingTimers.
    // No longer clearing streamingChunkQueues or accumulatedStreamText here for smooth streaming.

    // scrollToBottom is called by the timer's final render for smooth streaming.
    // For non-smooth, call it here.
    if (!shouldEnableSmoothStreaming(messageId)) {
        uiHelper.scrollToBottom();
    }
}


function showContextMenu(event, messageItem, message) {
    closeContextMenu(); 
    closeTopicContextMenu(); // Also close topic context menu if open

    const { electronAPI, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();


    const menu = document.createElement('div');
    menu.id = 'chatContextMenu';
    menu.classList.add('context-menu');
    menu.style.top = `${event.clientY}px`;
    menu.style.left = `${event.clientX}px`;

    if (message.isThinking || messageItem.classList.contains('streaming')) {
        const cancelOption = document.createElement('div');
        cancelOption.classList.add('context-menu-item');
        cancelOption.textContent = message.isThinking ? "强制移除'思考中...'" : "取消回复生成";
        cancelOption.onclick = () => {
            if (message.isThinking) { // Should not happen if correctly managed
                const thinkingMsgIndex = currentChatHistoryArray.findIndex(msg => msg.id === message.id && msg.isThinking);
                if (thinkingMsgIndex > -1) {
                    currentChatHistoryArray.splice(thinkingMsgIndex, 1);
                    mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
                     if (currentSelectedItemVal.id && currentTopicIdVal) {
                         electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                     }
                }
                messageItem.remove();
            } else if (messageItem.classList.contains('streaming')) {
                finalizeStreamedMessage(message.id, 'cancelled_by_user'); // Pass the ID of the message being cancelled
            }
            closeContextMenu();
        };
        menu.appendChild(cancelOption);
    } else {
        const isEditing = messageItem.classList.contains('message-item-editing');
        const textarea = isEditing ? messageItem.querySelector('.message-edit-textarea') : null;

        if (!isEditing) {
            const editOption = document.createElement('div');
            editOption.classList.add('context-menu-item');
            editOption.innerHTML = `<i class="fas fa-edit"></i> 编辑消息`;
            editOption.onclick = () => {
                toggleEditMode(messageItem, message);
                closeContextMenu();
            };
            menu.appendChild(editOption);
        }

        const copyOption = document.createElement('div');
        copyOption.classList.add('context-menu-item');
        copyOption.innerHTML = `<i class="fas fa-copy"></i> 复制文本`;
        copyOption.onclick = () => {
            const textToCopy = message.content.replace(/<img[^>]*>/g, '').trim(); // Basic strip of img tags
            navigator.clipboard.writeText(textToCopy)
                .then(() => console.log('Message content (text only) copied to clipboard.'))
                .catch(err => console.error('Failed to copy message content: ', err));
            closeContextMenu();
        };
        menu.appendChild(copyOption);

        if (isEditing && textarea) {
            const cutOption = document.createElement('div');
            cutOption.classList.add('context-menu-item');
            cutOption.innerHTML = `<i class="fas fa-cut"></i> 剪切文本`;
            cutOption.onclick = () => {
                textarea.focus(); document.execCommand('cut'); closeContextMenu();
            };
            menu.appendChild(cutOption);

            const pasteOption = document.createElement('div');
            pasteOption.classList.add('context-menu-item');
            pasteOption.innerHTML = `<i class="fas fa-paste"></i> 粘贴文本`;
            pasteOption.onclick = async () => {
                textarea.focus();
                try {
                    const text = await electronAPI.readTextFromClipboard(); // Use exposed API
                    if (text) {
                        const start = textarea.selectionStart; const end = textarea.selectionEnd;
                        textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
                        textarea.selectionStart = textarea.selectionEnd = start + text.length;
                        textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); // Trigger auto-resize
                    }
                } catch (err) { console.error('Failed to paste text:', err); }
                closeContextMenu();
            };
            menu.appendChild(pasteOption);
        }
        
        // Create Branch - only for agent messages
        if (currentSelectedItemVal.type === 'agent') {
            const createBranchOption = document.createElement('div');
            createBranchOption.classList.add('context-menu-item');
            createBranchOption.innerHTML = `<i class="fas fa-code-branch"></i> 创建分支`;
            createBranchOption.onclick = () => {
                if (typeof mainRendererReferences.handleCreateBranch === 'function') {
                     mainRendererReferences.handleCreateBranch(message);
                } else {
                    console.error("handleCreateBranch function is not available.");
                }
                closeContextMenu();
            }; 
            menu.appendChild(createBranchOption); 
        }


        const readModeOption = document.createElement('div');
        readModeOption.classList.add('context-menu-item', 'info-item'); // Added 'info-item' for blue color
        readModeOption.innerHTML = `<i class="fas fa-book-reader"></i> 阅读模式`;
        readModeOption.onclick = () => {
            // 将图片标签替换为空字符串，而不是 [图片]
            const plainTextContent = message.content.replace(/<img[^>]*>/gi, "").replace(/<audio[^>]*>.*?<\/audio>/gi, "[音频]").replace(/<video[^>]*>.*?<\/video>/gi, "[视频]");
            const windowTitle = `阅读: ${message.id.substring(0,10)}...`;
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            if (electronAPI && typeof electronAPI.openTextInNewWindow === 'function') {
                electronAPI.openTextInNewWindow(plainTextContent, windowTitle, currentTheme);
            } else {
                console.error('electronAPI.openTextInNewWindow is not available!');
            }
            closeContextMenu();
        };
        menu.appendChild(readModeOption);


        const deleteOption = document.createElement('div');
        deleteOption.classList.add('context-menu-item', 'danger-item'); // danger-item for red text
        deleteOption.innerHTML = `<i class="fas fa-trash-alt"></i> 删除消息`;
        deleteOption.onclick = async () => {
            // message.content should be a string if loaded from history or for AI replies
            // For user messages in group chat that might be in transit as {text: "..."}, handle it.
            let textForConfirm = "";
            if (typeof message.content === 'string') {
                textForConfirm = message.content;
            } else if (message.content && typeof message.content.text === 'string') {
                textForConfirm = message.content.text;
            } else {
                textForConfirm = '[消息内容无法预览]';
                console.warn('[MessageRenderer DeleteConfirm] message.content is not a string or {text: string} object:', message.content);
            }
            
            if (confirm(`确定要删除此消息吗？\n"${textForConfirm.substring(0, 50)}${textForConfirm.length > 50 ? '...' : ''}"`)) {
                const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === message.id);
                if (messageIndex > -1) {
                    currentChatHistoryArray.splice(messageIndex, 1);
                    mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
                    if (currentSelectedItemVal.id && currentTopicIdVal) { // Save history for current item type
                        if (currentSelectedItemVal.type === 'agent') {
                            await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                        } else if (currentSelectedItemVal.type === 'group') {
                            // For groups, history needs to be saved via an IPC call to the main process,
                            // which will then use groupchat.js to update the history file.
                            if (electronAPI.saveGroupChatHistory) {
                                await electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                                console.log(`[MessageRenderer] Requested saveGroupChatHistory for group ${currentSelectedItemVal.id}, topic ${currentTopicIdVal}`);
                            } else {
                                console.warn("MessageRenderer: electronAPI.saveGroupChatHistory is not defined. Group chat history will not be saved after deletion.");
                            }
                        }
                    }
                    messageItem.remove();
                }
            }
            closeContextMenu();
        };

        // Regenerate - only for assistant messages and if not a group message (group regen is complex)
        if (message.role === 'assistant' && !message.isGroupMessage && currentSelectedItemVal.type === 'agent') {
            const regenerateOption = document.createElement('div');
            regenerateOption.classList.add('context-menu-item', 'regenerate-text'); // Special class for styling if needed
            regenerateOption.innerHTML = `<i class="fas fa-sync-alt"></i> 重新回复`;
            regenerateOption.onclick = () => {
                handleRegenerateResponse(message);
                closeContextMenu();
            };
            menu.appendChild(regenerateOption);
        }
        menu.appendChild(deleteOption); 
    }

    document.body.appendChild(menu);
    document.addEventListener('click', closeContextMenuOnClickOutside, true);
}

function closeContextMenu() {
    const existingMenu = document.getElementById('chatContextMenu');
    if (existingMenu) {
        existingMenu.remove();
        document.removeEventListener('click', closeContextMenuOnClickOutside, true);
    }
}
// Separate closer for topic context menu to avoid interference
function closeTopicContextMenu() { 
    const existingMenu = document.getElementById('topicContextMenu');
    if (existingMenu) existingMenu.remove();
}

function closeContextMenuOnClickOutside(event) {
    const menu = document.getElementById('chatContextMenu');
    if (menu && !menu.contains(event.target)) {
        closeContextMenu();
    }
    // Also close topic menu if click is outside of it
    const topicMenu = document.getElementById('topicContextMenu');
    if (topicMenu && !topicMenu.contains(event.target)) {
        closeTopicContextMenu();
    }
}


function toggleEditMode(messageItem, message) {
    const { electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const existingTextarea = messageItem.querySelector('.message-edit-textarea');
    const existingControls = messageItem.querySelector('.message-edit-controls');

    if (existingTextarea) { // Revert to display mode (Cancel was clicked)
        // message.content should be a string (original user input or AI reply)
        let textToDisplay = (typeof message.content === 'string') ? message.content :
                            (message.content && typeof message.content.text === 'string') ? message.content.text :
                            '[内容错误]';
        if (typeof message.content !== 'string' && !(message.content && typeof message.content.text === 'string')) {
            console.warn('[MessageRenderer EditRevert] message.content is not a string or {text: string}:', message.content);
        }

        let originalContentProcessed = removeSpeakerTags(textToDisplay);
        originalContentProcessed = ensureNewlineAfterCodeBlock(originalContentProcessed);
        originalContentProcessed = ensureSpaceAfterTilde(originalContentProcessed);
        contentDiv.innerHTML = markedInstance.parse(originalContentProcessed);
        if (window.renderMathInElement) {
             window.renderMathInElement(contentDiv, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}], throwOnError: false });
        }
        processAllPreBlocksInContentDiv(contentDiv); 

        messageItem.classList.remove('message-item-editing'); 
        existingTextarea.remove();
        if (existingControls) existingControls.remove();
        contentDiv.style.display = '';
        // Restore visibility of avatar and nameTimeDiv
        const avatarEl = messageItem.querySelector('.chat-avatar');
        const nameTimeEl = messageItem.querySelector('.name-time-block');
        if(avatarEl) avatarEl.style.display = '';
        if(nameTimeEl) nameTimeEl.style.display = '';
    } else { // Switch to edit mode
        const originalContentHeight = contentDiv.offsetHeight;
        contentDiv.style.display = 'none';
        const avatarEl = messageItem.querySelector('.chat-avatar');
        const nameTimeEl = messageItem.querySelector('.name-time-block');
        if(avatarEl) avatarEl.style.display = 'none';
        if(nameTimeEl) nameTimeEl.style.display = 'none';

        messageItem.classList.add('message-item-editing'); 

        const textarea = document.createElement('textarea');
        textarea.classList.add('message-edit-textarea');
        // message.content should be a string (original user input or AI reply from history)
        // If it's an object {text: "..."}, use .text (though this shouldn't happen for history items)
        let textForEditing = "";
        if (typeof message.content === 'string') {
            textForEditing = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            textForEditing = message.content.text;
            console.warn('[MessageRenderer EditLoad] message.content was an object {text:...} when populating textarea. This is unexpected for history items.');
        } else {
            textForEditing = '[内容加载错误]';
            console.error('[MessageRenderer EditLoad] message.content is not a string or {text: string} for editing:', message.content);
        }
        textarea.value = textForEditing;
        textarea.style.minHeight = `${Math.max(originalContentHeight, 50)}px`;
        textarea.style.width = '100%';

        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('message-edit-controls');

        const saveButton = document.createElement('button');
        saveButton.innerHTML = `<i class="fas fa-save"></i> 保存`;
        saveButton.onclick = async () => {
            const newContent = textarea.value;
            const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === message.id); 
            if (messageIndex > -1) {
                // Ensure we are saving a string back to message.content
                // If original message.content was an object {text: "..."}, we should update that structure
                // However, the goal is for history message.content to always be a string.
                if (typeof currentChatHistoryArray[messageIndex].content === 'object' &&
                    currentChatHistoryArray[messageIndex].content !== null &&
                    typeof currentChatHistoryArray[messageIndex].content.text === 'string') {
                    console.warn("[MessageRenderer EditSave] Original message.content in history was an object. Updating .text field. This indicates an issue with how history was saved previously for this message.");
                    currentChatHistoryArray[messageIndex].content.text = newContent;
                } else {
                    currentChatHistoryArray[messageIndex].content = newContent;
                }
                
                mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]); // Update ref
                // Also update the 'message' object passed into toggleEditMode, ensuring its 'content' is a string
                message.content = newContent;

                if (currentSelectedItemVal.id && currentTopicIdVal) { // Save based on item type
                     if (currentSelectedItemVal.type === 'agent') {
                        await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                     } else if (currentSelectedItemVal.type === 'group') {
                        if (electronAPI.saveGroupChatHistory) { // Check if function exists
                           await electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                        } else {
                           console.warn("MessageRenderer: electronAPI.saveGroupChatHistory is not defined. Group chat history will not be saved after edit.");
                        }
                     }
                }
                
                let newContentProcessed = removeSpeakerTags(newContent);
                newContentProcessed = ensureNewlineAfterCodeBlock(newContentProcessed);
                newContentProcessed = ensureSpaceAfterTilde(newContentProcessed);
                contentDiv.innerHTML = markedInstance.parse(newContentProcessed);
                if (window.renderMathInElement) {
                    window.renderMathInElement(contentDiv, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}, {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}], throwOnError: false });
                }
                processAllPreBlocksInContentDiv(contentDiv); 
            }
            toggleEditMode(messageItem, message);
        };

        const cancelButton = document.createElement('button');
        cancelButton.innerHTML = `<i class="fas fa-times"></i> 取消`;
        cancelButton.onclick = () => {
             toggleEditMode(messageItem, message);
        };

        controlsDiv.appendChild(saveButton);
        controlsDiv.appendChild(cancelButton);
 
        messageItem.appendChild(textarea);
        messageItem.appendChild(controlsDiv);
         
        if (uiHelper.autoResizeTextarea) uiHelper.autoResizeTextarea(textarea);
        textarea.focus();
        textarea.addEventListener('input', () => uiHelper.autoResizeTextarea(textarea));
        textarea.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                cancelButton.click();
            }
            // Allow Enter for newlines, Ctrl+Enter for save could be an option
            // If Enter is pressed without Shift or Ctrl, save the message
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
                event.preventDefault(); // Prevent default newline behavior
                saveButton.click();
            } else if (event.ctrlKey && event.key === 'Enter') { // Keep Ctrl+Enter as an alternative save
                saveButton.click();
            }
        });
    }
}

async function handleRegenerateResponse(originalAssistantMessage) {
    const { electronAPI, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
    const globalSettingsVal = mainRendererReferences.globalSettingsRef.get();


    if (!currentSelectedItemVal.id || currentSelectedItemVal.type !== 'agent' || !currentTopicIdVal || !originalAssistantMessage || originalAssistantMessage.role !== 'assistant') {
        console.warn('MessageRenderer: Cannot regenerate response, invalid parameters or not an agent context.');
        uiHelper.showToastNotification("只能为 Agent 的回复进行重新生成。", "warning");
        return;
    }

    const originalMessageIndex = currentChatHistoryArray.findIndex(msg => msg.id === originalAssistantMessage.id);
    if (originalMessageIndex === -1) {
        console.warn('MessageRenderer: Cannot regenerate, original message not found in history.');
        return;
    }

    // History up to (but not including) the message before the one to regenerate
    const historyForRegeneration = currentChatHistoryArray.slice(0, originalMessageIndex);
    // Remove the original assistant message and any subsequent messages
    currentChatHistoryArray.splice(originalMessageIndex);
    mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);


    if (currentSelectedItemVal.id && currentTopicIdVal) {
        try {
            await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
        } catch (saveError) {
            console.error("MessageRenderer: Failed to save chat history after splice in regenerate:", saveError);
        }
    }

    // Remove message items from DOM
    let elementToRemove = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${originalAssistantMessage.id}"]`);
    while (elementToRemove) {
        const nextSibling = elementToRemove.nextElementSibling;
        elementToRemove.remove();
        elementToRemove = nextSibling;
    }


    const regenerationThinkingMessage = {
        role: 'assistant', 
        name: currentSelectedItemVal.name || 'AI',
        content: '', // 设置为空字符串，避免污染后续文本
        timestamp: Date.now(),
        id: `regen_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        isThinking: true,
        avatarUrl: currentSelectedItemVal.avatarUrl,
        avatarColor: currentSelectedItemVal.config?.avatarCalculatedColor,
    };
    
    // Render the "重新生成中..." message to the UI
    const regenerationMessageItem = renderMessage(regenerationThinkingMessage, false);
    if (!regenerationMessageItem) {
        console.error("[MR handleRegenerateResponse] Failed to render regeneration thinking message. Aborting.");
        return;
    }

    // Explicitly add the "重新生成中..." message to the history array.
    // This is crucial because renderMessage normally doesn't add 'isThinking' messages.
    if (!currentChatHistoryArray.find(m => m.id === regenerationThinkingMessage.id)) {
        currentChatHistoryArray.push(regenerationThinkingMessage);
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
    }

    try {
        const agentConfig = await electronAPI.getAgentConfig(currentSelectedItemVal.id); // Fetch fresh config
        
        let messagesForVCP = await Promise.all(historyForRegeneration.map(async msg => {
            // Simplified attachment processing for regeneration context
            let vcpAttachments = [];
            if (msg.attachments && msg.attachments.length > 0) {
                 vcpAttachments = await Promise.all(msg.attachments.map(async att => {
                    if (att.type.startsWith('image/')) {
                        const base64Result = await electronAPI.getFileAsBase64(att.src);
                        return base64Result && !base64Result.error ? { type: 'image_url', image_url: { url: `data:${att.type};base64,${base64Result}` } } : null;
                    }
                    return null; // Only handle images for simplicity in regen, or expand as needed
                }));
            }
            let finalContentForVCP = [];
            if (typeof msg.content === 'string' && msg.content.trim() !== '') {
                finalContentForVCP.push({ type: 'text', text: msg.content });
            }
            finalContentForVCP.push(...vcpAttachments.filter(Boolean));
            return { role: msg.role, content: finalContentForVCP.length > 0 ? finalContentForVCP : msg.content };
        }));

        if (agentConfig.systemPrompt) {
            messagesForVCP.unshift({ role: 'system', content: agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name) });
        }

        const modelConfigForVCP = {
            model: agentConfig.model,
            temperature: parseFloat(agentConfig.temperature),
            max_tokens: agentConfig.maxOutputTokens ? parseInt(agentConfig.maxOutputTokens) : undefined,
            stream: agentConfig.streamOutput === true || String(agentConfig.streamOutput) === 'true'
        };
        
        const vcpResult = await electronAPI.sendToVCP(
            globalSettingsVal.vcpServerUrl,
            globalSettingsVal.vcpApiKey,
            messagesForVCP,
            modelConfigForVCP,
            regenerationThinkingMessage.id // Associate with the new thinking message ID
        );

        if (modelConfigForVCP.stream) {
            // If streaming is intended, call startStreamingMessage to prepare the UI
            // This should happen regardless of vcpResult.streamingStarted, as that's just a confirmation from main.
            // The UI needs to be ready for chunks.
            if (window.messageRenderer) {
                 // console.log(`[handleRegenerateResponse] Attempting to start streaming for ${regenerationThinkingMessage.id}`);
                 // No need for an artificial delay here as the "thinking" message is already rendered.
                 window.messageRenderer.startStreamingMessage({ ...regenerationThinkingMessage, content: "" });
            }

            if (vcpResult.streamingStarted) {
                // Main process has confirmed it's handling the stream. Chunks will arrive via onVCPStreamChunk.
                console.log(`[handleRegenerateResponse] Streaming started for ${regenerationThinkingMessage.id} as confirmed by main process.`);
            } else if (vcpResult.streamError || !vcpResult.streamingStarted) {
                let detailedError = vcpResult.error || '未能启动流';
                if (vcpResult.errorDetail && typeof vcpResult.errorDetail.message === 'string' && vcpResult.errorDetail.message.trim() !== '') {
                    detailedError = vcpResult.errorDetail.message;
                }
                else if (vcpResult.errorDetail && typeof vcpResult.errorDetail === 'string') detailedError = vcpResult.errorDetail;
                console.error(`[handleRegenerateResponse] VCP Stream Error or did not start for ${regenerationThinkingMessage.id}:`, detailedError);
                finalizeStreamedMessage(regenerationThinkingMessage.id, 'error', `VCP 流错误 (重新生成): ${detailedError}`);
            }
        } else {
            // Non-streaming response for regeneration
            const thinkingItem = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${regenerationThinkingMessage.id}"]`);
            if(thinkingItem) thinkingItem.remove(); // Remove "thinking"
            const thinkingIdxHistory = currentChatHistoryArray.findIndex(m => m.id === regenerationThinkingMessage.id);
            if(thinkingIdxHistory > -1) currentChatHistoryArray.splice(thinkingIdxHistory, 1);


            if (vcpResult.error) {
                renderMessage({ role: 'system', content: `VCP错误 (重新生成): ${vcpResult.error}`, timestamp: Date.now() });
            } else if (vcpResult.choices && vcpResult.choices.length > 0) {
                const assistantMessageContent = vcpResult.choices[0].message.content;
                renderMessage({ role: 'assistant', name: agentConfig.name, avatarUrl: agentConfig.avatarUrl, avatarColor: agentConfig.avatarCalculatedColor, content: assistantMessageContent, timestamp: Date.now() });
            } else {
                renderMessage({ role: 'system', content: 'VCP返回了未知格式的响应 (重新生成)。', timestamp: Date.now() });
            }
            mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
            if (currentSelectedItemVal.id && currentTopicIdVal) await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
            uiHelper.scrollToBottom();
        }

    } catch (error) {
        console.error('MessageRenderer: Error regenerating response:', error);
        // Ensure finalizeStreamedMessage is called for the thinking message ID
        // It's possible the thinking message was not correctly updated to streaming state
        // or found in history if an error occurred very early.
        // We pass the error message to be displayed.
        finalizeStreamedMessage(regenerationThinkingMessage.id, 'error', `客户端错误 (重新生成): ${error.message}`);
        // The renderMessage call for system error might be redundant if finalizeStreamedMessage handles it,
        // but let's keep it for now as a fallback display if finalize doesn't find the item.
        // renderMessage({ role: 'system', content: `错误 (重新生成): ${error.message}`, timestamp: Date.now() });
        if (currentSelectedItemVal.id && currentTopicIdVal) await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
        uiHelper.scrollToBottom();
    }
}

// Expose methods to renderer.js
window.messageRenderer = {
    initializeMessageRenderer,
    setCurrentSelectedItem, // Keep for renderer.js to call
    setCurrentTopicId,      // Keep for renderer.js to call
    setCurrentItemAvatar,   // Renamed for clarity
    setUserAvatar,          
    setCurrentItemAvatarColor, // Renamed
    setUserAvatarColor,         
    renderMessage,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    // Helper functions that renderer might need if they were previously here, e.g., clearChat
    clearChat: () => {
        if (mainRendererReferences.chatMessagesDiv) mainRendererReferences.chatMessagesDiv.innerHTML = '';
        mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
    },
    removeMessageById: (messageId) => {
        const item = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (item) item.remove();
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        const index = currentChatHistoryArray.findIndex(m => m.id === messageId);
        if (index > -1) {
            currentChatHistoryArray.splice(index, 1);
            mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
        }
    },
    summarizeTopicFromMessages: async (history, agentName) => { // Example: Keep this if it's generic enough
        // This function was passed in, so it's likely defined in renderer.js or another module.
        // If it's meant to be internal to messageRenderer, its logic would go here.
        // For now, assume it's an external utility.
        if (mainRendererReferences.summarizeTopicFromMessages) {
            return mainRendererReferences.summarizeTopicFromMessages(history, agentName);
        }
        return null;
    }
};
