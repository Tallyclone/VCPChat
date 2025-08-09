document.addEventListener('DOMContentLoaded', () => {
    const editorTextarea = document.getElementById('editor');
    const historyList = document.getElementById('historyList');
    const newCanvasBtn = document.getElementById('newCanvasBtn');
    const filePathSpan = document.getElementById('filePath');
    const errorInfoSpan = document.getElementById('errorInfo');
    const minimizeBtn = document.getElementById('minimize-btn');
    const maximizeBtn = document.getElementById('maximize-btn');
    const closeBtn = document.getElementById('close-btn');
    const sidebar = document.querySelector('.sidebar');
    const resizer = document.getElementById('resizer');
    const contextMenu = document.getElementById('context-menu');
    const renameBtn = document.getElementById('rename-btn');
    const copyBtn = document.getElementById('copy-btn');
    const deleteBtn = document.getElementById('delete-btn');
    const runPyBtn = document.getElementById('run-py-btn');
    const renderMdBtn = document.getElementById('render-md-btn');
    const renderHtmlBtn = document.getElementById('render-html-btn');
    const toggleWrapBtn = document.getElementById('toggle-wrap-btn');

    let editor;
    const editorContextMenu = document.getElementById('editor-context-menu');

    // --- CodeMirror 5 Initialization ---
    function initializeEditor(initialData) {
        if (editor) {
            // If editor exists, just update its content
            if (initialData.current) {
                editor.setValue(initialData.current.content);
                filePathSpan.textContent = initialData.current.path;
                // Update syntax highlighting for the new content's file type
                if (editor) {
                    const mode = getModeForFilePath(initialData.current.path);
                    editor.setOption('mode', mode);
                    updateTopBarButtons(initialData.current.path);
                }
            }
            if (initialData.history) {
                updateHistoryList(initialData.history);
            }
            return;
        }

        editor = CodeMirror.fromTextArea(editorTextarea, {
            lineNumbers: true,
            mode: 'javascript',
            theme: 'material-darker',
            lineWrapping: false,
            continueComments: "Enter",
        });

        // --- Event Listeners (only bind once) ---

        // Auto-save on content change
        let debounceTimer;
        editor.on('change', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const content = editor.getValue();
                const path = filePathSpan.textContent;
                if (path !== '未保存' && window.electronAPI) {
                    window.electronAPI.saveCanvasFile({ path, content });
                }
            }, 2000); // Increased delay to reduce saves during continuous typing
        });

        // Editor Context Menu
        editor.on('contextmenu', (cm, e) => {
            e.preventDefault();
            const selection = cm.getSelection();
            editorContextMenu.querySelector('[data-action="cut"]').disabled = !selection;
            editorContextMenu.querySelector('[data-action="copy"]').disabled = !selection;
            navigator.clipboard.readText().then(text => {
                editorContextMenu.querySelector('[data-action="paste"]').disabled = !text;
            }).catch(() => {
                editorContextMenu.querySelector('[data-action="paste"]').disabled = true;
            });
            const history = cm.historySize();
            editorContextMenu.querySelector('[data-action="undo"]').disabled = history.undo === 0;
            editorContextMenu.querySelector('[data-action="redo"]').disabled = history.redo === 0;
            editorContextMenu.style.top = `${e.clientY}px`;
            editorContextMenu.style.left = `${e.clientX}px`;
            editorContextMenu.style.display = 'block';
        });

        if (initialData.current) {
            editor.setValue(initialData.current.content);
            filePathSpan.textContent = initialData.current.path;
            // Set initial syntax highlighting
            const mode = getModeForFilePath(initialData.current.path);
            editor.setOption('mode', mode);
            updateTopBarButtons(initialData.current.path);
        } else {
            editor.setValue('// Welcome to Canvas with CodeMirror 5!');
        }

        if (initialData.history) {
            updateHistoryList(initialData.history);
        }

    }

    // --- Theme Handling ---
    function applyTheme(theme) {
        const currentTheme = theme || 'dark';
        document.body.classList.toggle('light-theme', currentTheme === 'light');
        if (editor) {
            editor.setOption('theme', currentTheme === 'light' ? 'default' : 'material-darker');
        }
    }

    // --- IPC Event Listeners ---
    if (window.electronAPI) {
        window.electronAPI.onThemeUpdated(applyTheme);

        window.electronAPI.onCanvasLoadData(async (data) => {
            initializeEditor(data);
            // After editor is initialized, get and apply the current theme
            try {
                const theme = await window.electronAPI.getCurrentTheme();
                applyTheme(theme);
            } catch (error) {
                console.error('Failed to get current theme on load:', error);
                applyTheme('dark'); // Fallback to dark theme
            }
        });

        window.electronAPI.onCanvasFileChanged((file) => {
            if (editor && editor.getValue() !== file.content) {
                editor.setValue(file.content);
                // Update syntax highlighting when file changes
                const mode = getModeForFilePath(file.path);
                editor.setOption('mode', mode);
                updateTopBarButtons(file.path);
            }
            filePathSpan.textContent = file.path;
        });

        // Listen for direct load commands from the main process
        window.electronAPI.onLoadCanvasFileByPath((filePath) => {
            if (window.electronAPI) {
                window.electronAPI.loadCanvasFile(filePath);
            }
        });
 
        // Inform main process that the window is ready to receive data
        window.electronAPI.canvasReady();
    }

    // --- UI Event Listeners ---
    newCanvasBtn.addEventListener('click', () => {
        if (window.electronAPI) {
            window.electronAPI.createNewCanvas();
        }
    });

    toggleWrapBtn.addEventListener('click', () => {
        if (editor) {
            const currentStatus = editor.getOption('lineWrapping');
            editor.setOption('lineWrapping', !currentStatus);
            toggleWrapBtn.textContent = `自动换行: ${!currentStatus ? '开' : '关'}`;
        }
    });

    historyList.addEventListener('click', (e) => {
        if (e.target && e.target.matches('li[data-path]')) {
            const filePath = e.target.dataset.path;
            if (window.electronAPI) {
                window.electronAPI.loadCanvasFile(filePath);
            }
        }
    });

    // --- Context Menu for History List ---
    let activeListItem = null;

    historyList.addEventListener('contextmenu', (e) => {
        const targetLi = e.target.closest('li[data-path]');
        if (targetLi) {
            e.preventDefault();
            activeListItem = targetLi;
            contextMenu.style.top = `${e.clientY}px`;
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.display = 'block';
        }
    });

    document.addEventListener('click', (e) => {
        // Close both context menus if clicked outside
        if (!contextMenu.contains(e.target)) {
            contextMenu.style.display = 'none';
            activeListItem = null;
        }
        if (!editorContextMenu.contains(e.target)) {
            editorContextMenu.style.display = 'none';
        }
    });

    editorContextMenu.addEventListener('click', (e) => {
        const action = e.target.closest('button')?.dataset.action;
        if (action && editor) {
            switch (action) {
                case 'undo': editor.undo(); break;
                case 'redo': editor.redo(); break;
                case 'cut':
                    const selection = editor.getSelection();
                    if (selection) {
                        navigator.clipboard.writeText(selection).then(() => {
                            editor.replaceSelection('');
                        });
                    }
                    break;
                case 'copy': document.execCommand('copy'); break;
                case 'paste':
                    navigator.clipboard.readText().then(text => {
                        editor.replaceSelection(text);
                    });
                    break;
                case 'selectAll': editor.execCommand('selectAll'); break;
            }
        }
        editorContextMenu.style.display = 'none';
    });

    renameBtn.addEventListener('click', () => {
        if (activeListItem) {
            enterRenameMode(activeListItem);
        }
        contextMenu.style.display = 'none';
    });

    copyBtn.addEventListener('click', () => {
        if (activeListItem && window.electronAPI) {
            const filePath = activeListItem.dataset.path;
            window.electronAPI.copyCanvasFile(filePath);
        }
        contextMenu.style.display = 'none';
    });

    deleteBtn.addEventListener('click', () => {
        if (activeListItem && window.electronAPI) {
            const filePath = activeListItem.dataset.path;
            // Add a confirmation dialog before deleting
            if (confirm(`确定要删除文件 "${window.electronPath.basename(filePath)}"? 这个操作无法撤销。`)) {
                window.electronAPI.deleteCanvasFile(filePath);
            }
        }
        contextMenu.style.display = 'none';
    });

    function enterRenameMode(li) {
        const originalTitle = li.textContent;
        li.innerHTML = ''; // Clear the list item

        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalTitle;
        input.className = 'rename-input';
        li.appendChild(input);
        input.focus();
        input.select();

        const finishRename = async () => {
            const newTitle = input.value.trim();
            const oldPath = li.dataset.path;

            if (newTitle && newTitle !== originalTitle) {
                if (window.electronAPI) {
                    try {
                        const newPath = await window.electronAPI.renameCanvasFile({ oldPath, newTitle });
                        li.textContent = newTitle;
                        li.dataset.path = newPath;
                        // If the renamed file is the active one, update the file path display
                        if (filePathSpan.textContent === oldPath) {
                            filePathSpan.textContent = newPath;
                        }
                    } catch (error) {
                        console.error('Rename failed:', error);
                        li.textContent = originalTitle; // Revert on failure
                    }
                }
            } else {
                li.textContent = originalTitle; // Revert if no change or empty
            }
        };

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            } else if (e.key === 'Escape') {
                li.textContent = originalTitle;
                input.removeEventListener('blur', finishRename); // Avoid double-revert
                input.blur();
            }
        });
    }

    if (minimizeBtn && maximizeBtn && closeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        });
        maximizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        });
        closeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.closeWindow();
        });
    }

    // --- Sidebar Resizing ---
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', () => {
            isResizing = false;
            document.removeEventListener('mousemove', handleMouseMove);
            // Refresh CodeMirror to adjust to the new size
            if (editor) {
                editor.refresh();
            }
        });
    });

    function handleMouseMove(e) {
        if (!isResizing) return;
        // The new width is simply the mouse's x position, since the sidebar is anchored to the left.
        const newWidth = e.clientX;
        const minWidth = parseInt(getComputedStyle(sidebar).minWidth, 10);
        const maxWidth = parseInt(getComputedStyle(sidebar).maxWidth, 10);

        if (newWidth >= minWidth && newWidth <= maxWidth) {
            sidebar.style.width = `${newWidth}px`;
        }
    }

    // --- Top Bar Button Logic ---
    function updateTopBarButtons(filePath) {
       const extension = filePath ? filePath.split('.').pop().toLowerCase() : '';
       runPyBtn.style.display = extension === 'py' ? 'block' : 'none';
       renderMdBtn.style.display = extension === 'md' ? 'block' : 'none';
       renderHtmlBtn.style.display = extension === 'html' ? 'block' : 'none';
    }

    runPyBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const code = editor.getValue();
           window.electronAPI.executePythonCode(code).then(({ stdout, stderr }) => {
               // For now, just log the output. A dedicated output panel would be better.
               console.log('Python stdout:', stdout);
               console.error('Python stderr:', stderr);
               alert('Python Output:\n' + (stdout || stderr));
           }).catch(err => {
               console.error('Python execution failed:', err);
               alert('Python execution failed:\n' + err);
           });
       }
    });

    renderMdBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const content = editor.getValue();
           window.electronAPI.openTextInNewWindow(content, 'Markdown Preview', 'dark');
       }
    });

    renderHtmlBtn.addEventListener('click', () => {
       if (editor && window.electronAPI) {
           const content = editor.getValue();
           // We can reuse the text viewer for HTML rendering as it supports iframes
           window.electronAPI.openTextInNewWindow(content, 'HTML Preview', 'dark');
       }
    });

    // --- Helper Functions ---
    function getModeForFilePath(filePath) {
        if (!filePath) {
           updateTopBarButtons('');
           return 'javascript'; // Default mode
        }
        const extension = filePath.split('.').pop().toLowerCase();
        switch (extension) {
            case 'js':
                return 'javascript';
            case 'py':
                return 'python';
            case 'css':
                return 'css';
            case 'html':
                return 'htmlmixed';
            case 'json':
                return 'application/json';
            case 'md':
                return 'markdown';
            case 'txt':
            default:
                return 'text/plain';
        }
    }

    function updateHistoryList(history) {
        historyList.innerHTML = '';
        history.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item.title;
            li.dataset.path = item.path;
            if (item.isActive) {
                li.classList.add('active');
            }
            historyList.appendChild(li);
        });
    }
});
