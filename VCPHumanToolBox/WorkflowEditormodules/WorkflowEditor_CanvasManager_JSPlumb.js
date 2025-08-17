// WorkflowEditor Canvas Manager with JSPlumb integration
(function() {
    'use strict';

    class WorkflowEditor_CanvasManager {
        constructor() {
            if (WorkflowEditor_CanvasManager.instance) {
                return WorkflowEditor_CanvasManager.instance;
            }
            
            this.canvas = null;
            this.viewport = null;
            this.content = null;
            this.stateManager = null;
            this.jsPlumbInstance = null;
            
            // 节点管理
            this.nodes = new Map();
            this.connections = new Map();
            
            WorkflowEditor_CanvasManager.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_CanvasManager.instance) {
                WorkflowEditor_CanvasManager.instance = new WorkflowEditor_CanvasManager();
            }
            return WorkflowEditor_CanvasManager.instance;
        }

        // 初始化画布管理器
        init(stateManager) {
            this.stateManager = stateManager;
            this.canvas = document.getElementById('workflowCanvas');
            this.viewport = document.getElementById('canvasViewport');
            this.content = document.getElementById('canvasContent');
            
            this.initJSPlumb();
            this.bindEvents();
            
            console.log('[WorkflowEditor_CanvasManager] Initialized with JSPlumb');
        }

        // 初始化JSPlumb
        initJSPlumb() {
            // 检查JSPlumb是否可用
            if (typeof jsPlumb === 'undefined') {
                console.error('[CanvasManager] JSPlumb library not loaded');
                return;
            }

            // 创建JSPlumb实例
            this.jsPlumbInstance = jsPlumb.getInstance({
                Container: this.content,
                Connector: ['Bezier', { curviness: 50 }],
                PaintStyle: {
                    stroke: '#3b82f6',
                    strokeWidth: 2
                },
                HoverPaintStyle: {
                    stroke: '#1d4ed8',
                    strokeWidth: 3
                },
                EndpointStyle: {
                    fill: '#3b82f6',
                    stroke: '#1e40af',
                    strokeWidth: 2,
                    radius: 6
                },
                EndpointHoverStyle: {
                    fill: '#1d4ed8',
                    stroke: '#1e3a8a',
                    strokeWidth: 2,
                    radius: 8
                },
                Anchor: ['Left', 'Right'],
                Endpoint: ['Dot', { radius: 6 }],
                ConnectionOverlays: [
                    ['Arrow', {
                        location: 1,
                        visible: true,
                        width: 11,
                        length: 11,
                        id: 'arrow'
                    }]
                ],
                LogEnabled: false
            });

            // 绑定连接事件
            this.jsPlumbInstance.bind('connection', (info) => {
                this.handleConnectionCreated(info);
            });

            this.jsPlumbInstance.bind('connectionDetached', (info) => {
                this.handleConnectionDetached(info);
            });

            this.jsPlumbInstance.bind('click', (connection) => {
                this.handleConnectionClick(connection);
            });
        }

        // 绑定画布事件
        bindEvents() {
            if (!this.viewport) return;

            // 画布缩放和平移
            this.viewport.addEventListener('wheel', (e) => this.handleCanvasWheel(e));
            
            // 画布拖拽
            let isDraggingCanvas = false;
            let dragStart = { x: 0, y: 0 };

            this.viewport.addEventListener('mousedown', (e) => {
                if (e.target === this.viewport || e.target === this.content) {
                    isDraggingCanvas = true;
                    dragStart = { x: e.clientX, y: e.clientY };
                    this.viewport.style.cursor = 'grabbing';
                    
                    // 清除选择
                    this.stateManager.clearSelection();
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDraggingCanvas) {
                    const deltaX = e.clientX - dragStart.x;
                    const deltaY = e.clientY - dragStart.y;
                    const currentOffset = this.stateManager.getCanvasOffset();
                    
                    this.stateManager.setCanvasOffset({
                        x: currentOffset.x + deltaX,
                        y: currentOffset.y + deltaY
                    });
                    
                    dragStart = { x: e.clientX, y: e.clientY };
                }
            });

            document.addEventListener('mouseup', () => {
                if (isDraggingCanvas) {
                    isDraggingCanvas = false;
                    this.viewport.style.cursor = '';
                }
            });

        // 键盘事件
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));

        // 状态管理器事件
            if (this.stateManager) {
                this.stateManager.on('nodeAdded', (node) => this.renderNode(node));
                this.stateManager.on('nodeRemoved', (data) => this.removeNode(data.nodeId));
                this.stateManager.on('nodeUpdated', (data) => this.updateNode(data.nodeId, data.node));
                this.stateManager.on('connectionAdded', (connection) => this.createConnection(connection));
                this.stateManager.on('connectionRemoved', (data) => this.removeConnection(data.connectionId));
                this.stateManager.on('canvasOffsetChanged', () => this.updateCanvasTransform());
                this.stateManager.on('canvasZoomChanged', () => this.updateCanvasTransform());
                this.stateManager.on('selectionChanged', (data) => this.updateSelection(data));
            }
        }

        // 处理画布滚轮缩放
        handleCanvasWheel(e) {
            e.preventDefault();
            
            const rect = this.viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const currentZoom = this.stateManager.getCanvasZoom();
            const currentOffset = this.stateManager.getCanvasOffset();
            
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(3, currentZoom * zoomFactor));
            
            // 计算缩放中心点
            const zoomRatio = newZoom / currentZoom;
            const newOffset = {
                x: mouseX - (mouseX - currentOffset.x) * zoomRatio,
                y: mouseY - (mouseY - currentOffset.y) * zoomRatio
            };
            
            this.stateManager.setCanvasZoom(newZoom);
            this.stateManager.setCanvasOffset(newOffset);
        }

        // 处理键盘事件
        handleKeyDown(e) {
            if (!this.stateManager.get('isVisible')) return;

            const isCtrlOrCmd = e.ctrlKey || e.metaKey;

            if (isCtrlOrCmd && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                this.stateManager.undo();
            } else if (isCtrlOrCmd && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                this.stateManager.redo();
            } else {
                switch (e.key) {
                    case 'Delete':
                    case 'Backspace':
                        this.deleteSelected();
                        break;
                    case 'Escape':
                        this.stateManager.clearSelection();
                        break;
                    case 'a':
                    case 'A':
                        if (isCtrlOrCmd) {
                            e.preventDefault();
                            this.selectAll();
                        }
                        break;
                }
            }
        }

        // 渲染节点
        renderNode(node) {
            // 检查节点是否已经存在，避免重复渲染
            const existingNode = document.getElementById(node.id);
            if (existingNode) {
                console.log('[CanvasManager] Node already exists, removing old one:', node.id);
                this.removeNode(node.id);
            }

            const nodeElement = document.createElement('div');
            let nodeClasses = `canvas-node ${node.category === 'auxiliary' ? 'auxiliary' : ''}`;
            
            // 为URL渲染节点添加特殊类
            if (node.type === 'urlRenderer' || node.pluginId === 'urlRenderer') {
                nodeClasses += ' url-renderer';
            }
            
            nodeElement.className = nodeClasses;
            nodeElement.id = node.id; // 直接使用节点ID，不添加前缀
            nodeElement.setAttribute('data-node-id', node.id); // 添加数据属性
            nodeElement.style.left = node.position.x + 'px';
            nodeElement.style.top = node.position.y + 'px';
            nodeElement.style.position = 'absolute';
            
            nodeElement.innerHTML = `
                <div class="canvas-node-header">
                    <span class="canvas-node-icon">${this.getNodeIcon(node)}</span>
                    <span class="canvas-node-title">${node.name}</span>
                    <div class="canvas-node-status ${node.status || 'idle'}"></div>
                    <button class="canvas-node-remove-btn">×</button>
                </div>
                <div class="canvas-node-body">
                    <div class="canvas-node-desc">${this.getNodeDescription(node)}</div>
                </div>
            `;

            this.content.appendChild(nodeElement);
            this.nodes.set(node.id, nodeElement);

            // 使节点可拖拽
            this.makeNodeDraggable(nodeElement, node);
            
            // 添加连接点
            this.addEndpoints(nodeElement, node);
            
            // 绑定节点事件
            this.bindNodeEvents(nodeElement, node);

            console.log('[CanvasManager] Node rendered successfully:', node.id, node.name);
        }

        // 获取节点图标
        getNodeIcon(node) {
            const icons = {
                assistant: '🤖', music: '🎵', note: '📝', search: '🔍',
                TodoManager: '✅', FluxGen: '🎨', ComfyUIGen: '🖼️', 
                BilibiliFetch: '📺', VideoGenerator: '🎬',
                regex: '🔤', dataTransform: '🔄', codeEdit: '💻',
                condition: '🔀', loop: '🔁', delay: '⏱️', urlRenderer: '🖼️'
            };
            return icons[node.pluginId || node.type] || '⚙️';
        }

        // 获取节点描述
        getNodeDescription(node) {
            if (node.category === 'auxiliary') {
                const descriptions = {
                    regex: '正则表达式处理',
                    dataTransform: '数据格式转换',
                    codeEdit: '代码处理编辑',
                    condition: '条件分支判断',
                    loop: '循环执行控制',
                    delay: '延时等待执行'
                };
                return descriptions[node.pluginId] || '辅助处理节点';
            }
            return `${node.category === 'vcpChat' ? 'VCPChat' : 'VCPToolBox'} 插件`;
        }

        // 使节点可拖拽
        makeNodeDraggable(nodeElement, node) {
            if (!this.jsPlumbInstance) return;

            try {
                // 检查节点是否已经是可拖拽的，避免重复设置
                if (nodeElement.classList.contains('jtk-draggable')) {
                    console.log('[CanvasManager] Node already draggable:', node.id);
                    return;
                }

                this.jsPlumbInstance.draggable(nodeElement, {
                    containment: 'parent',
                    grid: [10, 10], // 网格对齐
                    force: true, // 强制启用拖拽，避免 force 属性未定义错误
                    start: (params) => {
                        // 选择节点
                        if (this.stateManager && this.stateManager.selectNode) {
                            this.stateManager.selectNode(node.id, params.e && (params.e.ctrlKey || params.e.metaKey));
                        }
                    },
                    drag: (params) => {
                        // 更新节点位置
                        if (this.stateManager && this.stateManager.updateNode) {
                            const newPos = {
                                x: parseInt(params.el.style.left) || 0,
                                y: parseInt(params.el.style.top) || 0
                            };
                            this.stateManager.updateNode(node.id, { position: newPos });
                        }
                    },
                    stop: (params) => {
                        // 拖拽结束
                        console.log(`[CanvasManager] Node ${node.id} moved to:`, {
                            x: parseInt(params.el.style.left) || 0,
                            y: parseInt(params.el.style.top) || 0
                        });
                    }
                });

                console.log('[CanvasManager] Node made draggable successfully:', node.id);
            } catch (error) {
                console.error('[CanvasManager] Error making node draggable:', error);
                console.error('Node element:', nodeElement);
                console.error('Node data:', node);
            }
        }

        // 添加连接点
        addEndpoints(nodeElement, node) {
            if (!this.jsPlumbInstance) return;

            console.log('[CanvasManager] Adding endpoints for node:', node.id, node.category);

            let inputEndpoint = null;
            let outputEndpoint = null;

            // 对于 'contentInput' 节点，只添加输出端点
            if (node.type === 'contentInput' || node.pluginId === 'contentInput') {
                console.log('[CanvasManager] Adding output-only endpoint for contentInput node:', node.id);
                outputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Right',
                    isSource: true,
                    isTarget: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#f59e0b', stroke: '#d97706' },
                    hoverPaintStyle: { fill: '#b45309', stroke: '#92400e' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dragOptions: { cursor: 'pointer', zIndex: 2000 }
                });
            } else {
                // 其他节点添加输入和输出端点
                console.log('[CanvasManager] Adding input and output endpoints for node:', node.id);
                inputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Left',
                    isTarget: true,
                    isSource: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#10b981', stroke: '#059669' },
                    hoverPaintStyle: { fill: '#047857', stroke: '#065f46' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dropOptions: { hoverClass: 'hover', activeClass: 'active' }
                });

                outputEndpoint = this.jsPlumbInstance.addEndpoint(nodeElement, {
                    anchor: 'Right',
                    isSource: true,
                    isTarget: false,
                    maxConnections: -1,
                    endpoint: ['Dot', { radius: 6 }],
                    paintStyle: { fill: '#f59e0b', stroke: '#d97706' },
                    hoverPaintStyle: { fill: '#b45309', stroke: '#92400e' },
                    connectorStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    connectorHoverStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    dragOptions: { cursor: 'pointer', zIndex: 2000 }
                });
            }

            // 存储端点引用
            nodeElement._inputEndpoint = inputEndpoint;
            nodeElement._outputEndpoint = outputEndpoint;

            // 为辅助节点确保端点正确设置 (现在已经包含在上面的逻辑中，但保留以防万一)
            if (node.category === 'auxiliary') {
                console.log('[CanvasManager] Setting up auxiliary node endpoints:', node.id);
                
                if (inputEndpoint) {
                    inputEndpoint.setVisible(true);
                    inputEndpoint.setEnabled(true);
                }
                
                if (outputEndpoint) {
                    outputEndpoint.setVisible(true);
                    outputEndpoint.setEnabled(true);
                }
            }

            console.log('[CanvasManager] Endpoints added successfully for node:', node.id);
        }

        // 绑定节点事件
        bindNodeEvents(nodeElement, node) {
            // 移除按钮事件
            const removeBtn = nodeElement.querySelector('.canvas-node-remove-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.stateManager.removeNode(node.id);
                });
            }

            // 单击选择
            nodeElement.addEventListener('click', (e) => {
                e.stopPropagation();
                // 避免在点击移除按钮时触发选择
                if (e.target !== removeBtn) {
                    this.stateManager.selectNode(node.id, e.ctrlKey || e.metaKey);
                }
            });

            // 双击编辑
            nodeElement.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.editNode(node.id);
            });

            // 右键菜单
            nodeElement.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showNodeContextMenu(e, node.id);
            });
        }

        // 创建连接
        createConnection(connectionData) {
            if (!this.jsPlumbInstance) {
                console.error('[CanvasManager] JSPlumb instance not available');
                return;
            }

            console.log('[CanvasManager] Creating connection:', connectionData);

            const sourceNode = this.nodes.get(connectionData.sourceNodeId);
            const targetNode = this.nodes.get(connectionData.targetNodeId);

            if (!sourceNode || !targetNode) {
                console.warn(`[CanvasManager] Nodes not ready for connection. Source: ${sourceNode ? 'found' : 'NOT FOUND'}, Target: ${targetNode ? 'found' : 'NOT FOUND'}`);
                console.log(`[CanvasManager] Available nodes:`, Array.from(this.nodes.keys()));
                
                // 延迟重试，增加重试次数和间隔
                let retryCount = 0;
                const maxRetries = 5;
                const retryInterval = 200;
                
                const retryConnection = () => {
                    retryCount++;
                    console.log(`[CanvasManager] Retry attempt ${retryCount}/${maxRetries} for connection ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId}`);
                    
                    const retrySourceNode = this.nodes.get(connectionData.sourceNodeId);
                    const retryTargetNode = this.nodes.get(connectionData.targetNodeId);
                    
                    if (retrySourceNode && retryTargetNode) {
                        console.log(`[CanvasManager] Retry ${retryCount} successful, creating connection`);
                        this.createConnectionInternal(connectionData, retrySourceNode, retryTargetNode);
                    } else if (retryCount < maxRetries) {
                        setTimeout(retryConnection, retryInterval);
                    } else {
                        console.error(`[CanvasManager] Failed to create connection after ${maxRetries} retries`);
                        console.error(`[CanvasManager] Missing nodes - Source: ${connectionData.sourceNodeId}, Target: ${connectionData.targetNodeId}`);
                    }
                };
                
                setTimeout(retryConnection, retryInterval);
                return;
            }

            this.createConnectionInternal(connectionData, sourceNode, targetNode);
        }

        // 内部连接创建方法
        createConnectionInternal(connectionData, sourceNode, targetNode) {
            try {
                // 检查是否已存在相同的连接ID，避免重复创建
                if (this.connections.has(connectionData.id)) {
                    console.log('[CanvasManager] Connection with same ID already exists, skipping creation:', connectionData.id);
                    return;
                }

                // 检查是否已存在相同的JSPlumb连接（基于源和目标节点）
                const existingJSPlumbConnection = Array.from(this.connections.values()).find(conn => {
                    if (!conn || !conn.source || !conn.target) return false;
                    
                    const connSourceId = conn.source.id || conn.sourceId;
                    const connTargetId = conn.target.id || conn.targetId;
                    
                    return connSourceId === sourceNode.id && connTargetId === targetNode.id;
                });
                
                if (existingJSPlumbConnection) {
                    console.log('[CanvasManager] JSPlumb connection already exists between nodes, skipping creation');
                    return;
                }

                // 确保节点已经被JSPlumb管理，使用更安全的方式
                try {
                    // 检查节点是否已经有拖拽功能，如果没有则添加
                    if (!sourceNode.classList.contains('jtk-draggable')) {
                        console.log('[CanvasManager] Making source node draggable:', sourceNode.id);
                        this.jsPlumbInstance.draggable(sourceNode, {
                            containment: 'parent',
                            grid: [10, 10],
                            force: true // 强制启用拖拽
                        });
                    }
                    
                    if (!targetNode.classList.contains('jtk-draggable')) {
                        console.log('[CanvasManager] Making target node draggable:', targetNode.id);
                        this.jsPlumbInstance.draggable(targetNode, {
                            containment: 'parent',
                            grid: [10, 10],
                            force: true // 强制启用拖拽
                        });
                    }
                } catch (dragError) {
                    console.warn('[CanvasManager] Error making nodes draggable:', dragError);
                    // 继续尝试创建连接，即使拖拽设置失败
                }

                // 使用更安全的连接创建方式
                const connection = this.jsPlumbInstance.connect({
                    source: sourceNode,
                    target: targetNode,
                    anchor: ['Right', 'Left'],
                    connector: ['Bezier', { curviness: 50 }],
                    paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                    hoverPaintStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                    overlays: [
                        ['Arrow', {
                            location: 1,
                            visible: true,
                            width: 11,
                            length: 11,
                            id: 'arrow'
                        }]
                    ],
                    // 添加连接参数以避免JSPlumb内部错误
                    parameters: {
                        connectionId: connectionData.id,
                        sourceNodeId: connectionData.sourceNodeId,
                        targetNodeId: connectionData.targetNodeId
                    },
                    // 确保连接不会触发事件处理
                    doNotFireConnectionEvent: false
                });

                if (connection) {
                    // 标记为程序化创建的连接，避免触发handleConnectionCreated
                    connection._programmaticConnection = true;
                    connection.connectionId = connectionData.id;
                    this.connections.set(connectionData.id, connection);
                    console.log(`[CanvasManager] Connection created successfully: ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId}`);
                } else {
                    console.error('[CanvasManager] JSPlumb connect returned null/undefined');
                }
            } catch (error) {
                console.error('[CanvasManager] Error creating connection:', error);
                console.error('Connection data:', connectionData);
                console.error('Source node:', sourceNode);
                console.error('Target node:', targetNode);
                
                // 如果连接创建失败，尝试延迟重试一次
                setTimeout(() => {
                    console.log('[CanvasManager] Retrying connection creation after error...');
                    try {
                        const retryConnection = this.jsPlumbInstance.connect({
                            source: sourceNode,
                            target: targetNode,
                            anchor: ['Right', 'Left'],
                            connector: ['Bezier', { curviness: 50 }],
                            paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                            parameters: {
                                connectionId: connectionData.id,
                                sourceNodeId: connectionData.sourceNodeId,
                                targetNodeId: connectionData.targetNodeId
                            },
                            doNotFireConnectionEvent: false
                        });
                        
                        if (retryConnection) {
                            retryConnection._programmaticConnection = true;
                            retryConnection.connectionId = connectionData.id;
                            this.connections.set(connectionData.id, retryConnection);
                            console.log('[CanvasManager] Connection retry successful');
                        }
                    } catch (retryError) {
                        console.error('[CanvasManager] Connection retry also failed:', retryError);
                    }
                }, 500);
            }
        }

        // 处理连接创建
        handleConnectionCreated(info) {
            console.log('[CanvasManager] Connection created event:', info);
            
            // 检查是否是程序化创建的连接（避免重复处理）
            if (info.connection._programmaticConnection) {
                console.log('[CanvasManager] Skipping programmatic connection event');
                return;
            }
            
            try {
                // 更强健的节点ID获取逻辑
                let sourceNodeId, targetNodeId;
                let sourceParam = 'output', targetParam = 'input';

                // 从源端点获取节点ID
                if (info.sourceEndpoint && info.sourceEndpoint.nodeId) {
                    sourceNodeId = info.sourceEndpoint.nodeId;
                } else if (info.source) {
                    // 如果源是节点元素本身
                    if (info.source.classList && info.source.classList.contains('canvas-node')) {
                        sourceNodeId = info.source.id;
                    } else {
                        // 向上查找节点容器
                        let nodeElement = info.source;
                        while (nodeElement && !nodeElement.classList.contains('canvas-node')) {
                            nodeElement = nodeElement.parentElement;
                        }
                        if (nodeElement && nodeElement.id) {
                            sourceNodeId = nodeElement.id;
                        }
                    }
                }

                // 从目标端点获取节点ID和参数名
                if (info.targetEndpoint && info.targetEndpoint.nodeId) {
                    targetNodeId = info.targetEndpoint.nodeId;
                    if (info.targetEndpoint.paramName) {
                        targetParam = info.targetEndpoint.paramName;
                    }
                } else if (info.target) {
                    // 检查目标是否有节点ID属性
                    if (info.target.hasAttribute('data-node-id')) {
                        targetNodeId = info.target.getAttribute('data-node-id');
                        if (info.target.hasAttribute('data-param-name')) {
                            targetParam = info.target.getAttribute('data-param-name');
                        }
                    } else if (info.target.classList && info.target.classList.contains('canvas-node')) {
                        targetNodeId = info.target.id;
                    } else {
                        // 向上查找节点容器
                        let nodeElement = info.target;
                        while (nodeElement && !nodeElement.classList.contains('canvas-node')) {
                            nodeElement = nodeElement.parentElement;
                        }
                        if (nodeElement && nodeElement.id) {
                            targetNodeId = nodeElement.id;
                        }
                    }
                }

                console.log(`[CanvasManager] Resolved IDs - Source: ${sourceNodeId}, Target: ${targetNodeId}`);
                console.log(`[CanvasManager] Parameters - Source: ${sourceParam}, Target: ${targetParam}`);

                // 验证节点ID是否有效
                if (!sourceNodeId || !targetNodeId) {
                    console.error('[CanvasManager] Could not resolve node IDs');
                    console.error('Source element:', info.source);
                    console.error('Target element:', info.target);
                    console.error('Source endpoint:', info.sourceEndpoint);
                    console.error('Target endpoint:', info.targetEndpoint);
                    return;
                }

                // 验证节点是否存在于状态管理器中
                if (!this.nodes.has(sourceNodeId) || !this.nodes.has(targetNodeId)) {
                    console.error(`[CanvasManager] Nodes not found in canvas - source: ${sourceNodeId}, target: ${targetNodeId}`);
                    console.log('[CanvasManager] Available nodes:', Array.from(this.nodes.keys()));
                    return;
                }

                // 检查是否已存在相同的连接
                const existingConnections = this.stateManager.getAllConnections();
                const isDuplicate = existingConnections.some(conn => 
                    conn.sourceNodeId === sourceNodeId && 
                    conn.targetNodeId === targetNodeId &&
                    conn.targetParam === targetParam
                );

                if (isDuplicate) {
                    console.log('[CanvasManager] Duplicate connection detected, removing JSPlumb connection');
                    this.jsPlumbInstance.deleteConnection(info.connection);
                    return;
                }

                // 创建连接数据
                const connectionData = {
                    id: `${sourceNodeId}_${targetNodeId}_${Date.now()}`,
                    sourceNodeId: sourceNodeId,
                    targetNodeId: targetNodeId,
                    sourceParam: sourceParam,
                    targetParam: targetParam
                };

                console.log('[CanvasManager] Creating connection:', connectionData);

                // 标记连接ID到JSPlumb连接对象
                info.connection.connectionId = connectionData.id;
                this.connections.set(connectionData.id, info.connection);

                // 通过状态管理器添加连接（但不触发视觉创建, 但记录历史）
                if (this.stateManager && this.stateManager.addConnection) {
                    // 调用 addConnection，它会记录历史，但通过 skipRender=true 避免重复渲染
                    this.stateManager.addConnection(connectionData, true, true);
                } else {
                    console.error('[CanvasManager] StateManager or addConnection method not available');
                }

            } catch (error) {
                console.error('[CanvasManager] Error handling connection creation:', error);
                console.error('Error details:', error.stack);
            }
        }

        // 处理连接断开
        handleConnectionDetached(info) {
            console.log('[CanvasManager] Connection detached:', info);
            
            // 检查是否是程序化删除的连接（避免重复处理）
            if (info.connection._programmaticDelete) {
                console.log('[CanvasManager] Skipping programmatic delete event');
                return;
            }
            
            try {
                if (info.connection.connectionId) {
                    console.log('[CanvasManager] Removing connection from state:', info.connection.connectionId);
                    
                    // 从内部连接映射中移除
                    this.connections.delete(info.connection.connectionId);
                    
                    // 通知状态管理器移除连接
                    if (this.stateManager && this.stateManager.removeConnection) {
                        // 调用 removeConnection，它会记录历史
                        this.stateManager.removeConnection(info.connection.connectionId, true);
                    }
                } else {
                    console.warn('[CanvasManager] Connection detached without ID');
                }
            } catch (error) {
                console.error('[CanvasManager] Error handling connection detached:', error);
            }
        }

        // 处理连接点击
        handleConnectionClick(connection) {
            // 选择连接线
            console.log('[CanvasManager] Connection clicked:', connection.connectionId);
        }

        // 移除节点
        removeNode(nodeId) {
            const nodeElement = this.nodes.get(nodeId);
            if (nodeElement) {
                // 移除JSPlumb管理的连接和端点
                if (this.jsPlumbInstance) {
                    this.jsPlumbInstance.remove(nodeElement);
                }
                
                // 从DOM中移除
                if (nodeElement.parentNode) {
                    nodeElement.parentNode.removeChild(nodeElement);
                }
                
                this.nodes.delete(nodeId);
            }
        }

        // 更新节点
        updateNode(nodeId, nodeData) {
            const nodeElement = this.nodes.get(nodeId);
            if (nodeElement && nodeData.position) {
                nodeElement.style.left = nodeData.position.x + 'px';
                nodeElement.style.top = nodeData.position.y + 'px';
                
                // 重绘连接线
                if (this.jsPlumbInstance) {
                    this.jsPlumbInstance.revalidate(nodeElement);
                }
            }
        }

        // 移除连接
        removeConnection(connectionId) {
            console.log('[CanvasManager] Removing connection:', connectionId);
            
            const connection = this.connections.get(connectionId);
            if (connection && this.jsPlumbInstance) {
                try {
                    // 检查连接对象是否有效
                    if (connection && typeof connection === 'object') {
                        this.jsPlumbInstance.deleteConnection(connection);
                        console.log('[CanvasManager] Connection deleted from JSPlumb');
                    } else {
                        console.warn('[CanvasManager] Invalid connection object:', connection);
                    }
                } catch (error) {
                    console.warn('[CanvasManager] Error deleting connection from JSPlumb:', error);
                    // 即使JSPlumb删除失败，也要清理内部状态
                }
                
                this.connections.delete(connectionId);
                console.log('[CanvasManager] Connection removed from internal state');
            } else {
                console.warn('[CanvasManager] Connection not found or JSPlumb not available:', {
                    connectionId,
                    connectionExists: !!connection,
                    jsPlumbExists: !!this.jsPlumbInstance
                });
                
                // 确保从内部状态中移除，即使连接对象不存在
                this.connections.delete(connectionId);
            }
        }

        // 更新画布变换
        updateCanvasTransform() {
            if (!this.content) return;
            
            const offset = this.stateManager.getCanvasOffset();
            const zoom = this.stateManager.getCanvasZoom();
            
            this.content.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
            
            // 重绘所有连接线
            if (this.jsPlumbInstance) {
                this.jsPlumbInstance.repaintEverything();
            }
        }

        // 更新选择状态
        updateSelection(data) {
            this.nodes.forEach((nodeElement, nodeId) => {
                if (data.selectedNodes.includes(nodeId)) {
                    nodeElement.classList.add('selected');
                } else {
                    nodeElement.classList.remove('selected');
                }
            });
        }

        // 删除选中的元素
        deleteSelected() {
            const selectedNodes = this.stateManager.getSelectedNodes();
            selectedNodes.forEach(nodeId => {
                this.stateManager.removeNode(nodeId);
            });
        }

        // 全选
        selectAll() {
            const allNodes = this.stateManager.getAllNodes();
            allNodes.forEach(node => {
                this.stateManager.selectNode(node.id, true);
            });
        }

        // 编辑节点
        editNode(nodeId) {
            const node = this.stateManager.getNode(nodeId);
            if (!node) return;
            if (window.WorkflowEditor_UIManager && window.WorkflowEditor_UIManager.renderPropertiesPanel) {
                window.WorkflowEditor_UIManager.renderPropertiesPanel(node);
            }
        }

        // 更新节点输入端点
        updateNodeInputs(nodeId, dynamicInputs) {
            console.log('[CanvasManager_JSPlumb] Updating node inputs for:', nodeId, dynamicInputs);
            
            const nodeElement = document.getElementById(nodeId);
            if (!nodeElement) {
                console.warn('[CanvasManager_JSPlumb] Node element not found:', nodeId);
                return;
            }

            // 移除现有的动态参数容器
            const existingParamsContainer = nodeElement.querySelector('.node-params-container');
            if (existingParamsContainer) {
                // 移除所有动态端点
                const dynamicEndpoints = existingParamsContainer.querySelectorAll('.param-endpoint');
                dynamicEndpoints.forEach(endpoint => {
                    if (this.jsPlumbInstance) {
                        this.jsPlumbInstance.removeAllEndpoints(endpoint);
                    }
                });
                existingParamsContainer.remove();
            }

            // 如果有动态输入参数，隐藏原有输入端点并创建参数输入框
            if (dynamicInputs && Array.isArray(dynamicInputs) && dynamicInputs.length > 0) {
                // 隐藏原有的输入端点
                if (nodeElement._inputEndpoint) {
                    nodeElement._inputEndpoint.setVisible(false);
                }

                const nodeBody = nodeElement.querySelector('.canvas-node-body');
                if (!nodeBody) return;

                // 创建参数容器
                const paramsContainer = document.createElement('div');
                paramsContainer.className = 'node-params-container';
                paramsContainer.style.cssText = `
                    margin-top: 8px;
                    padding: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                `;

                // 为每个参数创建输入框
                dynamicInputs.forEach((input, index) => {
                    const paramWrapper = document.createElement('div');
                    paramWrapper.className = 'param-wrapper';
                    paramWrapper.style.cssText = `
                        position: relative;
                        display: flex;
                        align-items: center;
                        margin-left: 12px;
                    `;

                    // 创建参数输入框
                    const paramInput = document.createElement('div');
                    paramInput.className = 'param-input-box';
                    paramInput.setAttribute('data-param', input.name);
                    paramInput.style.cssText = `
                        flex: 1;
                        padding: 6px 8px;
                        background: rgba(255, 255, 255, 0.1);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 3px;
                        font-size: 12px;
                        color: #e2e8f0;
                        text-align: center;
                        min-height: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    `;
                    paramInput.textContent = input.name;

                    paramWrapper.appendChild(paramInput);
                    paramsContainer.appendChild(paramWrapper);

                    // 直接在输入框上添加JSPlumb端点
                    if (this.jsPlumbInstance) {
                        const endpoint = this.jsPlumbInstance.addEndpoint(paramInput, {
                            anchor: 'Left',
                            endpoint: 'Dot',
                            paintStyle: {
                                fill: '#333',
                                stroke: '#666',
                                strokeWidth: 1,
                                radius: 4
                            },
                            hoverPaintStyle: {
                                fill: '#555',
                                stroke: '#888',
                                strokeWidth: 1,
                                radius: 5
                            },
                            isTarget: true,
                            maxConnections: -1, // 允许无限连接，确保端点不会因连接断开而消失
                            connectorStyle: { 
                                stroke: '#3b82f6', 
                                strokeWidth: 2 
                            },
                            connectorHoverStyle: { 
                                stroke: '#1d4ed8', 
                                strokeWidth: 3 
                            }
                        });

                        // 为端点添加节点ID信息，便于连接时识别
                        if (endpoint) {
                            endpoint.nodeId = nodeId;
                            endpoint.paramName = input.name;
                            // 确保端点元素有正确的节点关联
                            paramInput.setAttribute('data-node-id', nodeId);
                            paramInput.setAttribute('data-param-name', input.name);
                        }
                    }
                });

                nodeBody.appendChild(paramsContainer);
            } else {
                // 如果没有动态输入参数，显示原有的输入端点
                if (nodeElement._inputEndpoint) {
                    nodeElement._inputEndpoint.setVisible(true);
                }
            }

            // 更新节点的dynamicInputs属性
            const node = this.stateManager.getNode(nodeId);
            if (node) {
                node.dynamicInputs = dynamicInputs;
                this.stateManager.updateNode(nodeId, { dynamicInputs });
            }

            console.log('[CanvasManager_JSPlumb] Node inputs updated successfully');
        }

        // 显示节点右键菜单
        showNodeContextMenu(e, nodeId) {
            console.log('[CanvasManager] Show context menu for node:', nodeId);
            // TODO: 实现右键菜单
        }

        // 清空画布
        clear() {
            console.log('[CanvasManager] Clearing canvas...');
            
            // 先移除所有JSPlumb管理的连接和端点
            if (this.jsPlumbInstance) {
                try {
                    this.jsPlumbInstance.deleteEveryConnection();
                    this.jsPlumbInstance.deleteEveryEndpoint();
                    
                    // 清除所有拖拽元素
                    this.nodes.forEach((nodeElement) => {
                        if (nodeElement) {
                            try {
                                this.jsPlumbInstance.remove(nodeElement);
                            } catch (e) {
                                console.warn('[CanvasManager] Error removing JSPlumb element:', e);
                            }
                        }
                    });
                } catch (error) {
                    console.warn('[CanvasManager] Error clearing JSPlumb elements:', error);
                }
            }
            
            // 清空内部状态
            this.nodes.clear();
            this.connections.clear();
            
            // 清空DOM内容
            if (this.content) {
                // 确保彻底清空所有子元素
                while (this.content.firstChild) {
                    this.content.removeChild(this.content.firstChild);
                }
                this.content.innerHTML = '';
            }
            
            console.log('[CanvasManager] Canvas cleared successfully');
        }

        // 恢复连接（专门用于工作流加载，避免重复检测）
        restoreConnections(connections) {
            console.log('[CanvasManager] Restoring connections:', connections.length);
            
            if (!this.jsPlumbInstance) {
                console.error('[CanvasManager] JSPlumb instance not available for connection restoration');
                return;
            }

            connections.forEach((connectionData, index) => {
                setTimeout(() => {
                    console.log(`[CanvasManager] Restoring connection ${index + 1}/${connections.length}:`, connectionData.id);
                    
                    const sourceNode = this.nodes.get(connectionData.sourceNodeId);
                    const targetNode = this.nodes.get(connectionData.targetNodeId);

                    if (!sourceNode || !targetNode) {
                        console.warn(`[CanvasManager] Cannot restore connection - nodes not found. Source: ${connectionData.sourceNodeId}, Target: ${connectionData.targetNodeId}`);
                        return;
                    }

                    // 检查连接是否已经存在
                    if (this.connections.has(connectionData.id)) {
                        console.log('[CanvasManager] Connection already restored:', connectionData.id);
                        return;
                    }

                    try {
                        // 直接创建JSPlumb连接，不触发事件处理
                        const connection = this.jsPlumbInstance.connect({
                            source: sourceNode,
                            target: targetNode,
                            anchor: ['Right', 'Left'],
                            connector: ['Bezier', { curviness: 50 }],
                            paintStyle: { stroke: '#3b82f6', strokeWidth: 2 },
                            hoverPaintStyle: { stroke: '#1d4ed8', strokeWidth: 3 },
                            overlays: [
                                ['Arrow', {
                                    location: 1,
                                    visible: true,
                                    width: 11,
                                    length: 11,
                                    id: 'arrow'
                                }]
                            ],
                            parameters: {
                                connectionId: connectionData.id,
                                sourceNodeId: connectionData.sourceNodeId,
                                targetNodeId: connectionData.targetNodeId
                            },
                            // 关键：不触发连接事件，避免重复检测
                            doNotFireConnectionEvent: true
                        });

                        if (connection) {
                            // 标记为恢复的连接，避免被重复检测删除
                            connection._restoredConnection = true;
                            connection._programmaticConnection = true;
                            connection.connectionId = connectionData.id;
                            this.connections.set(connectionData.id, connection);
                            console.log(`[CanvasManager] Connection restored successfully: ${connectionData.sourceNodeId} -> ${connectionData.targetNodeId}`);
                        } else {
                            console.error('[CanvasManager] Failed to restore connection:', connectionData.id);
                        }
                    } catch (error) {
                        console.error('[CanvasManager] Error restoring connection:', error, connectionData);
                    }
                }, index * 100); // 每个连接间隔100ms，避免并发问题
            });
        }

        // 获取画布数据
        getCanvasData() {
            return {
                nodes: Array.from(this.nodes.keys()),
                connections: Array.from(this.connections.keys())
            };
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_CanvasManager = WorkflowEditor_CanvasManager.getInstance();
})();