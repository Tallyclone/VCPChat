// VCPHumanToolBox/renderer_modules/ui/dynamic-image-handler.js
import * as canvasHandler from './canvas-handler.js';

/**
 * 获取拖拽后应该插入的位置元素。
 * @param {HTMLElement} container - 容器元素。
 * @param {number} y - 鼠标Y坐标。
 * @returns {HTMLElement|null} 应该插入在此元素之前，如果为null则插入到末尾。
 */
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.dynamic-image-item:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/**
 * 拖拽排序后更新图片序号。
 * @param {HTMLElement} container - 图片列表容器。
 */
function updateImageIndicesAfterSort(container) {
    const items = container.querySelectorAll('.dynamic-image-item');
    items.forEach((item, index) => {
        const newIndex = index + 2; // 从 image_url_2 开始
        item.dataset.index = newIndex;
        
        const label = item.querySelector('label');
        label.textContent = `图片 ${newIndex}`;
        
        const input = item.querySelector('input[type="text"]');
        input.name = `image_url_${newIndex}`;
        
        const placeholder = `第${newIndex}张图片`;
        input.placeholder = placeholder;
        
        // 更新拖拽输入框内的占位符
        const dragDropContainer = item.querySelector('.dragdrop-image-container');
        if (dragDropContainer) {
            const textInput = dragDropContainer.querySelector('input[type="text"]');
            if (textInput) {
                textInput.name = `image_url_${newIndex}`;
                textInput.placeholder = placeholder;
            }
        }
    });
}

/**
 * 实现拖拽排序功能。
 * @param {HTMLElement} container - 支持拖拽排序的容器。
 */
function makeSortable(container) {
    let draggedElement = null;
    let isDraggingForSort = false;
    let startY = 0;
    let startX = 0;
    const threshold = 5; // 拖拽阀值，超过这个距离才认为是排序拖拽

    // 使用鼠标事件而不是 HTML5 拖拽 API，避免冲突
    container.addEventListener('mousedown', (e) => {
        const dragHandle = e.target.closest('.drag-handle');
        if (dragHandle && e.button === 0) { // 只处理左键
            e.preventDefault();
            draggedElement = dragHandle.closest('.dynamic-image-item');
            if (draggedElement) {
                startY = e.clientY;
                startX = e.clientX;
                isDraggingForSort = false;
                
                // 添加全局事件监听
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
                
                // 禁止选中文本
                document.body.style.userSelect = 'none';
            }
        }
    });

    function handleMouseMove(e) {
        if (!draggedElement) return;
        
        const deltaY = Math.abs(e.clientY - startY);
        const deltaX = Math.abs(e.clientX - startX);
        
        // 只有当鼠标移动超过阀值时才开始拖拽排序
        if (!isDraggingForSort && (deltaY > threshold || deltaX > threshold)) {
            isDraggingForSort = true;
            
            // 增强拖拽元素的视觉效果
            draggedElement.style.opacity = '0.8';
            draggedElement.style.transform = 'rotate(2deg) scale(1.02)';
            draggedElement.style.zIndex = '1000';
            draggedElement.style.boxShadow = '0 8px 32px rgba(59, 130, 246, 0.3), 0 0 0 2px rgba(59, 130, 246, 0.5)';
            draggedElement.style.borderRadius = '8px';
            draggedElement.classList.add('dragging');
            
            // 创建一个可视化的拖拽指示器
            const indicator = document.createElement('div');
            indicator.className = 'drag-indicator';
            indicator.style.cssText = `
                position: absolute;
                background: linear-gradient(90deg,
                    transparent 0%,
                    rgba(59, 130, 246, 0.8) 20%,
                    rgba(59, 130, 246, 1) 50%,
                    rgba(59, 130, 246, 0.8) 80%,
                    transparent 100%);
                border-radius: 2px;
                z-index: 1001;
                transition: all 0.2s ease;
                pointer-events: none;
                animation: dragPulse 1.5s ease-in-out infinite;
            `;
            container.appendChild(indicator);
        }
        
        if (isDraggingForSort) {
            // 更新拖拽指示器位置
            const indicator = container.querySelector('.drag-indicator');
            const afterElement = getDragAfterElement(container, e.clientY);
            
            // 清除之前的高亮效果
            container.querySelectorAll('.dynamic-image-item').forEach(item => {
                if (item !== draggedElement) {
                    item.classList.remove('drag-target-hover');
                }
            });
            
            if (afterElement) {
                const rect = afterElement.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                indicator.style.top = (rect.top - containerRect.top - 2) + 'px';
                indicator.style.left = '10px';
                indicator.style.width = 'calc(100% - 20px)';
                indicator.style.height = '4px';
                
                // 高亮目标元素
                afterElement.classList.add('drag-target-hover');
            } else {
                // 在最后一个元素之后
                const lastItem = container.querySelector('.dynamic-image-item:last-child');
                if (lastItem && lastItem !== draggedElement) {
                    const rect = lastItem.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    indicator.style.top = (rect.bottom - containerRect.top + 2) + 'px';
                    indicator.style.left = '10px';
                    indicator.style.width = 'calc(100% - 20px)';
                    indicator.style.height = '4px';
                    
                    // 高亮最后一个元素
                    lastItem.classList.add('drag-target-hover');
                }
            }
        }
    }

    function handleMouseUp(e) {
        if (draggedElement && isDraggingForSort) {
            // 执行拖拽排序
            const afterElement = getDragAfterElement(container, e.clientY);
            if (afterElement) {
                container.insertBefore(draggedElement, afterElement);
            } else {
                container.appendChild(draggedElement);
            }
            
            // 更新序号
            updateImageIndicesAfterSort(container);
        }
        
        // 清理
        if (draggedElement) {
            draggedElement.style.opacity = '';
            draggedElement.style.transform = '';
            draggedElement.style.zIndex = '';
            draggedElement.style.boxShadow = '';
            draggedElement.style.borderRadius = '';
            draggedElement.classList.remove('dragging');
        }
        
        // 清除所有高亮效果
        container.querySelectorAll('.dynamic-image-item').forEach(item => {
            item.classList.remove('drag-target-hover');
        });
        
        const indicator = container.querySelector('.drag-indicator');
        if (indicator) {
            indicator.remove();
        }
        
        draggedElement = null;
        isDraggingForSort = false;
        document.body.style.userSelect = '';
        
        // 移除全局事件监听
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }

    // 为新添加的元素设置样式
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.classList.contains('dynamic-image-item')) {
                    const dragHandle = node.querySelector('.drag-handle');
                    if (dragHandle) {
                        dragHandle.style.cursor = 'move';
                        dragHandle.title = '拖拽调整顺序';
                    }
                }
            });
        });
    });
    
    observer.observe(container, { childList: true });
}


