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


    let notes = []; // Stores all notes
    let activeNoteId = null; // Stores the ID of the currently active note
    let deleteTimer = null; // Timer for two-step delete confirmation
    let autoSaveTimer = null; // Timer for debounced auto-save
    let currentUsername = 'defaultUser'; // Initialize with a fallback default
    let draggedElement = null; // Used to store the element being dragged

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
        const feedbackClass = isSuccess ? 'button-success' : 'button-error';
        
        button.textContent = feedbackText;
        button.classList.add(feedbackClass);
        button.disabled = true;

        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove(feedbackClass);
            button.disabled = false;
            // Force style re-evaluation by blurring the element after feedback.
            button.blur();
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

    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Notes App] Theme updated to: ${theme}`);
        applyTheme(theme);
    });

    // Load username from settings
    try {
        const settings = await window.electronAPI.loadSettings();
        if (settings && settings.userName) {
            currentUsername = settings.userName;
            console.log('从设置加载用户名:', currentUsername);
        } else {
            console.warn('设置中未找到用户名，使用默认值:', currentUsername);
        }
    } catch (error) {
        console.error('加载设置中的用户名失败:', error);
    }

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
    async function loadNotes(isHandlingShare = false) {
        try {
            if (!window.electronAPI || !window.electronAPI.readTxtNotes) {
                console.error('electronAPI.readTxtNotes 不可用。');
                notes = [];
                displayNotes();
                if (!isHandlingShare) clearNoteEditor();
                return;
            }
            const loadedNotesResult = await window.electronAPI.readTxtNotes();
            if (loadedNotesResult.error) {
                console.error('加载笔记失败 (API返回错误):', loadedNotesResult.error);
                notes = [];
                displayNotes();
                if (!isHandlingShare) clearNoteEditor();
                return;
            }
            notes = loadedNotesResult;
            displayNotes();

            if (!isHandlingShare && notes.length > 0) {
                const lastActiveNoteId = localStorage.getItem('lastActiveNoteId');
                const noteToLoad = notes.find(note => note.id === lastActiveNoteId) || notes[0];
                if (noteToLoad) {
                    selectNote(noteToLoad.id);
                } else if (notes.length > 0) { // Fallback to first note if lastActiveNoteId is invalid
                    selectNote(notes[0].id);
                } else {
                    clearNoteEditor();
                }
            } else if (!isHandlingShare && notes.length === 0) {
                clearNoteEditor();
            }
            // If isHandlingShare is true, do not auto-select a note here.
            // The shared content will be populated by the calling function.
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
        // Filter notes based on the search input
        const notesToDisplay = notes.filter(note =>
            (note.title && note.title.toLowerCase().includes(filter.toLowerCase())) ||
            (note.content && note.content.toLowerCase().includes(filter.toLowerCase()))
        );
        // The order of notesToDisplay will reflect the order in the `notes` array,
        // which will be modified by drag and drop.

        notesToDisplay.forEach(note => {
            const listItem = document.createElement('li');
            listItem.dataset.id = note.id;
            listItem.setAttribute('draggable', true); // Make the list item draggable

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

            // Add drag and drop event listeners
            listItem.addEventListener('dragstart', handleDragStart);
            listItem.addEventListener('dragover', handleDragOver);
            listItem.addEventListener('dragleave', handleDragLeave);
            listItem.addEventListener('drop', handleDrop);
            listItem.addEventListener('dragend', handleDragEnd);

            noteList.appendChild(listItem);
        });
    }

    // Drag and Drop Handlers
    function handleDragStart(e) {
        draggedElement = this; // 'this' is the source li element
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.dataset.id); // Store the id of the note being dragged
        this.classList.add('dragging'); // Add a class to style the dragged item
    }

    function handleDragOver(e) {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = 'move';
        if (this !== draggedElement) {
            this.classList.add('drag-over-target'); // Add class to highlight potential drop target
        }
        return false;
    }

    function handleDragLeave(e) {
        this.classList.remove('drag-over-target'); // Remove highlight when dragging away
    }

    function handleDrop(e) {
        e.stopPropagation();
        e.preventDefault();
        this.classList.remove('drag-over-target');

        if (draggedElement && draggedElement !== this) {
            const sourceNoteId = e.dataTransfer.getData('text/plain');
            const targetNoteId = this.dataset.id;

            let sourceIndex = notes.findIndex(note => note && note.id === sourceNoteId);
            let originalTargetIndex = notes.findIndex(note => note && note.id === targetNoteId);

            if (sourceIndex === -1 || originalTargetIndex === -1) {
                console.error('Source or target note not found in notes array during drop.', { sourceNoteId, targetNoteId, sourceIndex, originalTargetIndex });
                if (draggedElement) draggedElement.classList.remove('dragging');
                draggedElement = null;
                return false;
            }
            
            // Ensure draggedNote is valid before splicing
            if (!notes[sourceIndex]) {
                console.error('Invalid draggedNote at sourceIndex:', sourceIndex, 'notes:', notes);
                if (draggedElement) draggedElement.classList.remove('dragging');
                draggedElement = null;
                return false;
            }

            const [draggedNoteObject] = notes.splice(sourceIndex, 1);
            
            if (!draggedNoteObject) {
                 console.error('draggedNoteObject is undefined after splice. SourceIndex:', sourceIndex);
                 // Attempt to re-fetch notes to recover state, or simply log and prevent further error
                 if (draggedElement) draggedElement.classList.remove('dragging');
                 draggedElement = null;
                 // Potentially call loadNotes() here if state is critical, or just display error
                 return false;
            }


            // After removing the source, the target's index might have shifted if source was before it.
            let currentTargetIndexAfterSplice = notes.findIndex(note => note && note.id === targetNoteId);

            const rect = this.getBoundingClientRect();
            const verticalMidpoint = rect.top + rect.height / 2;

            if (currentTargetIndexAfterSplice !== -1) {
                if (e.clientY < verticalMidpoint) {
                    notes.splice(currentTargetIndexAfterSplice, 0, draggedNoteObject);
                } else {
                    notes.splice(currentTargetIndexAfterSplice + 1, 0, draggedNoteObject);
                }
            } else {
                // This case means the target element was the one just before the source,
                // and after source was removed, the original target is now at the end of the list
                // or the list became empty.
                // A simpler logic: if the original target was at an index `k`, and source was at `j`.
                // If j < k, new target index is k-1. If j > k, new target index is k.
                // We are inserting relative to the DOM element `this`.
                // If the target element is `this`, and it's still in the DOM,
                // we can find its new position in the `notes` array (which should match DOM order after filtering).
                // The most robust way if `currentTargetIndexAfterSplice` is -1 (which means targetNoteId is no longer in notes array after splice,
                // which should only happen if targetNoteId was the same as sourceNoteId, but this is prevented by `draggedElement !== this`)
                // is to determine insertion based on the DOM position of `this` relative to other elements.
                // However, since `displayNotes` re-renders from `notes` array, we must ensure `notes` array is correct.

                // If targetIndex was -1, it means the targetNoteId is no longer in the `notes` array.
                // This should not happen if `draggedElement !== this`.
                // As a fallback, if `sourceIndex < originalTargetIndex` (meaning source was before target),
                // we insert at `originalTargetIndex - 1`. Otherwise, at `originalTargetIndex`.
                // This logic needs to be careful if `originalTargetIndex` was 0.
                
                let insertionPoint = -1;
                if (sourceIndex < originalTargetIndex) { // Source was before target
                    insertionPoint = originalTargetIndex -1;
                } else { // Source was after target
                    insertionPoint = originalTargetIndex;
                }

                // Adjust insertion point if it's out of bounds after splice
                if (insertionPoint < 0) insertionPoint = 0;
                if (insertionPoint > notes.length) insertionPoint = notes.length;


                if (e.clientY < verticalMidpoint) {
                     notes.splice(insertionPoint, 0, draggedNoteObject);
                } else {
                    // If inserting "after" the target, and target was the last element,
                    // the insertion point might need to be notes.length
                    if (insertionPoint === notes.length -1 && e.clientY >= verticalMidpoint) {
                         notes.push(draggedNoteObject);
                    } else {
                         notes.splice(insertionPoint + 1, 0, draggedNoteObject);
                    }
                }
            }

            // Persist the new order (e.g., to localStorage or backend)
            // For now, we just update the in-memory `notes` array.
            // If you have a backend or persistent storage for note order, call it here.
            // Example: await saveNoteOrderToBackend(notes.map(note => note.id));

            const currentFilter = searchInput.value;
            displayNotes(currentFilter); // Re-render the list
        }
        if (draggedElement) { // Ensure draggedElement is cleared even if no drop happened on a valid target
             draggedElement.classList.remove('dragging');
        }
        draggedElement = null; // Clear in all cases after drop attempt
        return false;
    }
    
    function handleDragEnd(e) {
        this.classList.remove('dragging');
        // Clean up any drag-over-target classes that might be lingering
        document.querySelectorAll('#noteList li.drag-over-target').forEach(item => {
            item.classList.remove('drag-over-target');
        });
        draggedElement = null;
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
        
        function sanitizeForFileName(name, defaultName = 'untitled') {
            if (typeof name !== 'string' || name.trim() === '') return defaultName;
            // 替换文件名中的非法字符为下划线
            let sanitized = name.replace(/[\\/:*?"<>|]/g, '_');
            // 将多个连续的下划线替换为单个下划线
            sanitized = sanitized.replace(/__+/g, '_');
            // 移除可能导致问题的首尾下划线或点
            sanitized = sanitized.replace(/^[_.]+|[_.]+$/g, '');
            // 如果清理后为空，或者只剩下点，则返回默认名
            if (sanitized.trim() === '' || sanitized.trim() === '.' || sanitized.trim() === '..') {
                return defaultName;
            }
            // 限制文件名组件的长度 (可选)
            // const maxLength = 50;
            // return sanitized.substring(0, maxLength);
            return sanitized;
        }

        const rawTitle = noteTitleInput.value.trim();
        const title = sanitizeForFileName(rawTitle, '无标题笔记'); // 清理标题用于保存和文件名
        const content = noteContentInput.value;

        // For new notes, if title (sanitized) and content are empty, don't save for auto-save.
        // For manual saves or shared content, allow saving even if empty to create a placeholder.
        if (!activeNoteId && !title && !content.trim() && isAutoSave) {
            // console.log('自动保存：新笔记内容为空，不保存。');
            return;
        }

        // If it's a manual save or shared content and empty, provide feedback but still proceed to create a note.
        if (!activeNoteId && !title && !content.trim() && !isAutoSave) {
            showButtonFeedback(saveNoteBtn, '保存', '创建空笔记', true, 1000); // Provide feedback but allow creation
        }

        let noteToSave;
        const currentTimestamp = Date.now();

        if (activeNoteId) {
            noteToSave = notes.find(n => n.id === activeNoteId);
            if (noteToSave) {
                // Check if content actually changed to avoid unnecessary saves
                // 使用清理后的 title 进行比较
                if (noteToSave.title === title && noteToSave.content === content) {
                    if (isAutoSave) {
                        // console.log('自动保存：内容未更改。');
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
                noteToSave.oldFileName = noteToSave.fileName;
                noteToSave.title = title; // 使用清理后的 title
                noteToSave.content = content;
                noteToSave.timestamp = currentTimestamp;
                // Ensure username is always the current one from settings
                noteToSave.username = currentUsername;
            } else {
                activeNoteId = null; // Note was lost, treat as new if user continues typing
            }
        }
        
        if (!activeNoteId) { // Create new note if not updating an existing one
            noteToSave = {
                id: currentTimestamp.toString(), // Assign a new ID for the new note
                title: title || '无标题笔记',
                content: content,
                timestamp: currentTimestamp,
                username: currentUsername,
                oldFileName: null
            };
            notes.push(noteToSave);
            // activeNoteId will be set by selectNote after loadNotes, ensuring it's correctly managed
        }

        if (!noteToSave) { // Should not happen if logic is correct
            console.error('保存逻辑错误：noteToSave 未定义。');
            if (isAutoSave) return;
            showButtonFeedback(saveNoteBtn, '保存', '保存出错', false);
            return;
        }

        try {
            const saveResult = await window.electronAPI.writeTxtNote(noteToSave); // Changed to writeTxtNote and pass single note

            if (!saveResult || saveResult.error) {
                console.error('保存笔记失败，主进程返回错误:', saveResult ? saveResult.error : '未知错误');
                const errorMessage = saveResult && saveResult.error ? saveResult.error : '保存时发生未知错误';
                if (isAutoSave) {
                    if (saveNoteBtn.textContent !== '保存失败' && !saveNoteBtn.disabled) {
                        const originalText = saveNoteBtn.textContent;
                        saveNoteBtn.textContent = '自动保存失败';
                        saveNoteBtn.style.backgroundColor = 'var(--error-color, #F44336)';
                        saveNoteBtn.style.borderColor = 'var(--error-color, #F44336)';
                        saveNoteBtn.style.color = 'white';
                        setTimeout(() => {
                            if (saveNoteBtn.textContent === '自动保存失败' && !saveNoteBtn.disabled) {
                                saveNoteBtn.textContent = '保存';
                                saveNoteBtn.style.backgroundColor = '';
                                saveNoteBtn.style.color = '';
                                saveNoteBtn.style.borderColor = '';
                            }
                        }, 2000);
                    }
                } else {
                    showButtonFeedback(saveNoteBtn, '保存', `保存失败: ${errorMessage}`, false);
                }
                return; // 保存失败，提前返回
            }
            
            const newNoteFileName = saveResult.fileName;
            const idForSelection = newNoteFileName.replace(/\.txt$/, '');

            // 统一调用 loadNotes 和 selectNote 来保证数据一致性
            await loadNotes();
            selectNote(idForSelection); // 使用从新文件名派生的ID重新选择笔记

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
            console.error('保存笔记过程中发生异常:', error, '笔记数据:', noteToSave);
            const displayError = error.message || '保存时发生未知异常';
            if (isAutoSave) {
                console.error('自动保存失败 (异常):', error, '笔记数据:', noteToSave);
                 if (saveNoteBtn.textContent !== '保存失败' && !saveNoteBtn.disabled) {
                    const originalText = saveNoteBtn.textContent;
                    saveNoteBtn.textContent = '自动保存失败!';
                    saveNoteBtn.style.backgroundColor = 'var(--error-color, #F44336)';
                    saveNoteBtn.style.borderColor = 'var(--error-color, #F44336)';
                    saveNoteBtn.style.color = 'white';
                    setTimeout(() => {
                        if (saveNoteBtn.textContent === '自动保存失败!' && !saveNoteBtn.disabled) {
                            saveNoteBtn.textContent = '保存';
                            saveNoteBtn.style.backgroundColor = '';
                            saveNoteBtn.style.color = '';
                            saveNoteBtn.style.borderColor = '';
                        }
                    }, 2000);
                }
            } else {
                showButtonFeedback(saveNoteBtn, '保存', `保存失败: ${displayError}`, false);
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
            deleteNoteBtn.classList.remove('button-confirm-delete');
            
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
                showButtonFeedback(deleteNoteBtn, '删除', '已删除', true, 600);
            } catch (error) {
                console.error('删除笔记失败:', error);
                showButtonFeedback(deleteNoteBtn, '删除', '删除失败', false);
            }
        } else {
            deleteNoteBtn.textContent = '确认删除';
            deleteNoteBtn.classList.add('button-confirm-delete');
            deleteTimer = setTimeout(() => {
                deleteNoteBtn.textContent = '删除';
                deleteNoteBtn.classList.remove('button-confirm-delete');
                deleteTimer = null;
                // Force style re-evaluation by blurring the element
                deleteNoteBtn.blur();
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

    async function initializeApp() {
        // Load username from settings first
        try {
            if (window.electronAPI && window.electronAPI.loadSettings) {
                const settings = await window.electronAPI.loadSettings();
                if (settings && settings.userName) {
                    currentUsername = settings.userName;
                    console.log('从设置加载用户名:', currentUsername);
                } else {
                    console.warn('设置中未找到用户名，使用默认值:', currentUsername);
                }
            } else {
                 console.warn('electronAPI.loadSettings 不可用。将使用默认用户名。');
            }
        } catch (error) {
            console.error('加载用户设置失败:', error);
        }

        // Initial theme application
        applyTheme();

        const params = new URLSearchParams(window.location.search);
        const action = params.get('action');
        let isHandlingShare = false;

        if (action === 'newFromShare') {
            isHandlingShare = true;
        }

        await loadNotes(isHandlingShare); // Pass the flag to loadNotes

        if (isHandlingShare) {
            const sharedTitleParam = params.get('title');
            const sharedContentParam = params.get('content');

            // Check if at least title or content is present in params for a share action
            if (params.has('title') || params.has('content')) {
                console.log('[Notes App] Handling shared content. URL Title:', sharedTitleParam, 'URL Content Length:', sharedContentParam ? sharedContentParam.length : 0);
                clearNoteEditor(); // Clear current editor to prepare for new shared note
                
                noteTitleInput.value = decodeURIComponent(sharedTitleParam || '来自分享的笔记');
                noteContentInput.value = decodeURIComponent(sharedContentParam || '');
                renderMarkdown(noteContentInput.value); // Render preview of shared content
                
                // Prompt user to save, do not save automatically
                showButtonFeedback(saveNoteBtn, "保存", "已载入分享, 请保存", true, 600);
                
                // Clear the URL parameters to prevent re-creating the note on refresh
                const newUrl = new URL(window.location.pathname, window.location.origin); // Create clean URL without query params
                if(window.location.hash) newUrl.hash = window.location.hash; // Preserve hash if present
                window.history.replaceState({}, document.title, newUrl.toString());
                console.log('[Notes App] Shared content loaded into editor and URL cleaned.');
            } else {
                console.warn('[Notes App] "newFromShare" action without title or content parameters.');
                // If action is newFromShare but no content, loadNotes would have already cleared or selected a note.
                // If notes list is empty, clearNoteEditor is called by loadNotes.
                // If notes list is not empty, loadNotes would have selected the first/last active note.
            }
        }
        // If not isHandlingShare, loadNotes already handles selecting the last active/first note or clearing the editor.
    }

    await initializeApp();

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
