
// Promptmodules/modular-prompt-module.js
// 模块化系统提示词模块 - 积木块功能

class ModularPromptModule {
    constructor(options) {
        this.agentId = options.agentId;
        this.config = options.config;
        this.electronAPI = options.electronAPI;
        
        // 积木块数据
        this.blocks = [];
        this.hiddenBlocks = {}; // 按仓库分类存储隐藏的积木块
        this.warehouseOrder = ['default']; // 仓库顺序
        this.currentWarehouse = 'default'; // 当前仓库
        
        // UI元素
        this.container = null;
        this.blocksContainer = null;
        this.warehouseContainer = null;
        
        // 状态
        this.tileMode = true; // 瓦片模式（显示\n块）
        this.viewMode = false; // 预览模式
        
        // 拖拽状态
        this.draggedBlock = null;
        this.draggedIndex = null;
        this.dropIndicator = null;
        this.draggedHiddenBlock = null; // 从小仓拖拽的积木块
        this.draggedWarehouse = null; // 拖拽的仓库
        
        // 加载保存的数据
        this.loadData();
    }

    /**
     * 加载保存的数据
     */
    loadData() {
        const savedData = this.config.advancedSystemPrompt;
        if (savedData && typeof savedData === 'object') {
            this.blocks = savedData.blocks || [];
            this.hiddenBlocks = savedData.hiddenBlocks || { default: [] };
            this.warehouseOrder = savedData.warehouseOrder || ['default'];
            // tileMode 始终为 true，不再从保存的数据加载
        } else if (typeof savedData === 'string') {
            // 兼容旧格式：纯文本
            this.blocks = savedData ? [{ id: this.generateId(), type: 'text', content: savedData, disabled: false }] : [];
        }
        
        // 确保default仓库存在且在第一位
        if (!this.hiddenBlocks.default) {
            this.hiddenBlocks.default = [];
        }
        if (!this.warehouseOrder.includes('default')) {
            this.warehouseOrder.unshift('default');
        } else if (this.warehouseOrder[0] !== 'default') {
            this.warehouseOrder = this.warehouseOrder.filter(w => w !== 'default');
            this.warehouseOrder.unshift('default');
        }
    }

    /**
     * 生成唯一ID
     */
    generateId() {
        return 'block_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 渲染模块UI
     */
    render(container) {
        this.container = container;
        container.innerHTML = '';
        container.className = 'modular-prompt-container';

        // 顶部工具栏
        const toolbar = this.createToolbar();
        container.appendChild(toolbar);

        // 积木块容器
        this.blocksContainer = document.createElement('div');
        this.blocksContainer.className = 'blocks-container';
        
        // 为容器添加拖拽事件监听，支持从小仓拖入
        this.blocksContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        
        this.blocksContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            // 如果是从小仓拖入到空容器，追加到末尾
            if (this.draggedHiddenBlock) {
                const { block } = this.draggedHiddenBlock;
                const newBlock = {
                    ...block,
                    id: this.generateId(),
                    variants: block.variants ? [...block.variants] : undefined,
                    selectedVariant: block.selectedVariant
                };
                this.blocks.push(newBlock);
                this.save();
                this.renderBlocks();
                this.draggedHiddenBlock = null;
            }
        });
        
        container.appendChild(this.blocksContainer);

        // 底部小仓（隐藏块）
        this.warehouseContainer = document.createElement('div');
        this.warehouseContainer.className = 'warehouse-container';
        container.appendChild(this.warehouseContainer);

