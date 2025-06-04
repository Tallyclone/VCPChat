document.addEventListener('DOMContentLoaded', async () => {
    const noteList = document.getElementById('noteList');
    const newNoteBtn = document.getElementById('newNoteBtn');
    const saveNoteBtn = document.getElementById('saveNoteBtn');
    const deleteNoteBtn = document.getElementById('deleteNoteBtn');
    const noteTitleInput = document.getElementById('noteTitle');
    const noteContentInput = document.getElementById('noteContent');
    const searchInput = document.getElementById('searchInput');
    const previewContentDiv = document.getElementById('previewContent');
    const editorBubble = document.querySelector('.editor-bubble');
    const previewBubble = document.querySelector('.preview-bubble');
    const customContextMenu = document.getElementById('customContextMenu');
    const contextMenuCopy = document.getElementById('contextMenuCopy');
    const contextMenuCut = document.getElementById('contextMenuCut');
    const contextMenuPaste = document.getElementById('contextMenuPaste');

    let notes = [];
    let activeNoteId = null; // Stores the ID of the currently active note
    let deleteTimer = null; // Timer for two-step delete confirmation

    let autoSaveTimer = null; // Timer for debounced auto-save

    // Debounce function
    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    // Helper function to show button feedback
    function showButtonFeedback(button, originalText, feedbackText, isSuccess = true, duration = 2000) {
        const originalBg = button.style.backgroundColor;
        const originalColor = button.style.color;
        const originalBorder = button.style.borderColor;

        button.textContent = feedbackText;
        if (isSuccess) {
            button.style.backgroundColor = 'var(--success-color, #4CAF50)';
            button.style.borderColor = 'var(--success-color, #4CAF50)';
            button.style.color = 'white';
        } else {
            button.style.backgroundColor = 'var(--error-color, #F44336)';
            button.style.borderColor = 'var(--error-color, #F44336)';
            button.style.color = 'white';
        }
        button.disabled = true; // Disable button to prevent multiple clicks

        setTimeout(() => {
            button.textContent = originalText;
            button.style.backgroundColor = originalBg;
            button.style.color = originalColor;
            button.style.borderColor = originalBorder;
            button.disabled = false;
        }, duration);
    }

    // Function to apply theme based on URL parameter
    function applyTheme() {
        const params = new URLSearchParams(window.location.search);
        const theme = params.get('theme') || 'dark'; // Default to dark
        const highlightThemeStyle = document.getElementById('highlight-theme-style');
        if (theme === 'light') {
            document.body.classList.add('light-theme');
            if (highlightThemeStyle) {
                highlightThemeStyle.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css";
            }
        } else {
            document.body.classList.remove('light-theme');
            if (highlightThemeStyle) {
                highlightThemeStyle.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
            }
        }
    }

    // Initial theme application
    applyTheme();

    // Function to render Markdown with syntax highlighting
    function renderMarkdown(markdown) {
        if (window.marked && window.hljs) {
            const renderer = new marked.Renderer();
            const originalImageRenderer = renderer.image.bind(renderer);

            renderer.image = (href, title, text) => {
                console.log(`[Marked Renderer - All Images] Raw href type: ${typeof href}, value:`, href, `title: ${title}, text: ${text}`);

                let actualHref = href;
                if (typeof href === 'object' && href !== null && href.href) {
                    actualHref = href.href; // Attempt to get string URL from object
                    console.log(`[Marked Renderer] Extracted href from object: ${actualHref}`);
                } else if (typeof href !== 'string') {
                    console.error('[Marked Renderer] href is not a string and has no .href property. Cannot render image. Href was:', href);
                     // Return alt text or a placeholder if href is unusable
                    return text || '[Image URL Error]';
                }

                // Ensure actualHref is a string before proceeding with startsWith
                if (typeof actualHref === 'string') {
                    if (actualHref.startsWith('file:///')) {
                        console.log(`[Marked Renderer] Rendering local image with alt: "${text}" and title: "${title}" using actualHref: ${actualHref}`);
                        const escapedHref = actualHref.replace(/"/g, '"');
                        return `<img src="${escapedHref}" alt="${text || 'Pasted Image'}" ${title ? `title="${title}"` : ''} style="max-width: 100%; display: block;">`;
                    } else if (actualHref.startsWith('http://') || actualHref.startsWith('https://')) {
                        console.log(`[Marked Renderer] Rendering remote image: ${actualHref}`);
                        const escapedHref = actualHref.replace(/"/g, '"');
                        return `<img src="${escapedHref}" alt="${text || 'Pasted Image'}" ${title ? `title="${title}"` : ''} style="max-width: 100%;">`;
                    }
                }
                
                console.log('[Marked Renderer] Passing to originalImageRenderer for href:', actualHref);
                return originalImageRenderer(actualHref, title, text);
            };

            marked.setOptions({
                renderer: renderer,
                highlight: function(code, lang) {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    return hljs.highlight(code, { language }).value;
                },
                langPrefix: 'hljs language-' // highlight.js css expects this
            });
            const html = marked.parse(markdown);
            previewContentDiv.innerHTML = html;

            // Render LaTeX using KaTeX
            if (window.renderMathInElement) {
                renderMathInElement(previewContentDiv, {
                    delimiters: [
                        {left: "$$", right: "$$", display: true},
                        {left: "$", right: "$", display: false},
                        {left: "\\(", right: "\\)", display: false},
                        {left: "\\[", right: "\\]", display: true}
                    ],
                    throwOnError: false // Don't throw error for invalid LaTeX
                });
            }

            // Re-apply highlighting to code blocks after KaTeX might have altered them
            // and before adding copy buttons.
            if (window.hljs) {
                previewContentDiv.querySelectorAll('pre code').forEach((block) => {
                    // Remove existing highlighted content if any, to prevent nested spans
                    // block.innerHTML = block.textContent; // This might be too aggressive, hljs.highlightElement should handle it.
                    hljs.highlightElement(block);
                });
            }

            // Add copy buttons to code blocks in preview
            // Ensure we select blocks that have been processed by highlight.js (they should have .hljs class)
            previewContentDiv.querySelectorAll('pre code.hljs').forEach((block) => {
                const preElement = block.parentElement;
                if (preElement.querySelector('.copy-button')) return; // Avoid adding multiple buttons

                preElement.style.position = 'relative'; // Needed for absolute positioning of the button

                const copyButton = document.createElement('button');
                copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
                copyButton.className = 'copy-button';
                copyButton.setAttribute('title', '复制');

                copyButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const codeToCopy = block.innerText;
                    navigator.clipboard.writeText(codeToCopy).then(() => {
                        copyButton.style.borderColor = 'var(--success-color, #4CAF50)';
                        setTimeout(() => {
                            copyButton.style.borderColor = 'var(--border-color)'; // Use CSS var
                        }, 1500);
                    }).catch(err => {
                        console.error('无法复制到剪贴板:', err);
                        copyButton.style.borderColor = 'var(--error-color, #F44336)';
                        setTimeout(() => {
                            copyButton.style.borderColor = 'var(--border-color)'; // Use CSS var
                        }, 1500);
                    });
                });
                preElement.appendChild(copyButton);
            });
        } else {
            previewContentDiv.textContent = markdown; // Fallback
        }
    }

    // Function to load notes from the file system
    async function loadNotes() {
        try {
            notes = await window.electronAPI.readTxtNotes();
            displayNotes();
            if (notes.length > 0) {
                const lastActiveNoteId = localStorage.getItem('lastActiveNoteId');
                const noteToLoad = notes.find(note => note.id === lastActiveNoteId) || notes[0];
                if (noteToLoad) {
                    selectNote(noteToLoad.id);
                } else {
                     clearNoteEditor(); // If no note found (e.g. last active was deleted)
                }
            } else {
                clearNoteEditor();
            }
        } catch (error) {
            console.error('加载笔记失败:', error);
            // Consider a more user-friendly error display than alert
            // alert('加载笔记失败。请检查控制台获取更多信息。');
            showButtonFeedback(saveNoteBtn, "保存", "加载失败", false, 3000); // Example feedback
        }
    }

    // Function to display notes in the sidebar
    function displayNotes(filter = '') {
        noteList.innerHTML = '';
        const filteredNotes = notes.filter(note =>
            (note.title && note.title.toLowerCase().includes(filter.toLowerCase())) ||
            (note.content && note.content.toLowerCase().includes(filter.toLowerCase()))
        ).sort((a, b) => b.timestamp - a.timestamp); // Sort by most recent

        filteredNotes.forEach(note => {
            const listItem = document.createElement('li');
            listItem.dataset.id = note.id;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'note-title-display';
            titleSpan.textContent = note.title || '无标题笔记';

            const timeSpan = document.createElement('span');
            timeSpan.className = 'note-timestamp-display';
            const date = new Date(note.timestamp);
            timeSpan.textContent = date.toLocaleString('zh-CN', {
                // year: '2-digit', // Shorter year
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            listItem.appendChild(titleSpan);
            listItem.appendChild(timeSpan);

            if (note.id === activeNoteId) {
                listItem.classList.add('active');
            }
            listItem.addEventListener('click', () => selectNote(note.id));
            noteList.appendChild(listItem);
        });
    }

    // Function to select and display a note
    async function selectNote(id) {
        activeNoteId = id;
        localStorage.setItem('lastActiveNoteId', id);

        document.querySelectorAll('#noteList li').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.id === id) {
                item.classList.add('active');
            }
        });

        const note = notes.find(n => n.id === id);
        if (note) {
            noteTitleInput.value = note.title;
            noteContentInput.value = note.content;
            renderMarkdown(note.content);
            noteContentInput.style.display = 'block';
            previewContentDiv.style.display = 'block';
            editorBubble.style.display = 'block';
            previewBubble.style.display = 'block';
            // noteContentInput.focus(); // Avoid focus stealing on load
        } else {
            clearNoteEditor(); // If note not found
        }
    }

    // Function to clear the note editor
    function clearNoteEditor() {
        activeNoteId = null;
        localStorage.removeItem('lastActiveNoteId');
        noteTitleInput.value = '';
        noteContentInput.value = '';
        previewContentDiv.innerHTML = '';
        // By default, show editor and hide preview for a new, empty note
        noteContentInput.style.display = 'block';
        previewContentDiv.style.display = 'block'; // Keep preview visible or hide as preferred
        editorBubble.style.display = 'block';
        previewBubble.style.display = 'block'; // Keep preview bubble visible
        document.querySelectorAll('#noteList li').forEach(item => item.classList.remove('active'));
        noteTitleInput.focus();
    }

    // Event listener for new note button
    newNoteBtn.addEventListener('click', () => {
        clearNoteEditor();
    });
 
    // Core function to save the current note
    async function saveCurrentNote(isAutoSave = false) {
        const title = noteTitleInput.value.trim();
        const content = noteContentInput.value;

        // For new notes, if title and content are empty, don't save, especially for auto-save.
        if (!activeNoteId && !title && !content.trim()) {
            if (isAutoSave) {
                // console.log('自动保存：新笔记内容为空，不保存。');
                return;
            }
            showButtonFeedback(saveNoteBtn, '保存', '内容为空', false);
            return;
        }

        let noteToSave;
        const currentTimestamp = Date.now();

        if (activeNoteId) {
            noteToSave = notes.find(n => n.id === activeNoteId);
            if (noteToSave) {
                // Check if content actually changed to avoid unnecessary saves
                const normalizedTitle = title || '无标题笔记';
                if (noteToSave.title === normalizedTitle && noteToSave.content === content) {
                    if (isAutoSave) {
                        // console.log('自动保存：内容未更改。');
                        // Optionally provide subtle feedback that content is up-to-date
                        if (saveNoteBtn.textContent !== '已保存' && saveNoteBtn.textContent !== '自动保存成功' && saveNoteBtn.textContent !== '保存失败' && !saveNoteBtn.disabled) {
                            const originalText = saveNoteBtn.textContent;
                            saveNoteBtn.textContent = '已是最新';
                            setTimeout(() => {
                                if (saveNoteBtn.textContent === '已是最新' && !saveNoteBtn.disabled) saveNoteBtn.textContent = originalText;
                            }, 1000);
                        }
                        return;
                    }
                }
                noteToSave.oldFileName = noteToSave.fileName; // Add oldFileName from existing fileName
                noteToSave.title = normalizedTitle;
                noteToSave.content = content;
                noteToSave.timestamp = currentTimestamp;
                if (!noteToSave.username) { // Ensure username exists, e.g., if loaded from older format
                    noteToSave.username = 'defaultUser';
                }
            } else {
                activeNoteId = null; // Note was lost, treat as new if user continues typing
            }
        }
        
        if (!activeNoteId) { // Create new note if not updating an existing one
            // This check is slightly redundant due to the one at the beginning, but ensures no fully empty new note is created.
            if (!title && !content.trim()) {
                if (isAutoSave) return;
            }
            noteToSave = {
                id: currentTimestamp.toString(),
                title: title || '无标题笔记',
                content: content,
                timestamp: currentTimestamp,
                username: 'defaultUser', // Added username for new notes
                oldFileName: null // No old file for new notes, explicitly pass null
            };
            notes.push(noteToSave);
            // activeNoteId will be set by selectNote after loadNotes
        }

        if (!noteToSave) { // Should not happen if logic is correct
            console.error('保存逻辑错误：noteToSave 未定义。');
            if (isAutoSave) return;
            showButtonFeedback(saveNoteBtn, '保存', '保存出错', false);
            return;
        }

        try {
            await window.electronAPI.writeTxtNote(noteToSave); // Changed to writeTxtNote and pass single note
            if (isAutoSave && activeNoteId) { // If it's an auto-save for an existing note
                // Only update the display of notes, don't reload all or re-select
                displayNotes(searchInput.value); // Re-display with current filter
                // Ensure the active note's class is still applied if it was updated
                const activeListItem = document.querySelector(`#noteList li[data-id="${activeNoteId}"]`);
                if (activeListItem) {
                    activeListItem.classList.add('active');
                }
            } else { // Manual save or auto-save for a new note
                const currentActiveId = noteToSave.id; // Store before loadNotes might change things
                await loadNotes(); // Reloads and re-renders the note list
                selectNote(currentActiveId); // Re-select the current note
            }

            if (isAutoSave) {
                // console.log('笔记已自动保存:', noteToSave.id);
                if (saveNoteBtn.textContent !== '已保存' && saveNoteBtn.textContent !== '保存失败' && !saveNoteBtn.disabled) {
                    const originalText = saveNoteBtn.textContent;
                    saveNoteBtn.textContent = '自动保存 ✓';
                    setTimeout(() => {
                        if (saveNoteBtn.textContent === '自动保存 ✓' && !saveNoteBtn.disabled) saveNoteBtn.textContent = '保存'; // Or originalText
                    }, 1500);
                }
            } else {
                showButtonFeedback(saveNoteBtn, '保存', '已保存', true);
            }
        } catch (error) {
console.error('保存笔记失败:', error, '笔记数据:', noteToSave); // Added noteToSave to log
            if (isAutoSave) {
                console.error('自动保存失败:', error, '笔记数据:', noteToSave); // Added noteToSave to log
                if (saveNoteBtn.textContent !== '保存失败' && !saveNoteBtn.disabled) {
                    const originalText = saveNoteBtn.textContent;
                    saveNoteBtn.textContent = '自动保存失败';
                    saveNoteBtn.style.backgroundColor = 'var(--error-color, #F44336)';
                    saveNoteBtn.style.borderColor = 'var(--error-color, #F44336)';
                    saveNoteBtn.style.color = 'white';
                    setTimeout(() => {
                        if (saveNoteBtn.textContent === '自动保存失败' && !saveNoteBtn.disabled) {
                            saveNoteBtn.textContent = '保存'; // Or originalText
                            saveNoteBtn.style.backgroundColor = '';
                            saveNoteBtn.style.color = '';
                        }
                    }, 2000);
                }
            } else {
                showButtonFeedback(saveNoteBtn, '保存', '保存失败', false);
            }
        }
    }

    // Debounced version of saveCurrentNote for auto-saving
    const debouncedSaveNote = debounce(() => saveCurrentNote(true), 1500); // 1.5 seconds delay

    // Event listener for manual saving a note
    saveNoteBtn.addEventListener('click', async () => {
        await saveCurrentNote(false); // false indicates manual save
    });

    // Event listener for deleting a note
    deleteNoteBtn.addEventListener('click', async () => {
        if (!activeNoteId) {
            showButtonFeedback(deleteNoteBtn, '删除', '请选择笔记', false);
            return;
        }

        if (deleteTimer) {
            clearTimeout(deleteTimer);
            deleteTimer = null;
            
            const noteToDelete = notes.find(n => n.id === activeNoteId);
            if (!noteToDelete) {
                showButtonFeedback(deleteNoteBtn, '删除', '笔记未找到', false);
                return;
            }

            try {
                await window.electronAPI.deleteTxtNote(noteToDelete.fileName);
                notes = notes.filter(n => n.id !== activeNoteId);
                await loadNotes();
                clearNoteEditor();
                showButtonFeedback(deleteNoteBtn, '删除', '已删除', true);
            } catch (error) {
                console.error('删除笔记失败:', error);
                showButtonFeedback(deleteNoteBtn, '删除', '删除失败', false);
            }
        } else {
            deleteNoteBtn.textContent = '确认删除';
            deleteNoteBtn.style.backgroundColor = 'var(--button-danger-hover-bg-color)';
            deleteNoteBtn.style.borderColor = 'var(--button-danger-hover-bg-color)';
            deleteTimer = setTimeout(() => {
                deleteNoteBtn.textContent = '删除';
                deleteNoteBtn.style.backgroundColor = ''; 
                deleteNoteBtn.style.borderColor = ''; 
                deleteTimer = null;
            }, 3000); 
        }
    });

    // Event listener for search input
    searchInput.addEventListener('input', (e) => {
        displayNotes(e.target.value);
    });

    // Live Markdown preview
    noteTitleInput.addEventListener('input', () => {
        debouncedSaveNote();
    });

    noteContentInput.addEventListener('input', (e) => {
        console.log('[Input Event] noteContentInput.value before renderMarkdown:', JSON.stringify(e.target.value)); // Log the value
        renderMarkdown(e.target.value); // Existing live preview
        debouncedSaveNote(); // Trigger debounced auto-save
    });

    // Event listener for pasting content into noteContentInput
    noteContentInput.addEventListener('paste', async (event) => {
        const items = event.clipboardData.items;
        let imageFound = false;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                event.preventDefault(); // Prevent default paste behavior for images
                imageFound = true;

                if (!activeNoteId) {
                    // If no active note, create a new one first before saving image
                    // This is a simplified approach; ideally, user would explicitly create a new note
                    // or we'd auto-create a "temp" note for the image.
                    alert('请先选择或创建一篇笔记，再粘贴图片。');
                    console.warn('Attempted to paste image without an active note.');
                    return;
                }

                const file = item.getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const base64Data = e.target.result.split(',')[1]; // Get base64 part
                        const extension = file.type.split('/')[1] || 'png'; // e.g., 'png', 'jpeg'

                        try {
                            const result = await window.electronAPI.savePastedImageToFile({
                                data: base64Data,
                                extension: extension
                            }, activeNoteId); // Pass activeNoteId for organization

                            if (result.success && result.attachment) {
                                let imagePath = result.attachment.internalPath; // Expected format: file://C:\path\to\image.png or file:///path/image.png

                                if (imagePath.startsWith('file://')) {
                                    imagePath = imagePath.substring(7); // Remove file:// -> C:\path\to\image.png or /path/image.png
                                }
                                
                                // Replace all backslashes with forward slashes
                                imagePath = imagePath.replace(/\\/g, '/'); // -> C:/path/to/image.png or /path/image.png
                                
                                // Construct the final URL with file:///
                                // This ensures correct format like file:///C:/path/image.png or file:///path/image.png
                                const imageUrl = `file:///${imagePath}`;
                                const markdownLink = `![pasted_image](${imageUrl})`;

                                // Insert markdownLink at current cursor position
                                const start = noteContentInput.selectionStart;
                                const end = noteContentInput.selectionEnd;
                                const currentValue = noteContentInput.value;

                                noteContentInput.value = currentValue.substring(0, start) + markdownLink + currentValue.substring(end);
                                
                                // Move cursor after the inserted link
                                noteContentInput.selectionStart = noteContentInput.selectionEnd = start + markdownLink.length;

                                // Trigger input event manually to update preview and auto-save
                                noteContentInput.dispatchEvent(new Event('input', { bubbles: true }));
                                console.log('Pasted image saved and Markdown link inserted:', markdownLink);
                            } else {
                                console.error('Failed to save pasted image:', result.error);
                                alert('保存粘贴图片失败: ' + (result.error || '未知错误'));
                            }
                        } catch (error) {
                            console.error('Error during image paste process:', error);
                            alert('处理粘贴图片时发生错误: ' + error.message);
                        }
                    };
                    reader.readAsDataURL(file);
                }
                break; // Only process the first image found
            }
        }

        if (!imageFound) {
            // If no image found, allow default paste behavior for text
            // No need to do anything, default behavior will proceed
        }
    });

    // Initial load of notes
    loadNotes();

    // --- Custom Context Menu Logic ---
    let contextMenuTargetElement = null; // To keep track of which element triggered the context menu

    function updateContextMenuState(target) {
        const selection = window.getSelection();
        // FIX: Do not trim the selected text here. Any selection should enable copy/cut.
        const selectedText = selection.toString(); 
        const isInputOrTextarea = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        // const isPreview = previewContentDiv.contains(target) || target === previewContentDiv; // Not strictly needed for this logic

        contextMenuCopy.classList.toggle('disabled', !selectedText);
        contextMenuCut.classList.toggle('disabled', !selectedText || !isInputOrTextarea);
        
        navigator.clipboard.readText()
            .then(clipboardText => {
                contextMenuPaste.classList.toggle('disabled', !isInputOrTextarea || !clipboardText);
            })
            .catch(() => { // If clipboard is empty or permission denied
                contextMenuPaste.classList.add('disabled');
            });
    }


    function showContextMenu(x, y, target) {
        contextMenuTargetElement = target;
        customContextMenu.style.left = `${x}px`;
        customContextMenu.style.top = `${y}px`;
        customContextMenu.style.display = 'block';
        updateContextMenuState(target);
    }

    function hideContextMenu() {
        customContextMenu.style.display = 'none';
        contextMenuTargetElement = null;
    }

    document.addEventListener('contextmenu', (e) => {
        const target = e.target;
        if (target === noteTitleInput || target === noteContentInput || previewContentDiv.contains(target)) {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, target);
        } else {
            hideContextMenu();
        }
    });

    document.addEventListener('click', (e) => {
        if (!customContextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    contextMenuCopy.addEventListener('click', () => {
        if (contextMenuCopy.classList.contains('disabled') || !contextMenuTargetElement) return;
        
        let textToCopy = '';
        const target = contextMenuTargetElement;

        if ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && typeof target.selectionStart === 'number' && typeof target.selectionEnd === 'number') {
            textToCopy = target.value.substring(target.selectionStart, target.selectionEnd);
        } else {
            const selection = window.getSelection();
            if (selection) {
                textToCopy = selection.toString();
            }
        }

        if (textToCopy) { // 只有在确实有文本时才执行复制
            navigator.clipboard.writeText(textToCopy).catch(err => console.error('复制失败:', err));
        }
        hideContextMenu();
    });

    contextMenuCut.addEventListener('click', () => {
        if (contextMenuCut.classList.contains('disabled') || !contextMenuTargetElement) return;
        
        const target = contextMenuTargetElement;
        if ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && typeof target.selectionStart === 'number' && typeof target.selectionEnd === 'number') {
            const textToCut = target.value.substring(target.selectionStart, target.selectionEnd);
            
            if (textToCut) { // 只有在确实有文本时才执行剪切
                navigator.clipboard.writeText(textToCut)
                    .then(() => {
                        const start = target.selectionStart;
                        const end = target.selectionEnd;
                        target.value = target.value.substring(0, start) + target.value.substring(end);
                        target.setSelectionRange(start, start); // Move cursor to cut position
                        target.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input for live preview
                    })
                    .catch(err => console.error('剪切失败 (复制部分):', err));
            }
        }
        hideContextMenu();
    });

    contextMenuPaste.addEventListener('click', async () => {
        if (contextMenuPaste.classList.contains('disabled') || !contextMenuTargetElement) return;

        const target = contextMenuTargetElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
            try {
                const textToPaste = await navigator.clipboard.readText();
                if (textToPaste) {
                    const start = target.selectionStart;
                    const end = target.selectionEnd;
                    target.value = target.value.substring(0, start) + textToPaste + target.value.substring(end);
                    target.selectionStart = target.selectionEnd = start + textToPaste.length;
                    target.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input for live preview
                }
            } catch (err) {
                console.error('粘贴失败:', err);
            }
        }
        hideContextMenu();
    });
});