/**
 * 设置空区域的拖拽上传功能。
 * @param {HTMLElement} container - 目标容器元素。
 */
function setupEmptyAreaDragDrop(container) {
    let dragCounter = 0;
    
    container.addEventListener('dragenter', (e) => {
        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
            if (targetDragDropContainer) return;
            
            dragCounter++;
            
            if (container.children.length === 0) {
                container.style.borderStyle = 'dashed';
                container.style.borderColor = 'var(--primary-color)';
                container.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
                
                if (!container.querySelector('.empty-drop-hint')) {
                    const hint = document.createElement('div');
                    hint.className = 'empty-drop-hint';
                    hint.style.cssText = `text-align: center; padding: 40px 20px; color: var(--primary-color); font-size: 16px; font-weight: bold; pointer-events: none;`;
                    hint.innerHTML = `📁 拖拽图片到此处添加<br><span style="font-size: 14px; font-weight: normal;">将自动作为额外图片添加</span>`;
                    container.appendChild(hint);
                }
            }
        }
    });
    
    container.addEventListener('dragleave', (e) => {
        if (e.dataTransfer.types.includes('Files')) {
            const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
            if (targetDragDropContainer) return;
            
            dragCounter--;
            
            if (dragCounter === 0) {
                container.style.borderStyle = '';
                container.style.borderColor = '';
                container.style.backgroundColor = '';
                const hint = container.querySelector('.empty-drop-hint');
                if (hint) hint.remove();
            }
        }
    });
    
    container.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('Files')) {
            const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
            if (targetDragDropContainer) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    
    container.addEventListener('drop', (e) => {
        if (e.dataTransfer.types.includes('Files')) {
            const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
            if (targetDragDropContainer) return;
            
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            if (files.length > 0) {
                container.style.borderStyle = '';
                container.style.borderColor = '';
                container.style.backgroundColor = '';
                const hint = container.querySelector('.empty-drop-hint');
                if (hint) hint.remove();
                
                files.forEach((file, index) => {
                    const nextIndex = getNextAvailableImageIndex(container);
                    const newItem = addDynamicImageInput(container, nextIndex);
                    
                    setTimeout(() => {
                        const textInput = newItem.querySelector('input[type="text"]');
                        const dropZone = newItem.querySelector('.drop-zone');
                        const previewArea = newItem.querySelector('.image-preview-area');
                        const clearButton = newItem.querySelector('.clear-image-btn');
                        const canvasButtonsContainer = newItem.querySelector('.canvas-buttons-container');
                        const editCanvasButton = canvasButtonsContainer?.querySelector('.edit-canvas-btn');
                        
                        if (textInput && dropZone && previewArea && clearButton) {
                            canvasHandler.handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                        }
                    }, 100 + index * 50);
                });
            }
        }
    });
}

/**
 * 一键清空所有额外图片。
 * @param {HTMLElement} container - 额外图片列表的容器。
 */
function clearAllAdditionalImages(container) {
    const imageItems = container.querySelectorAll('.dynamic-image-item');
    
    if (imageItems.length === 0) {
        canvasHandler.showNotification('ℹ️ 没有额外图片需要清空', 'warning');
        return;
    }
    
    if (confirm(`确定要清空所有 ${imageItems.length} 张额外图片吗？此操作不可撤销。`)) {
        imageItems.forEach(item => item.remove());
        canvasHandler.showNotification(`✓ 已清空 ${imageItems.length} 张额外图片`, 'success');
    }
}

