// VCPHumanToolBox/renderer_modules/ui/dynamic-image-handler.js
import * as canvasHandler from './canvas-handler.js';

// --- 占位函数 ---
// 稍后需要找到这些函数的正确实现
function makeSortable(element) {
    console.warn('makeSortable is not yet implemented.');
    // 在这里添加拖拽排序的逻辑
}

function updateImageIndicesAfterSort(container) {
    console.warn('updateImageIndicesAfterSort is not yet implemented.');
    // 在这里添加拖拽排序后的索引更新逻辑
}
// --- 占位函数结束 ---


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