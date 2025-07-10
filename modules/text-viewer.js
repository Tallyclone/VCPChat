document.addEventListener('DOMContentLoaded', async () => {
    let originalRawContent = ''; // To store the raw, un-rendered content

    // --- Start: Ported Pre-processing functions from messageRenderer ---

    function deIndentHtml(text) {
        const lines = text.split('\n');
        let inFence = false;
        return lines.map(line => {
            if (line.trim().startsWith('```')) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && line.trim().startsWith('<')) {
                return line.trimStart();
            }
            return line;
        }).join('\n');
    }

    function addParserBreakerBetweenDivAndCode(text) {
        const regex = /(<\/div>)\s*(```(?=[\s\S]*?(?:<<<\[TOOL_REQUEST\]>>>|<<<DailyNoteStart>>>)))/g;
        return text.replace(regex, '$1\n\n<!-- -->\n\n$2');
    }

    function ensureSpecialBlockFenced(text, startTag, endTag) {
        if (!text.includes(startTag)) return text;
        const regex = new RegExp(`(\`\`\`[\\s\\S]*?${startTag}[\\s\\S]*?${endTag}[\\s\\S]*?\`\`\`)|(${startTag}[\\s\\S]*?${endTag})`, 'g');
        return text.replace(regex, (match, fencedBlock, unfencedBlock) => {
            if (fencedBlock) return fencedBlock;
            if (unfencedBlock) return `\n\`\`\`\n${unfencedBlock}\n\`\`\`\n`;
            return match;
        });
    }
    
    function ensureHtmlFenced(text) {
        const doctypeTag = '<!DOCTYPE html>';
        if (!text.toLowerCase().includes(doctypeTag.toLowerCase())) return text;
        let result = '';
        let lastIndex = 0;
        while (true) {
            const startIndex = text.toLowerCase().indexOf(doctypeTag.toLowerCase(), lastIndex);
            const textSegment = text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);
            result += textSegment;
            if (startIndex === -1) break;
            const endIndex = text.toLowerCase().indexOf('</html>', startIndex + doctypeTag.length);
            if (endIndex === -1) {
                result += text.substring(startIndex);
                break;
            }
            const block = text.substring(startIndex, endIndex + '</html>'.length);
            const fencesInResult = (result.match(/```/g) || []).length;
            if (fencesInResult % 2 === 0) {
                result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
            } else {
                result += block;
            }
            lastIndex = endIndex + '</html>'.length;
        }
        return result;
    }

    function preprocessFullContent(text) {
        let processed = text;
        processed = deIndentHtml(processed);
        processed = addParserBreakerBetweenDivAndCode(processed);
        processed = ensureSpecialBlockFenced(processed, '<<<[TOOL_REQUEST]>>>', '<<<[END_TOOL_REQUEST]>>>');
        processed = ensureSpecialBlockFenced(processed, '<<<DailyNoteStart>>>', '<<<DailyNoteEnd>>>');
        processed = ensureHtmlFenced(processed);
        // Basic content processors from contentProcessor.js
        processed = processed.replace(/^(\s*```)(?![\r\n])/gm, '$1\n'); // ensureNewlineAfterCodeBlock
        processed = processed.replace(/~(?![\s~])/g, '~ '); // ensureSpaceAfterTilde
        processed = processed.replace(/^(\s*)(```.*)/gm, '$2'); // removeIndentationFromCodeBlockMarkers
        processed = processed.replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2'); // ensureSeparatorBetweenImgAndCode
        return processed;
    }

    // --- End: Ported functions ---


    // --- Theme Management ---
    function applyTheme(theme) {
        const currentTheme = theme || 'dark';
        document.body.classList.toggle('light-theme', currentTheme === 'light');
        const highlightThemeStyle = document.getElementById('highlight-theme-style');
        if (highlightThemeStyle) {
            highlightThemeStyle.href = currentTheme === 'light'
                ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css"
                : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
        }
    }

    if (window.electronAPI) {
        try {
            const initialTheme = await window.electronAPI.getCurrentTheme();
            applyTheme(initialTheme);
        } catch (e) {
            console.error("Failed to get initial theme for text viewer", e);
            applyTheme('dark'); // Fallback
        }
        window.electronAPI.onThemeUpdated((theme) => {
            console.log(`Theme update received in text viewer: ${theme}`);
            applyTheme(theme);
        });
    } else {
        applyTheme('dark'); // Fallback for non-electron env
    }

    mermaid.initialize({ startOnLoad: false }); // 初始化 Mermaid，但不自动渲染

    if (window.marked) {
        marked.setOptions({
            gfm: true,
            tables: true,
            breaks: false,
            pedantic: false,
            sanitize: false,
            smartLists: true,
            smartypants: false
        });
    }

    // --- Dual-Mode Python Execution ---
    let pyodide = null;
    let isPyodideLoading = false;

    async function initializePyodide(statusElement) {
        if (pyodide) return pyodide;
        if (isPyodideLoading) {
            statusElement.textContent = 'Pyodide is already loading, please wait...';
            return null;
        }
        isPyodideLoading = true;
        try {
            statusElement.textContent = 'Loading Pyodide script...';
            if (!window.loadPyodide) {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js';
                document.head.appendChild(script);
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                });
            }
            statusElement.textContent = 'Initializing Pyodide core... (this may take a moment)';
            pyodide = await window.loadPyodide();
            console.log("Pyodide initialized successfully.");
            return pyodide;
        } catch (error) {
            console.error("Pyodide initialization failed:", error);
            statusElement.textContent = `Pyodide initialization failed: ${error}`;
            return null;
        } finally {
            isPyodideLoading = false;
        }
    }


    // --- Start: Python Executors as requested ---

    async function py_safe_executor(code, outputContainer) {
        outputContainer.textContent = 'Preparing Python sandbox environment...';
        const pyodideInstance = await initializePyodide(outputContainer);
        if (!pyodideInstance) return;

        try {
            const packageRegex = /^#\s*requires:\s*([a-zA-Z0-9_,\s-]+)/gm;
            const packages = new Set();
            let match;
            while ((match = packageRegex.exec(code)) !== null) {
                match[1].split(',').forEach(p => {
                    const pkg = p.trim();
                    if (pkg) packages.add(pkg);
                });
            }

            if (packages.size > 0) {
                const packageList = Array.from(packages);
                outputContainer.textContent = `Installing required packages: ${packageList.join(', ')}...`;
                await pyodideInstance.loadPackage("micropip");
                const micropip = pyodideInstance.pyimport("micropip");
                await micropip.install(packageList);
                outputContainer.textContent = 'Packages installed. Executing code...';
            } else {
                outputContainer.textContent = 'Executing code in sandbox...';
            }

            let stdout = '';
            let stderr = '';
            pyodideInstance.setStdout({ batched: (s) => { stdout += s + '\n'; } });
            pyodideInstance.setStderr({ batched: (s) => { stderr += s + '\n'; } });
            await pyodideInstance.runPythonAsync(code);

            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += `\n--- ERRORS ---\n${stderr}`;
            outputContainer.textContent = result.trim() || 'Execution finished with no output.';
        } catch (error) {
            console.error("Sandbox Python execution error:", error);
            outputContainer.textContent = `Sandbox Execution Error:\n${error.toString()}`;
        }
    }

    async function py_penetration_executor(code, outputContainer) {
        console.log('[text-viewer] Entering py_penetration_executor.');
        outputContainer.textContent = 'Executing with local Python...';
        if (window.electronAPI && window.electronAPI.executePythonCode) {
            try {
                console.log('[text-viewer] Calling electronAPI.executePythonCode...');
                const { stdout, stderr } = await window.electronAPI.executePythonCode(code);
                console.log('[text-viewer] electronAPI.executePythonCode returned.');
                console.log('[text-viewer] Python stdout (from renderer):', stdout);
                console.log('[text-viewer] Python stderr (from renderer):', stderr);

                let result = '';
                // Strip ANSI escape codes before displaying
                const cleanedStdout = stripAnsi(stdout);
                const cleanedStderr = stripAnsi(stderr);

                if (cleanedStdout) result += `--- Output ---\n${cleanedStdout}`;
                if (cleanedStderr) result += `\n--- Errors ---\n${cleanedStderr}`;
                outputContainer.textContent = result.trim() || 'Execution finished with no output.';
            } catch (error) {
                console.error("[text-viewer] Local Python execution error (in renderer):", error);
                outputContainer.textContent = `Local Execution Error:\n${error.toString()}`;
            }
        } else {
            outputContainer.textContent = 'Error: electronAPI.executePythonCode is not available.';
            console.error('[text-viewer] electronAPI.executePythonCode is not available.');
        }
        console.log('[text-viewer] Exiting py_penetration_executor.');
    }

    // --- End: Python Executors as requested ---
    async function runPythonCode(code, outputContainer) {
        outputContainer.style.display = 'block';
        const isSandboxMode = document.getElementById('sandbox-toggle').checked;

        if (isSandboxMode) {
            await py_safe_executor(code, outputContainer);
        } else {
            await py_penetration_executor(code, outputContainer);
        }
    }
    // --- End Dual-Mode Python Execution ---

    // Function to strip ANSI escape codes
    function stripAnsi(str) {
        // eslint-disable-next-line no-control-regex
        return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '');
    }

    function removeBoldMarkersAroundQuotes(text) {
        if (typeof text !== 'string') return text;
        // Replace **" with " and **“ with “
        let processedText = text.replace(/\*\*(["“])/g, '$1');
        // Replace "** with " and ”** with ”
        processedText = processedText.replace(/(["”])\*\*/g, '$1');
        return processedText;
    }

    function renderQuotedText(text, currentTheme) {
        const className = currentTheme === 'light' ? 'custom-quote-light' : 'custom-quote-dark';
        // This regex uses alternation. It first tries to match a whole code block.
        // If it matches, the code block is returned unmodified.
        // Otherwise, it tries to match a quoted string and wraps it.
        // This is much more robust than splitting the string.
        return text.replace(/(```[\s\S]*?```)|("([^"]*?)"|“([^”]*?)”)/g, (match, codeBlock, fullQuote) => {
            // If a code block is matched (group 1), return it as is.
            if (codeBlock) {
                return codeBlock;
            }
            // If a quote is matched (group 2), wrap it in a span.
            if (fullQuote) {
                return `<span class="${className}">${fullQuote}</span>`;
            }
            // Fallback, should not happen with this regex structure
            return match;
        });
    }

    function decodeHtmlEntities(text) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = text;
        return textarea.value;
    }

    const params = new URLSearchParams(window.location.search);
    const textContent = params.get('text');
    const windowTitle = params.get('title') || '文本阅读模式';
    const encoding = params.get('encoding');

    document.title = decodeURIComponent(windowTitle);
    const contentDiv = document.getElementById('textContent');
    const editAllButton = document.getElementById('editAllButton'); // Get the new button
    const shareToNotesButton = document.getElementById('shareToNotesButton');

    // Global edit button logic
    if (editAllButton && contentDiv) {
        // Store references to the button's icon and text elements
        let currentEditAllButtonIcon = editAllButton.querySelector('svg');
        const editAllButtonText = editAllButton.querySelector('span');

        const globalEditIconSVGString = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        const globalDoneIconSVGString = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;

        editAllButton.addEventListener('click', () => {
            const existingTextarea = document.querySelector('.global-edit-textarea');
            currentEditAllButtonIcon = editAllButton.querySelector('svg');

            if (existingTextarea) { // === Exiting edit mode ===
                originalRawContent = existingTextarea.value; // Get updated raw content

                // Re-render content using the full pipeline
                const processedContent = preprocessFullContent(originalRawContent);
                const renderedHtml = window.marked.parse(processedContent);
                contentDiv.innerHTML = renderedHtml;
                enhanceRenderedContent(contentDiv); // This already includes syntax highlighting etc.

                // UI cleanup
                existingTextarea.remove();
                contentDiv.style.display = '';
                if (currentEditAllButtonIcon) currentEditAllButtonIcon.outerHTML = globalEditIconSVGString;
                if (editAllButtonText) editAllButtonText.textContent = '编辑全文';
                editAllButton.setAttribute('title', '编辑全文');

            } else { // === Entering edit mode ===
                contentDiv.style.display = 'none'; // Hide rendered content

                const textarea = document.createElement('textarea');
                textarea.className = 'global-edit-textarea';
                textarea.value = originalRawContent; // Put raw content in textarea

                // Basic styling for the textarea
                textarea.style.width = '100%';
                textarea.style.minHeight = '70vh';
                textarea.style.boxSizing = 'border-box';
                textarea.style.backgroundColor = 'var(--viewer-code-bg)';
                textarea.style.color = 'var(--viewer-primary-text)';
                textarea.style.border = '1px solid var(--viewer-code-bg-hover)';
                textarea.style.borderRadius = '8px';
                textarea.style.padding = '15px';
                textarea.style.fontFamily = 'var(--font-family-monospace, monospace)';
                textarea.style.lineHeight = '1.5';

                // Insert textarea and focus
                contentDiv.parentNode.insertBefore(textarea, contentDiv.nextSibling);
                textarea.focus();

                // Update button state
                if (currentEditAllButtonIcon) currentEditAllButtonIcon.outerHTML = globalDoneIconSVGString;
                if (editAllButtonText) editAllButtonText.textContent = '完成编辑';
                editAllButton.setAttribute('title', '完成编辑');
            }
        });
    }

    if (shareToNotesButton && contentDiv) {
        shareToNotesButton.addEventListener('click', () => {
            const noteTitle = document.title || '来自阅读模式的分享'; // 使用页面标题或默认标题
            
            // 尝试通过 electronAPI 打开新窗口或通知主进程处理
            if (window.electronAPI && window.electronAPI.openNotesWithContent) {
                console.log('[text-viewer] Attempting to share via electronAPI.openNotesWithContent');
                window.electronAPI.openNotesWithContent({
                    title: noteTitle,
                    content: originalRawContent, // Use the raw source content
                }).catch(err => {
                    console.error('[text-viewer] Error calling electronAPI.openNotesWithContent:', err);
                    // 如果API调用失败，可以在这里给用户一些提示
                    alert('分享到笔记失败，请检查控制台获取更多信息。');
                });
            } else {
                console.error('[text-viewer] electronAPI.openNotesWithContent is not available.');
                alert('分享功能不可用，无法连接到主进程。');
            }
        });
    }

    function enhanceRenderedContent(container) {
        // Single pass to enhance all code blocks following the user's suggested logic
        container.querySelectorAll('pre code').forEach((block) => {
            const preElement = block.parentElement;
            if (preElement.querySelector('.copy-button')) return; // Already enhanced

            // --- Step 1: Clean the language identifier from the text content (Simple & Direct) ---
            // Use textContent which is safer for preserving line breaks than innerText.
            let lines = block.textContent.split('\n');
            if (lines.length > 0) {
                const firstLine = lines[0].trim().toLowerCase();
                if (firstLine === 'python' || firstLine === 'html') {
                    lines.shift();
                    block.textContent = lines.join('\n');
                }
            }

            // --- Step 2: Apply syntax highlighting to the cleaned block ---
            if (window.hljs) {
                hljs.highlightElement(block);
            }

            // --- Step 3: Add interactive buttons ---
            preElement.style.position = 'relative';
            const codeContent = decodeHtmlEntities(block.textContent); // Use textContent to preserve line breaks
            
            // --- Robust HTML Detection Logic (User's Suggestion) ---
            const isHtmlByClass = Array.from(block.classList).some(cls => /^language-html$/i.test(cls));
            const trimmedContent = codeContent.trim().toLowerCase();
            const isHtmlByContent = trimmedContent.startsWith('<!doctype html>') || trimmedContent.startsWith('<html>');
            const isHtml = isHtmlByClass || isHtmlByContent;
            // --- End of Robust Logic ---

            const isPython = Array.from(block.classList).some(cls => /^language-python$/i.test(cls));

            if (isHtml) {
                const playButton = document.createElement('button');
                const playIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
                const codeIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
                playButton.innerHTML = playIconSVG;
                playButton.className = 'play-button';
                playButton.setAttribute('title', '预览HTML');
                preElement.appendChild(playButton);

                playButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const existingPreview = preElement.nextElementSibling;
                    if (existingPreview && existingPreview.classList.contains('html-preview-container')) {
                        existingPreview.remove();
                        preElement.style.display = 'block';
                        return;
                    }
                    preElement.style.display = 'none';
                    const previewContainer = document.createElement('div');
                    previewContainer.className = 'html-preview-container';
                    const iframe = document.createElement('iframe');
                    iframe.sandbox = 'allow-scripts allow-same-origin';
                    const exitButton = document.createElement('button');
                    exitButton.innerHTML = codeIconSVG + ' 返回代码';
                    exitButton.className = 'exit-preview-button';
                    exitButton.title = '返回代码视图';
                    exitButton.addEventListener('click', () => {
                        previewContainer.remove();
                        preElement.style.display = 'block';
                    });
                    previewContainer.appendChild(iframe);
                    previewContainer.appendChild(exitButton);
                    preElement.parentNode.insertBefore(previewContainer, preElement.nextSibling);
                    const iframeDoc = iframe.contentWindow.document;
                    iframeDoc.open();
                    let finalHtml = codeContent; // codeContent is already cleaned
                    const trimmedCode = codeContent.trim().toLowerCase();
                    if (!trimmedCode.startsWith('<!doctype') && !trimmedCode.startsWith('<html>')) {
                        const bodyStyles = document.body.classList.contains('light-theme')
                            ? 'color: #2c3e50; background-color: #ffffff;'
                            : 'color: #abb2bf; background-color: #282c34;';
                        finalHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HTML Preview</title><style>body { font-family: sans-serif; padding: 15px; margin: 0; ${bodyStyles} }</style></head><body>${codeContent}</body></html>`;
                    }
                    iframeDoc.write(finalHtml);
                    iframeDoc.close();
                });
            } else if (isPython) {
                const pyPlayButton = document.createElement('button');
                const playIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
                pyPlayButton.innerHTML = playIconSVG;
                pyPlayButton.className = 'play-button';
                pyPlayButton.setAttribute('title', 'Run Python Code');
                preElement.appendChild(pyPlayButton);
                const outputContainer = document.createElement('div');
                outputContainer.className = 'python-output-container';
                preElement.parentNode.insertBefore(outputContainer, preElement.nextSibling);
                pyPlayButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (outputContainer.style.display === 'block') {
                        outputContainer.style.display = 'none';
                    } else {
                        const codeToRun = decodeHtmlEntities(block.innerText); // Get the cleaned text
                        runPythonCode(codeToRun, outputContainer);
                    }
                });
            }

            const editButton = document.createElement('button');
            const editIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
            const doneIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
            editButton.innerHTML = editIconSVG;
            editButton.className = 'edit-button';
            editButton.setAttribute('title', '编辑');
            editButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isEditing = block.isContentEditable;
                block.contentEditable = !isEditing;
                if (!isEditing) {
                    block.focus();
                    editButton.innerHTML = doneIconSVG;
                    editButton.setAttribute('title', '完成编辑');
                } else {
                    editButton.innerHTML = editIconSVG;
                    editButton.setAttribute('title', '编辑');
                    // Re-highlight after editing is done
                    if (window.hljs) {
                        hljs.highlightElement(block);
                    }
                }
            });
            preElement.appendChild(editButton);

            const copyButton = document.createElement('button');
            copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
            copyButton.className = 'copy-button';
            copyButton.setAttribute('title', '复制');
            copyButton.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(block.innerText).catch(err => console.error('无法复制到剪贴板:', err));
            });
            preElement.appendChild(copyButton);
        });

        // Render Mermaid diagrams
        if (window.mermaid) {
            container.querySelectorAll('div.mermaid').forEach((mermaidBlock) => {
                 try {
                    mermaid.run({ nodes: [mermaidBlock] });
                 } catch(e) {
                    console.error("Mermaid rendering error:", e);
                    mermaidBlock.innerHTML = `Mermaid Error: ${e.message}`;
                 }
            });
        }

        // Render LaTeX
        if (window.renderMathInElement) {
            try {
                renderMathInElement(container, {
                    delimiters: [
                        {left: "$$", right: "$$", display: true},
                        {left: "$", right: "$", display: false},
                        {left: "\\(", right: "\\)", display: false},
                        {left: "\\[", right: "\\]", display: true}
                    ],
                    throwOnError: false
                });
            } catch (e) {
                console.error("KaTeX rendering error:", e);
            }
        }
    }

    if (textContent) {
        try {
            let decodedText;
            if (encoding === 'base64') {
                const rawDecoded = atob(textContent);
                decodedText = decodeURIComponent(rawDecoded.split('').map(function(c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
            } else {
                decodedText = decodeURIComponent(textContent);
            }
            originalRawContent = decodedText; // Store the raw source content

            // Render with the full pre-processing pipeline
            const processedContent = preprocessFullContent(originalRawContent);
            const renderedHtml = window.marked.parse(processedContent);
            contentDiv.innerHTML = renderedHtml;

            // After rendering, enhance the content with interactivity
            enhanceRenderedContent(contentDiv);

        } catch (error) {
            console.error("Error rendering content:", error);
            contentDiv.innerHTML = `
                <h3 style="color: #e06c75;">内容渲染失败</h3>
                <p>在处理文本时发生错误，这可能是由于文本包含了格式不正确的编码字符。</p>
                <p><strong>错误详情:</strong></p>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${error.toString()}</pre>
                <p><strong>原始文本内容:</strong></p>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${textContent}</pre>
            `;
        }
    } else {
        contentDiv.textContent = '没有提供文本内容。';
    }

    // Custom Context Menu Logic
    const contextMenu = document.getElementById('customContextMenu');
    const contextMenuCopyButton = document.getElementById('contextMenuCopy');
    const contextMenuCutButton = document.getElementById('contextMenuCut');
    const contextMenuDeleteButton = document.getElementById('contextMenuDelete');
    const contextMenuEditAllButton = document.getElementById('contextMenuEditAll');
    const contextMenuCopyAllButton = document.getElementById('contextMenuCopyAll');
    const mainContentDiv = document.getElementById('textContent'); // Renamed for clarity from previous contentDiv

    if (contextMenu && contextMenuCopyButton && contextMenuCutButton && contextMenuDeleteButton && contextMenuEditAllButton && contextMenuCopyAllButton && mainContentDiv) {
        document.addEventListener('contextmenu', (event) => {
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();

            event.preventDefault(); // Always prevent default to show custom menu

            contextMenu.style.top = `${event.pageY}px`;
            contextMenu.style.left = `${event.pageX}px`;
            contextMenu.style.display = 'block';

            if (selectedText) {
                // Show standard copy, cut, delete if text is selected
                contextMenuCopyButton.style.display = 'block';
                contextMenuCutButton.style.display = 'block';
                contextMenuDeleteButton.style.display = 'block';
                contextMenuEditAllButton.style.display = 'none';
                contextMenuCopyAllButton.style.display = 'none';
            } else {
                // Show "Edit All" and "Copy All" if no text is selected
                contextMenuCopyButton.style.display = 'none';
                contextMenuCutButton.style.display = 'none';
                contextMenuDeleteButton.style.display = 'none';
                contextMenuEditAllButton.style.display = 'block';
                contextMenuCopyAllButton.style.display = 'block';
            }

            // Determine if Cut and Delete should be shown (based on editability)
            let isAnyEditableContext = mainContentDiv.isContentEditable; // Check global edit mode
            const targetElement = event.target;
            const closestCodeBlock = targetElement.closest('code.hljs');

            if (!isAnyEditableContext && closestCodeBlock && closestCodeBlock.isContentEditable) {
                isAnyEditableContext = true;
            }

            // If text is selected, adjust cut/delete visibility based on editability
            if (selectedText) {
                contextMenuCutButton.style.display = isAnyEditableContext ? 'block' : 'none';
                contextMenuDeleteButton.style.display = isAnyEditableContext ? 'block' : 'none';
            }
        });

        document.addEventListener('click', (event) => {
            if (contextMenu.style.display === 'block' && !contextMenu.contains(event.target)) {
                contextMenu.style.display = 'none';
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                contextMenu.style.display = 'none';
            }
        });

        contextMenuCopyButton.addEventListener('click', () => {
            const selectedText = window.getSelection().toString();
            if (selectedText) {
                navigator.clipboard.writeText(selectedText).then(() => {
                    console.log('文本已复制到剪贴板');
                }).catch(err => {
                    console.error('无法复制文本: ', err);
                });
            }
            contextMenu.style.display = 'none';
        });

        contextMenuCutButton.addEventListener('click', () => {
            const selection = window.getSelection();
            const selectedText = selection.toString();
            
            let canPerformEdit = mainContentDiv.isContentEditable;
            const activeCodeBlock = document.activeElement && document.activeElement.closest('code.hljs') && document.activeElement.isContentEditable;
            if(!canPerformEdit && activeCodeBlock){
                canPerformEdit = true;
            }

            if (selectedText && canPerformEdit) {
                navigator.clipboard.writeText(selectedText).then(() => {
                    document.execCommand('delete', false, null);
                    console.log('文本已剪切到剪贴板');
                }).catch(err => {
                    console.error('无法剪切文本: ', err);
                });
            }
            contextMenu.style.display = 'none';
        });

        contextMenuDeleteButton.addEventListener('click', () => {
            const selection = window.getSelection();
            let canPerformEdit = mainContentDiv.isContentEditable;
            const activeCodeBlock = document.activeElement && document.activeElement.closest('code.hljs') && document.activeElement.isContentEditable;
             if(!canPerformEdit && activeCodeBlock){
                canPerformEdit = true;
            }

            if (selection.toString() && canPerformEdit) {
                document.execCommand('delete', false, null);
                console.log('选中文本已删除');
            }
            contextMenu.style.display = 'none';
        });
        contextMenuEditAllButton.addEventListener('click', () => {
            editAllButton.click(); // Trigger the global edit button's click event
            contextMenu.style.display = 'none';
        });

        contextMenuCopyAllButton.addEventListener('click', () => {
            const fullText = mainContentDiv.innerText;
            navigator.clipboard.writeText(fullText).then(() => {
                console.log('全文已复制到剪贴板');
            }).catch(err => {
                console.error('无法复制全文: ', err);
            });
            contextMenu.style.display = 'none';
        });
    }
    
    // Add keyboard listener for Escape key to close the window
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            window.close();
        }
    });
});