/**
 * 获取下一个可用的图片索引（从2开始）。
 * @param {HTMLElement} container - 额外图片列表的容器。
 * @returns {number} 下一个可用的索引。
 */
function getNextAvailableImageIndex(container) {
    const existingItems = container.querySelectorAll('.dynamic-image-item');
    const usedIndices = Array.from(existingItems).map(item => parseInt(item.dataset.index, 10)).filter(index => !isNaN(index));
    for (let i = 2; i <= usedIndices.length + 2; i++) {
        if (!usedIndices.includes(i)) return i;
    }
    return Math.max(...usedIndices, 1) + 1;
}

/**
 * 添加一个新的动态图片输入框到容器中。
 * @param {HTMLElement} container - 额外图片列表的容器。
 * @param {number} index - 新输入框的索引。
 * @returns {HTMLElement} 创建的图片项元素。
 */
function addDynamicImageInput(container, index) {
    const imageItem = document.createElement('div');
    imageItem.className = 'dynamic-image-item';
    imageItem.dataset.index = index;
    imageItem.style.cssText = `
        display: flex; align-items: flex-start; gap: 10px; margin-bottom: 15px;
        padding: 10px; border: 1px solid var(--border-color); border-radius: 6px;
        background: var(--input-bg);
    `;

    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '☰';
    dragHandle.draggable = false;
    dragHandle.style.cssText = `cursor: move; color: var(--secondary-text); font-size: 18px; padding: 5px; user-select: none; display: flex; align-items: center; justify-content: center; min-width: 30px;`;

    const inputContainer = document.createElement('div');
    inputContainer.style.cssText = 'flex: 1;';
    
    const label = document.createElement('label');
    label.textContent = `图片 ${index}`;
    label.style.cssText = `display: block; margin-bottom: 5px; font-weight: bold;`;

    const dragDropInput = canvasHandler.createDragDropImageInput({
        name: `image_url_${index}`,
        placeholder: `第${index}张图片`,
        required: false
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.innerHTML = '❌';
    removeButton.className = 'remove-image-btn';
    removeButton.style.cssText = `
        background: var(--danger-color); color: white; border: none; padding: 8px 12px;
        border-radius: 4px; cursor: pointer; font-size: 12px; align-self: flex-start;
        margin-top: 5px; transition: all 0.2s ease; margin-bottom: 5px;
    `;
    
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `display: flex; flex-direction: column; gap: 5px; align-self: flex-start; margin-top: 5px;`;
    
    removeButton.addEventListener('click', () => {
        imageItem.remove();
        updateImageIndicesAfterSort(container);
    });

    inputContainer.appendChild(label);
    inputContainer.appendChild(dragDropInput);
    buttonContainer.appendChild(removeButton);
    imageItem.append(dragHandle, inputContainer, buttonContainer);
    container.appendChild(imageItem);
    
    const canvasRestoreButton = dragDropInput.querySelector('.canvas-buttons-container .restore-image-btn');
    if (canvasRestoreButton) canvasRestoreButton.style.display = 'none';
    
    return imageItem;
}

/**
 * 创建并初始化动态图片管理容器。
 * @param {HTMLElement} parentContainer - 将要容纳此组件的父元素。
 */
export function createDynamicImageContainer(parentContainer) {
    const dynamicContainer = document.createElement('div');
    dynamicContainer.className = 'dynamic-images-container';
    dynamicContainer.innerHTML = `
        <div class="dynamic-images-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h4>额外图片</h4>
            <div class="header-buttons" style="display: flex; gap: 10px;">
                <button type="button" class="add-image-btn">➕ 添加图片</button>
                <button type="button" class="clear-all-images-btn">🗑️ 一键清空</button>
            </div>
        </div>
        <div class="sortable-images-list" id="sortable-images-list"></div>
    `;
    dynamicContainer.style.cssText = `margin-top: 20px; border: 1px solid var(--border-color); border-radius: 8px; padding: 15px; background: var(--card-bg);`;

    const addButton = dynamicContainer.querySelector('.add-image-btn');
    const clearAllButton = dynamicContainer.querySelector('.clear-all-images-btn');
    const imagesList = dynamicContainer.querySelector('.sortable-images-list');

    const buttonStyles = `color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s;`;
    addButton.style.cssText = buttonStyles + `background: var(--primary-color);`;
    clearAllButton.style.cssText = buttonStyles + `background: var(--danger-color);`;

    addButton.addEventListener('click', () => {
        const nextIndex = getNextAvailableImageIndex(imagesList);
        addDynamicImageInput(imagesList, nextIndex);
    });
    
    clearAllButton.addEventListener('click', () => clearAllAdditionalImages(imagesList));

    makeSortable(imagesList);
    setupEmptyAreaDragDrop(imagesList);
    
    parentContainer.appendChild(dynamicContainer);
}