        // 渲染内容
        if (this.viewMode) {
            this.renderPreview();
        } else {
            this.renderBlocks();
            this.renderWarehouse();
        }
    }

    /**
     * 创建工具栏
     */
    createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'modular-toolbar';

        // 添加积木块按钮
        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn';
        addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 添加积木块';
        addBtn.onclick = () => this.addBlock('text');
        toolbar.appendChild(addBtn);

        // 添加换行块按钮
        const addNewlineBtn = document.createElement('button');
        addNewlineBtn.className = 'toolbar-btn';
        addNewlineBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3h10M3 8h10M3 13h10" stroke="currentColor" stroke-width="2"/></svg> 添加换行';
        addNewlineBtn.onclick = () => this.addBlock('newline');
        toolbar.appendChild(addNewlineBtn);

        // 创建右侧控制组
        const controlsGroup = document.createElement('div');
        controlsGroup.className = 'toolbar-controls-group';

        // View 模式开关
        const viewModeToggle = document.createElement('label');
        viewModeToggle.className = 'toolbar-toggle';
        viewModeToggle.innerHTML = `
            <input type="checkbox" ${this.viewMode ? 'checked' : ''} id="viewModeCheckbox">
            <span>预览模式</span>
        `;
        viewModeToggle.querySelector('input').onchange = (e) => this.toggleViewMode(e.target.checked);
        controlsGroup.appendChild(viewModeToggle);

        toolbar.appendChild(controlsGroup);

        return toolbar;
    }

    /**
     * 渲染积木块
     */
    renderBlocks() {
        this.blocksContainer.innerHTML = '';

        if (this.blocks.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'blocks-hint';
            hint.textContent = '点击上方按钮添加积木块';
            this.blocksContainer.appendChild(hint);
            return;
        }

        this.blocks.forEach((block, index) => {
            const blockEl = this.createBlockElement(block, index);
            this.blocksContainer.appendChild(blockEl);
            
            // 如果是换行块，在其后插入一个换行标记
            if (block.type === 'newline') {
                const lineBreak = document.createElement('div');
                lineBreak.className = 'line-break-marker';
                this.blocksContainer.appendChild(lineBreak);
            }
        });
    }

    /**
     * 创建积木块元素
     */
    createBlockElement(block, index) {
        const blockEl = document.createElement('div');
        blockEl.className = 'prompt-block';
        blockEl.dataset.index = index;
        blockEl.dataset.id = block.id;

        if (block.type === 'newline') {
            blockEl.classList.add('newline-block');
            blockEl.innerHTML = '<span class="newline-label">\\n</span>';
        } else {
            blockEl.classList.add('text-block');
            if (block.disabled) {
                blockEl.classList.add('disabled');
            }

            // 内容编辑区
            const contentEl = document.createElement('div');
            contentEl.className = 'block-content';
            contentEl.contentEditable = !block.disabled;
            contentEl.textContent = block.content || '';
            contentEl.addEventListener('blur', () => {
                block.content = contentEl.textContent;
                this.save();
            });
            contentEl.addEventListener('keydown', (e) => {
                if (e.shiftKey && e.key === 'Enter') {
                    e.preventDefault();
                    this.addBlock('newline', index + 1);
                }
            });
            blockEl.appendChild(contentEl);

            // 子积木块（轮换文本）
            if (block.variants && block.variants.length > 0) {
                const variantsEl = this.createVariantsElement(block);
                blockEl.appendChild(variantsEl);
            }
        }

        // 拖拽功能（始终启用）
        blockEl.draggable = true;
        blockEl.addEventListener('dragstart', (e) => this.handleDragStart(e, block, index));
        blockEl.addEventListener('dragover', (e) => this.handleDragOver(e, blockEl, index));
        blockEl.addEventListener('dragleave', (e) => this.handleDragLeave(e, blockEl));
        blockEl.addEventListener('drop', (e) => this.handleDrop(e, index));
        blockEl.addEventListener('dragend', () => this.handleDragEnd());

        // 右键菜单
        blockEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showBlockContextMenu(e, block, index);
        });

        return blockEl;
    }

    /**
     * 创建轮换文本元素
     */
    createVariantsElement(block) {
        const container = document.createElement('div');
        container.className = 'variants-container';

        const label = document.createElement('div');
        label.className = 'variants-label';
        label.textContent = '轮换选项:';
        container.appendChild(label);

        const select = document.createElement('select');
        select.className = 'variants-select';
        
        block.variants.forEach((variant, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = variant.substring(0, 30) + (variant.length > 30 ? '...' : '');
            if (index === (block.selectedVariant || 0)) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        select.onchange = () => {
            block.selectedVariant = parseInt(select.value);
            this.save();
        };

        container.appendChild(select);
        return container;
    }

    /**
     * 显示积木块右键菜单
     */
    showBlockContextMenu(e, block, index) {
        // 移除已存在的菜单
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [
            {
                label: block.disabled ? '启用' : '禁用',
                action: () => this.toggleBlockDisabled(index)
            },
            {
                label: '隐藏到小仓',
                action: () => this.hideBlock(index)
            },
            {
                label: '添加轮换文本',
                action: () => this.addVariant(index),
                hidden: block.type === 'newline'
            },
            {
                label: '删除',
                action: () => this.deleteBlock(index),
                danger: true
            }
        ];

        menuItems.forEach(item => {
            if (item.hidden) return;
            
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        // 点击外部关闭菜单
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 添加积木块
     */
    addBlock(type, position = null) {
        const newBlock = {
            id: this.generateId(),
            type: type,
            content: type === 'text' ? '' : '',
            disabled: false
        };

        if (position !== null) {
            this.blocks.splice(position, 0, newBlock);
        } else {
            this.blocks.push(newBlock);
        }

        this.save();
        this.renderBlocks();
    }

    /**
     * 删除积木块
     */
    deleteBlock(index) {
        this.blocks.splice(index, 1);
        this.save();
        this.renderBlocks();
    }

    /**
     * 切换积木块禁用状态
     */
    toggleBlockDisabled(index) {
        this.blocks[index].disabled = !this.blocks[index].disabled;
        this.save();
        this.renderBlocks();
    }

    /**
     * 隐藏积木块到小仓
     */
    hideBlock(index) {
        const block = this.blocks.splice(index, 1)[0];
        if (!this.hiddenBlocks[this.currentWarehouse]) {
            this.hiddenBlocks[this.currentWarehouse] = [];
        }
        this.hiddenBlocks[this.currentWarehouse].push(block);
        this.save();
        this.renderBlocks();
        this.renderWarehouse();
    }

    /**
     * 添加轮换文本
     */
    addVariant(index) {
        const block = this.blocks[index];
        if (!block.variants) {
            block.variants = [];
        }
        const newVariant = prompt('请输入轮换文本:');
        if (newVariant !== null && newVariant.trim()) {
            block.variants.push(newVariant.trim());
            this.save();
            this.renderBlocks();
        }
    }

    /**
     * 渲染小仓
     */
    renderWarehouse() {
        this.warehouseContainer.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'warehouse-header';
        header.innerHTML = '<h4>隐藏积木块小仓</h4>';
        
        // 添加新建仓库按钮
        const addWarehouseBtn = document.createElement('button');
        addWarehouseBtn.className = 'add-warehouse-btn';
        addWarehouseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        addWarehouseBtn.title = '新建仓库';
        addWarehouseBtn.onclick = () => this.createWarehouse();
        header.appendChild(addWarehouseBtn);
        
        this.warehouseContainer.appendChild(header);

        // 仓库选择
        const warehouseSelector = document.createElement('div');
        warehouseSelector.className = 'warehouse-selector';
        
        // 按照warehouseOrder顺序显示仓库
        this.warehouseOrder.forEach((name, index) => {
            if (!this.hiddenBlocks[name]) {
                this.hiddenBlocks[name] = [];
            }
            
            const warehouseItem = document.createElement('div');
            warehouseItem.className = 'warehouse-item';
            if (name === this.currentWarehouse) {
                warehouseItem.classList.add('active');
            }
            
            // 仓库名称按钮
            const btn = document.createElement('button');
            btn.className = 'warehouse-btn';
            btn.textContent = name;
            btn.onclick = () => {
                this.currentWarehouse = name;
                this.renderWarehouse();
            };
            
            // 仓库拖拽（default除外）
            if (name !== 'default') {
                warehouseItem.draggable = true;
                warehouseItem.dataset.warehouseName = name;
                warehouseItem.addEventListener('dragstart', (e) => this.handleWarehouseDragStart(e, name, index));
                warehouseItem.addEventListener('dragover', (e) => this.handleWarehouseDragOver(e, index));
                warehouseItem.addEventListener('drop', (e) => this.handleWarehouseDrop(e, index));
                warehouseItem.addEventListener('dragend', () => this.handleWarehouseDragEnd());
            }
            
            warehouseItem.appendChild(btn);
            
            // 右键菜单（default除外）
            if (name !== 'default') {
                warehouseItem.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showWarehouseContextMenu(e, name);
                });
            }
            
            warehouseSelector.appendChild(warehouseItem);
        });

        this.warehouseContainer.appendChild(warehouseSelector);

        // 隐藏的积木块列表
        const hiddenBlocksList = document.createElement('div');
        hiddenBlocksList.className = 'hidden-blocks-list';

        const currentHidden = this.hiddenBlocks[this.currentWarehouse] || [];
        if (currentHidden.length === 0) {
            hiddenBlocksList.innerHTML = '<div class="warehouse-empty">此仓库为空</div>';
        } else {
            currentHidden.forEach((block, index) => {
                const blockEl = this.createHiddenBlockElement(block, index);
                hiddenBlocksList.appendChild(blockEl);
            });
        }

        this.warehouseContainer.appendChild(hiddenBlocksList);
    }

    /**
     * 创建隐藏积木块元素
     */
    createHiddenBlockElement(block, index) {
        const blockEl = document.createElement('div');
        blockEl.className = 'hidden-block';
        
        // 显示名称或内容预览
        const displayText = block.name || (block.content ? block.content : '[空积木块]');
        const previewText = displayText.split('\n')[0]; // 只显示第一行
        blockEl.textContent = previewText.length > 30 ? previewText.substring(0, 30) + '...' : previewText;
        
        // 悬浮提示显示完整内容
        blockEl.title = block.content || '[空积木块]';
        
        // 小仓积木块始终可拖拽（不受 tileMode 限制）
        blockEl.draggable = true;
        blockEl.addEventListener('dragstart', (e) => {
            this.draggedHiddenBlock = { block, index, warehouse: this.currentWarehouse };
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', 'hidden-block');
            blockEl.classList.add('dragging');
        });
        blockEl.addEventListener('dragend', () => {
            blockEl.classList.remove('dragging');
            this.draggedHiddenBlock = null;
        });

        // 右键菜单
        blockEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showHiddenBlockMenu(e, block, index);
        });

        return blockEl;
    }

    /**
     * 显示隐藏积木块菜单
     */
    showHiddenBlockMenu(e, block, index) {
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [
            {
                label: '编辑',
                action: () => this.editHiddenBlock(block, index)
            },
            {
                label: '恢复到编辑区',
                action: () => this.restoreBlock(index)
            },
            {
                label: '删除',
                action: () => this.deleteHiddenBlock(index),
                danger: true
            }
        ];

        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 编辑隐藏积木块
     */
    editHiddenBlock(block, index) {
        // 创建编辑对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>编辑积木块</h3>
                <div class="dialog-field">
                    <label>名称（可选）:</label>
                    <input type="text" class="block-name-input" value="${block.name || ''}" placeholder="为积木块命名...">
                </div>
                <div class="dialog-field">
                    <label>内容:</label>
                    <textarea class="block-content-input" rows="8">${block.content || ''}</textarea>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">保存</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const nameInput = dialog.querySelector('.block-name-input');
        const contentInput = dialog.querySelector('.block-content-input');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        saveBtn.onclick = () => {
            block.name = nameInput.value.trim();
            block.content = contentInput.value;
            this.save();
            this.renderWarehouse();
            closeDialog();
        };
        
        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;
        
        // 聚焦到内容输入框
        contentInput.focus();
    }

    /**
     * 恢复积木块
     */
    restoreBlock(index) {
        const block = this.hiddenBlocks[this.currentWarehouse].splice(index, 1)[0];
        this.blocks.push(block);
        this.save();
        this.renderBlocks();
        this.renderWarehouse();
    }

    /**
     * 删除隐藏积木块
     */
    deleteHiddenBlock(index) {
        this.hiddenBlocks[this.currentWarehouse].splice(index, 1);
        this.save();
        this.renderWarehouse();
    }

    /**
     * 拖拽开始
     */
    handleDragStart(e, block, index) {
        this.draggedBlock = block;
        this.draggedIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.target.classList.add('dragging');
    }

    /**
     * 拖拽经过
     */
    handleDragOver(e, targetElement, targetIndex) {
        e.preventDefault();
        
        // 根据拖拽源设置效果
        if (this.draggedHiddenBlock) {
            e.dataTransfer.dropEffect = 'copy';
        } else {
            e.dataTransfer.dropEffect = 'move';
        }
        
        // 如果拖拽的是自己，不显示指示器
        if (this.draggedIndex === targetIndex && !this.draggedHiddenBlock) {
            this.removeDropIndicator();
            return;
        }
        
        // 添加视觉提示
        targetElement.classList.add('drop-target');
    }

    /**
     * 拖拽离开
     */
    handleDragLeave(e, targetElement) {
        // 只有当真正离开元素时才移除样式
        if (!targetElement.contains(e.relatedTarget)) {
            targetElement.classList.remove('drop-target');
        }
    }

    /**
     * 移除所有drop指示器
     */
    removeDropIndicator() {
        const targets = this.blocksContainer.querySelectorAll('.drop-target');
        targets.forEach(el => el.classList.remove('drop-target'));
    }

    /**
     * 放置
     */
    handleDrop(e, targetIndex) {
        e.preventDefault();
        e.stopPropagation(); // 防止事件冒泡到容器
        this.removeDropIndicator();
        
        // 从小仓拖拽到编辑区（复制模式，不删除原积木块）
        if (this.draggedHiddenBlock) {
            const { block } = this.draggedHiddenBlock;
            // 深拷贝积木块（包括 variants 等属性）
            const newBlock = {
                ...block,
                id: this.generateId(),
                variants: block.variants ? [...block.variants] : undefined,
                selectedVariant: block.selectedVariant
            };
            
            // 计算插入位置：鼠标位置决定是插入前还是插入后
            const rect = e.target.getBoundingClientRect();
            const midPoint = rect.left + rect.width / 2;
            const insertIndex = e.clientX < midPoint ? targetIndex : targetIndex + 1;
            
            this.blocks.splice(insertIndex, 0, newBlock);
            this.save();
            this.renderBlocks();
            this.draggedHiddenBlock = null;
            return;
        }
        
        // 编辑区内部拖拽
        if (this.draggedIndex !== null && this.draggedIndex !== targetIndex) {
            // 移动积木块
            const [movedBlock] = this.blocks.splice(this.draggedIndex, 1);
            // 简化逻辑：直接插入到目标位置
            if (this.draggedIndex < targetIndex) {
                this.blocks.splice(targetIndex - 1, 0, movedBlock);
            } else {
                this.blocks.splice(targetIndex, 0, movedBlock);
            }
            
            this.save();
            this.renderBlocks();
        }
    }

    /**
     * 拖拽结束
     */
    handleDragEnd() {
        this.draggedBlock = null;
        this.draggedIndex = null;
        this.draggedHiddenBlock = null;
        this.removeDropIndicator();
        const draggingEl = this.blocksContainer.querySelector('.dragging');
        if (draggingEl) {
            draggingEl.classList.remove('dragging');
        }
    }

    /**
     * 切换预览模式
     */
    toggleViewMode(enabled) {
        this.viewMode = enabled;
        this.render(this.container);
    }

    /**
     * 渲染预览
     */
    renderPreview() {
        this.blocksContainer.innerHTML = '';
        this.warehouseContainer.style.display = 'none';

        const previewContainer = document.createElement('div');
        previewContainer.className = 'preview-container';

        const label = document.createElement('div');
        label.className = 'preview-label';
        label.textContent = '格式化预览:';
        previewContainer.appendChild(label);

        const previewText = document.createElement('pre');
        previewText.className = 'preview-text';
        previewText.textContent = this.formatBlocks();
        previewContainer.appendChild(previewText);

        this.blocksContainer.appendChild(previewContainer);
    }

    /**
     * 格式化积木块为文本
     */
    formatBlocks() {
        return this.blocks
            .filter(block => !block.disabled)
            .map(block => {
                if (block.type === 'newline') {
                    return '\n';
                } else {
                    let content = block.content || '';
                    // 如果有轮换文本，使用选中的版本
                    if (block.variants && block.variants.length > 0) {
                        const selectedIndex = block.selectedVariant || 0;
                        content = block.variants[selectedIndex] || content;
                    }
                    return content;
                }
            })
            .join('');
    }

    /**
     * 获取格式化后的提示词
     */
    async getFormattedPrompt() {
        return this.formatBlocks();
    }

    /**
     * 保存数据
     */
    async save() {
        const data = {
            blocks: this.blocks,
            hiddenBlocks: this.hiddenBlocks,
            warehouseOrder: this.warehouseOrder
            // 不再保存 tileMode，因为它始终为 true
        };

        await this.electronAPI.updateAgentConfig(this.agentId, {
            advancedSystemPrompt: data
        });
    }

    /**
     * 新建仓库
     */
    createWarehouse() {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>新建仓库</h3>
                <div class="dialog-field">
                    <label>仓库名称:</label>
                    <input type="text" class="block-name-input" placeholder="请输入仓库名称..." autofocus>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">创建</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const nameInput = dialog.querySelector('.block-name-input');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        const createAction = () => {
            const name = nameInput.value.trim();
            
            if (!name) {
                alert('请输入仓库名称');
                return;
            }
            
            if (name === 'default') {
                alert('不能使用 "default" 作为仓库名称');
                return;
            }
            
            if (this.hiddenBlocks[name]) {
                alert('仓库名称已存在');
                return;
            }
            
            this.hiddenBlocks[name] = [];
            this.warehouseOrder.push(name);
            this.currentWarehouse = name;
            this.save();
            this.renderWarehouse();
            closeDialog();
        };
        
        saveBtn.onclick = createAction;
        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;
        
        // 支持回车创建
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createAction();
            } else if (e.key === 'Escape') {
                closeDialog();
            }
        });
        
        // 聚焦到输入框
        setTimeout(() => nameInput.focus(), 0);
    }

    /**
     * 显示仓库右键菜单
     */
    showWarehouseContextMenu(e, warehouseName) {
        const existingMenu = document.querySelector('.block-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'block-context-menu';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';

        const menuItems = [
            {
                label: '重命名',
                action: () => this.renameWarehouse(warehouseName)
            },
            {
                label: '删除',
                action: () => this.deleteWarehouse(warehouseName),
                danger: true
            }
        ];

        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            if (item.danger) {
                menuItem.classList.add('danger');
            }
            menuItem.textContent = item.label;
            menuItem.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(menuItem);
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 重命名仓库
     */
    renameWarehouse(oldName) {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.className = 'edit-hidden-block-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <h3>重命名仓库</h3>
                <div class="dialog-field">
                    <label>仓库名称:</label>
                    <input type="text" class="block-name-input" value="${oldName}" autofocus>
                </div>
                <div class="dialog-buttons">
                    <button class="dialog-btn dialog-btn-cancel">取消</button>
                    <button class="dialog-btn dialog-btn-save">确定</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const nameInput = dialog.querySelector('.block-name-input');
        const saveBtn = dialog.querySelector('.dialog-btn-save');
        const cancelBtn = dialog.querySelector('.dialog-btn-cancel');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        const renameAction = () => {
            const newName = nameInput.value.trim();
            
            if (!newName || newName === oldName) {
                closeDialog();
                return;
            }
            
            if (newName === 'default') {
                alert('不能使用 "default" 作为仓库名称');
                return;
            }
            
            if (this.hiddenBlocks[newName]) {
                alert('仓库名称已存在');
                return;
            }
            
            // 重命名
            this.hiddenBlocks[newName] = this.hiddenBlocks[oldName];
            delete this.hiddenBlocks[oldName];
            
            const index = this.warehouseOrder.indexOf(oldName);
            if (index !== -1) {
                this.warehouseOrder[index] = newName;
            }
            
            if (this.currentWarehouse === oldName) {
                this.currentWarehouse = newName;
            }
            
            this.save();
            this.renderWarehouse();
            closeDialog();
        };
        
        saveBtn.onclick = renameAction;
        cancelBtn.onclick = closeDialog;
        dialog.querySelector('.dialog-overlay').onclick = closeDialog;
        
        // 支持回车确认
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                renameAction();
            } else if (e.key === 'Escape') {
                closeDialog();
            }
        });
        
        // 聚焦并选中文本
        setTimeout(() => {
            nameInput.focus();
            nameInput.select();
        }, 0);
    }

    /**
     * 删除仓库
     */
    deleteWarehouse(warehouseName) {
        if (!confirm(`确定要删除仓库 "${warehouseName}" 吗？其中的积木块也会被删除。`)) {
            return;
        }
        
        delete this.hiddenBlocks[warehouseName];
        this.warehouseOrder = this.warehouseOrder.filter(w => w !== warehouseName);
        
        if (this.currentWarehouse === warehouseName) {
            this.currentWarehouse = 'default';
        }
        
        this.save();
        this.renderWarehouse();
    }

    /**
     * 仓库拖拽开始
     */
    handleWarehouseDragStart(e, warehouseName, index) {
        this.draggedWarehouse = { name: warehouseName, index: index };
        e.dataTransfer.effectAllowed = 'move';
        e.target.classList.add('dragging');
    }

    /**
     * 仓库拖拽经过
     */
    handleWarehouseDragOver(e, targetIndex) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }

    /**
     * 仓库放置
     */
    handleWarehouseDrop(e, targetIndex) {
        e.preventDefault();
        
        if (!this.draggedWarehouse || this.draggedWarehouse.index === targetIndex) {
            return;
        }
        
        // 移动仓库（跳过default）
        const sourceIndex = this.draggedWarehouse.index;
        const [movedWarehouse] = this.warehouseOrder.splice(sourceIndex, 1);
        
        // 调整目标索引
        const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        this.warehouseOrder.splice(adjustedTargetIndex, 0, movedWarehouse);
        
        // 确保default始终在第一位
        this.warehouseOrder = this.warehouseOrder.filter(w => w !== 'default');
        this.warehouseOrder.unshift('default');
        
        this.save();
        this.renderWarehouse();
    }

    /**
     * 仓库拖拽结束
     */
    handleWarehouseDragEnd() {
        this.draggedWarehouse = null;
        const draggingEls = document.querySelectorAll('.warehouse-item.dragging');
        draggingEls.forEach(el => el.classList.remove('dragging'));
    }
}

// 导出到全局
window.ModularPromptModule = ModularPromptModule;