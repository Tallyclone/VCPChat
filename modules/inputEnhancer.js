// modules/inputEnhancer.js
console.log('[InputEnhancer] Module loaded.');

const LONG_TEXT_THRESHOLD = 2000; // Characters

// Removed: let electronAPI; - It will be assigned from refs and use the global window.electronAPI
let attachedFilesRef; // Reference to renderer.js's attachedFiles array
let updateAttachmentPreviewRef; // Reference to renderer.js's updateAttachmentPreview function
let currentAgentIdRef; // Function to get currentAgentId
let currentTopicIdRef; // Function to get currentTopicId

/**
 * Initializes the input enhancer module.
 * @param {object} refs - References to functions and variables from renderer.js
 * @param {HTMLTextAreaElement} refs.messageInput - The message input textarea element.
 * @param {object} refs.electronAPI - The exposed electron API from preload.js.
 * @param {Array} refs.attachedFiles - Reference to the array holding files to be attached.
 * @param {Function} refs.updateAttachmentPreview - Function to update the attachment preview UI.
 * @param {Function} refs.getCurrentAgentId - Function that returns the current agent ID.
 * @param {Function} refs.getCurrentTopicId - Function that returns the current topic ID.
 */
function initializeInputEnhancer(refs) {
    if (!refs.messageInput || !refs.electronAPI || !refs.attachedFiles || !refs.updateAttachmentPreview || !refs.getCurrentAgentId || !refs.getCurrentTopicId) {
        console.error('[InputEnhancer] Initialization failed: Missing required references.');
        return;
    }
    // Assign electronAPI from refs to the module-scoped variable (which is no longer declared with let/const at the top)
    // This assumes electronAPI is available in the scope where initializeInputEnhancer is called (e.g. window.electronAPI)
    // and is correctly passed in through refs.
    const localElectronAPI = refs.electronAPI; // Use a local const to avoid confusion if needed, or directly use refs.electronAPI
    console.log('[InputEnhancer] Initializing with localElectronAPI:', localElectronAPI); // Log the API object
    attachedFilesRef = refs.attachedFiles;
    updateAttachmentPreviewRef = refs.updateAttachmentPreview;
    currentAgentIdRef = refs.getCurrentAgentId;
    currentTopicIdRef = refs.getCurrentTopicId;

    const messageInput = refs.messageInput;

    // 1. Drag and Drop functionality
    messageInput.addEventListener('dragenter', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragenter event');
        messageInput.classList.add('drag-over');
    });

    messageInput.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        if (!messageInput.classList.contains('drag-over')) {
            messageInput.classList.add('drag-over');
        }
    });

    messageInput.addEventListener('dragleave', (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] dragleave event');
        messageInput.classList.remove('drag-over');
    });

    messageInput.addEventListener('drop', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log('[InputEnhancer] drop event triggered.');
        messageInput.classList.remove('drag-over');

        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();

        if (!agentId || !topicId) {
            alert("请先选择一个Agent和话题才能拖拽文件。");
            console.warn('[InputEnhancer] Drop aborted: Agent ID or Topic ID missing.');
            return;
        }

        const files = event.dataTransfer.files;
        if (files && files.length > 0) {
            console.log(`[InputEnhancer] Dropped ${files.length} files.`);
            const filesToProcess = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // Always try to read the file as a Buffer/ArrayBuffer, regardless of 'path' property.
                // This is more robust for drag-and-drop in Electron.
                filesToProcess.push(new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const arrayBuffer = e.target.result;
                        // If arrayBuffer is null or empty, it means FileReader couldn't read it.
                        if (!arrayBuffer) {
                            console.warn(`[InputEnhancer] FileReader received null ArrayBuffer for ${file.name}. Original size: ${file.size}.`);
                            resolve({ name: file.name, error: `无法读取文件内容` });
                            return;
                        }
                        const fileBuffer = new Uint8Array(arrayBuffer);
                        console.log(`[InputEnhancer] FileReader finished for ${file.name}. Size: ${file.size}, Buffer length: ${fileBuffer.length}, Type: ${file.type}`);
                        
                        // If fileBuffer is empty but original file size is not 0, it's still an issue.
                        // However, for very small files (e.g., 0-byte files), fileBuffer.length will be 0.
                        // We should allow 0-byte files to pass through if file.size is also 0.
                        // Removed the strict check for fileBuffer.length === 0 && file.size > 0 here,
                        // as it might be overly aggressive for certain file types or empty files.
                        // The main process's fileManager.storeFile will handle empty buffers.

                        resolve({
                            name: file.name,
                            type: file.type,
                            data: fileBuffer, // Send the buffer data
                            size: file.size
                        });
                    };
                    reader.onerror = (err) => {
                        console.error(`[InputEnhancer] FileReader error for ${file.name}:`, err);
                        resolve({ name: file.name, error: `无法读取文件: ${err.message}` });
                    };
                    reader.readAsArrayBuffer(file);
                }));
            }

            const droppedFilesData = await Promise.all(filesToProcess);
            const successfulFiles = droppedFilesData.filter(f => !f.error);
            const failedFiles = droppedFilesData.filter(f => f.error);

            if (failedFiles.length > 0) {
                failedFiles.forEach(f => {
                    alert(`处理拖拽的文件 ${f.name} 失败: ${f.error}`);
                    console.error(`[InputEnhancer] Failed to process dropped file ${f.name}: ${f.error}`);
                });
            }

            if (successfulFiles.length === 0) {
                console.warn('[InputEnhancer] No processable files found in drop event after reading attempts.');
                return;
            }

            try {
                console.log('[InputEnhancer] Calling localElectronAPI.handleFileDrop with:', agentId, topicId, successfulFiles.map(f => ({ name: f.name, type: f.type, size: f.size, data: f.data ? `[Buffer, length: ${f.data.length}]` : 'N/A' })));
                // Pass the actual buffers to main process
                const results = await localElectronAPI.handleFileDrop(agentId, topicId, successfulFiles);
                console.log('[InputEnhancer] Results from handleFileDrop:', results);
                if (results && results.length > 0) {
                    results.forEach(result => {
                        if (result.success && result.attachment) {
                            const att = result.attachment;
                             attachedFilesRef.push({
                                file: { name: att.name, type: att.type, size: att.size },
                                localPath: att.internalPath,
                                originalName: att.name,
                                _fileManagerData: att
                            });
                            console.log(`[InputEnhancer] Successfully attached dropped file: ${att.name}`);
                        } else if (result.error) {
                            console.error(`[InputEnhancer] Error processing dropped file ${result.name || 'unknown'}: ${result.error}`);
                            alert(`处理拖拽的文件 ${result.name || '未知文件'} 失败: ${result.error}`);
                        }
                    });
                    updateAttachmentPreviewRef();
                }
            } catch (err) {
                console.error('[InputEnhancer] Error calling localElectronAPI.handleFileDrop IPC:', err);
                alert('处理拖拽的文件时发生意外错误。');
            }
        } else {
            console.log('[InputEnhancer] Drop event occurred but no files found in dataTransfer.');
        }
    });

    // 2. Enhanced Paste functionality
    messageInput.addEventListener('paste', async (event) => {
        console.log('[InputEnhancer] paste event triggered.');
        const agentId = currentAgentIdRef();
        const topicId = currentTopicIdRef();

        if (!agentId || !topicId) {
            console.warn('[InputEnhancer] Paste handling skipped: Agent ID or Topic ID missing. Allowing default paste.');
            return;
        }

        const clipboardData = event.clipboardData || window.clipboardData;
        if (!clipboardData) {
            console.warn('[InputEnhancer] Clipboard data not available.');
            return;
        }
        const items = clipboardData.items;
        let isFileOrImagePaste = false;
        let preventDefaultCalled = false;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            console.log(`[InputEnhancer] Paste item ${i}: kind=${item.kind}, type=${item.type}`);

            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    event.preventDefault();
                    preventDefaultCalled = true;
                    isFileOrImagePaste = true;
                    console.log(`[InputEnhancer] Pasted file object: Name: ${file.name}, Type: ${file.type}, Path: ${file.path}`);

                    if (file.path) {
                         try {
                            console.log('[InputEnhancer] Handling pasted file via path.');
                            const result = await localElectronAPI.handleFilePaste(agentId, topicId, {
                                type: 'path',
                                path: file.path
                            });
                            console.log('[InputEnhancer] Result from handleFilePaste (path):', result);
                            if (result.success && result.attachment) {
                                const att = result.attachment;
                                attachedFilesRef.push({
                                    file: { name: att.name, type: att.type, size: att.size },
                                    localPath: att.internalPath,
                                    originalName: att.name,
                                    _fileManagerData: att
                                });
                                updateAttachmentPreviewRef();
                                console.log(`[InputEnhancer] Successfully attached pasted file (path): ${att.name}`);
                            } else {
                                alert(`粘贴文件失败: ${result.error}`);
                            }
                        } catch (err) {
                            console.error('[InputEnhancer] Error during file path paste IPC:', err);
                            alert('粘贴文件时发生错误。');
                        }
                    } else if (item.type.indexOf('image') !== -1) {
                         try {
                            console.log('[InputEnhancer] Handling pasted image data (no path). Checking localElectronAPI before readImageFromClipboard:', localElectronAPI);
                            const imageData = await localElectronAPI.readImageFromClipboard();
                            console.log('[InputEnhancer] Image data from clipboard:', imageData ? 'Exists' : 'null');
                            if (imageData && imageData.data) {
                                const result = await localElectronAPI.handleFilePaste(agentId, topicId, {
                                    type: 'base64',
                                    data: imageData.data,
                                    extension: imageData.extension || 'png'
                                });
                                console.log('[InputEnhancer] Result from handleFilePaste (base64):', result);
                                if (result.success && result.attachment) {
                                    const att = result.attachment;
                                    attachedFilesRef.push({
                                        file: { name: att.name, type: att.type, size: att.size },
                                        localPath: att.internalPath,
                                        originalName: att.name,
                                        _fileManagerData: att
                                    });
                                    updateAttachmentPreviewRef();
                                    console.log(`[InputEnhancer] Successfully attached pasted image (base64): ${att.name}`);
                                } else {
                                    alert(`粘贴图片失败: ${result.error}`);
                                }
                            } else {
                                console.warn('[InputEnhancer] Could not read image data from clipboard for a "file" kind item that was an image.');
                                alert('无法从剪贴板读取图片数据。');
                            }
                        } catch (err) {
                            console.error('[InputEnhancer] Error during image data paste IPC:', err);
                            alert('粘贴图片时发生错误。');
                        }
                    } else {
                        console.warn(`[InputEnhancer] Pasted file object ${file.name} has no path and is not a recognized image type for direct handling. Type: ${file.type}`);
                    }
                }
                break;
            }
        }

        if (isFileOrImagePaste) {
            console.log('[InputEnhancer] File or image paste handled.');
            return;
        }

        const pastedText = clipboardData.getData('text/plain');
        if (pastedText && pastedText.length > LONG_TEXT_THRESHOLD) {
            if (!preventDefaultCalled) { // Only prevent if not already done for file/image
                event.preventDefault();
            }
            console.log(`[InputEnhancer] Pasted long text (${pastedText.length} chars). Automatically converting to .txt file.`);
            // Removed confirm dialog, proceed directly to file conversion
            try {
                console.log('[InputEnhancer] Calling localElectronAPI.handleTextPasteAsFile.');
                const result = await localElectronAPI.handleTextPasteAsFile(agentId, topicId, pastedText);
                console.log('[InputEnhancer] Result from handleTextPasteAsFile:', result);
                if (result.success && result.attachment) {
                    const att = result.attachment;
                    const newAttachment = {
                        file: { name: att.name, type: att.type, size: att.size },
                        localPath: att.internalPath,
                        originalName: att.name,
                        _fileManagerData: att
                    };
                    console.log('[InputEnhancer] Preparing to push new attachment for long text:', JSON.stringify(newAttachment));
                    attachedFilesRef.push(newAttachment);
                    console.log(`[InputEnhancer] Pushed to attachedFilesRef. Current length: ${attachedFilesRef.length}. First item (if any): ${attachedFilesRef.length > 0 ? JSON.stringify(attachedFilesRef[0]) : 'N/A'}. Last item (if any): ${attachedFilesRef.length > 0 ? JSON.stringify(attachedFilesRef[attachedFilesRef.length - 1]) : 'N/A'}`);
                    
                    console.log('[InputEnhancer] Scheduling updateAttachmentPreviewRef for long text paste using setTimeout.');
                    // Using setTimeout to ensure the call happens after the current execution context,
                    // which can sometimes help with UI updates in complex scenarios.
                    setTimeout(() => {
                        console.log('[InputEnhancer] Calling updateAttachmentPreviewRef (from setTimeout) for long text paste.');
                        updateAttachmentPreviewRef();
                        console.log('[InputEnhancer] updateAttachmentPreviewRef (from setTimeout) finished.');
                    }, 0);
                    
                    console.log(`[InputEnhancer] Successfully attached long text as file: ${att.name}. Preview update scheduled.`);
                } else {
                    console.error(`[InputEnhancer] Failed to attach long text as file. Result success: ${result.success}, attachment: ${JSON.stringify(result.attachment)}, error: ${result.error}`);
                    alert(`长文本转存为 .txt 文件失败: ${result.error || '未知错误'}`);
                }
            } catch (err) {
                console.error('[InputEnhancer] Error calling handleTextPasteAsFile IPC or processing its result:', err);
                alert('长文本转存时发生意外错误。');
            }
            // The 'else' block for user cancellation is no longer needed as we default to 'yes'.
        } else if (pastedText) {
            console.log(`[InputEnhancer] Pasted short text (${pastedText.length} chars). Allowing default paste (if not prevented earlier).`);
        }
    });

    console.log('[InputEnhancer] Event listeners attached to message input.');
}

window.inputEnhancer = {
    initializeInputEnhancer
};