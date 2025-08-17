// WorkflowEditor Execution Engine
(function() {
    'use strict';

    class WorkflowEditor_ExecutionEngine {
        constructor() {
            if (WorkflowEditor_ExecutionEngine.instance) {
                return WorkflowEditor_ExecutionEngine.instance;
            }
            
            this.stateManager = null;
            this.pluginManager = null;
            this.isExecuting = false;
            this.executionQueue = [];
            this.nodeResults = new Map(); // 存储节点执行结果
            this.nodeInputData = new Map(); // 存储节点输入数据
            
            // 从 settings.json 读取配置
            this.loadSettings();
            
            WorkflowEditor_ExecutionEngine.instance = this;
        }

        static getInstance() {
            if (!WorkflowEditor_ExecutionEngine.instance) {
                WorkflowEditor_ExecutionEngine.instance = new WorkflowEditor_ExecutionEngine();
            }
            return WorkflowEditor_ExecutionEngine.instance;
        }

        // 初始化执行引擎
        init(stateManager, pluginManager) {
            this.stateManager = stateManager;
            this.pluginManager = pluginManager;
            
            console.log('[ExecutionEngine] Initialized');
        }

        // 从 settings.json 加载配置
        loadSettings() {
            try {
                const fs = require('fs');
                const path = require('path');
                const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');
                const settingsData = fs.readFileSync(settingsPath, 'utf8');
                const settings = JSON.parse(settingsData);
                
                if (settings.vcpServerUrl) {
                    const url = new URL(settings.vcpServerUrl);
                    url.pathname = '/v1/human/tool';
                    this.VCP_SERVER_URL = url.toString();
                }
                this.VCP_API_KEY = settings.vcpApiKey || '';
                this.USER_NAME = settings.userName || 'Human';
                
                console.log('[ExecutionEngine] Settings loaded');
            } catch (error) {
                console.error('[ExecutionEngine] Failed to load settings:', error);
            }
        }

        // 开始执行工作流
        async executeWorkflow() {
            if (this.isExecuting) {
                console.warn('[ExecutionEngine] Workflow is already executing');
                return;
            }

            if (!this.VCP_SERVER_URL || !this.VCP_API_KEY) {
                throw new Error('VCP服务器配置未找到，请检查settings.json');
            }

            this.isExecuting = true;
            this.nodeResults.clear();
            this.nodeInputData.clear();
            
            try {
                console.log('[ExecutionEngine] Starting workflow execution');
                
                // 获取所有节点和连接
                const nodes = this.stateManager.getAllNodes();
                const connections = this.stateManager.getAllConnections();
                
                // 构建执行图
                const executionGraph = this.buildExecutionGraph(nodes, connections);
                
                // 找到起始节点（没有输入连接的节点）
                const startNodes = this.findStartNodes(nodes, connections);
                
                if (startNodes.length === 0) {
                    throw new Error('未找到起始节点，请确保工作流有至少一个没有输入连接的节点');
                }
                
                // 初始化节点输入数据
                this.initializeNodeInputData(nodes);
                
                // 从起始节点开始执行
                for (const startNode of startNodes) {
                    await this.executeNodeChain(startNode, executionGraph);
                }
                
                console.log('[ExecutionEngine] Workflow execution completed');
                
            } catch (error) {
                console.error('[ExecutionEngine] Workflow execution failed:', error);
                throw error;
            } finally {
                this.isExecuting = false;
            }
        }

        // 构建执行图
        buildExecutionGraph(nodes, connections) {
            const graph = new Map();
            
            // 初始化图节点
            nodes.forEach(node => {
                graph.set(node.id, {
                    node: node,
                    inputs: [], // 输入连接
                    outputs: [] // 输出连接
                });
            });
            
            // 添加连接关系
            connections.forEach(connection => {
                const sourceGraphNode = graph.get(connection.sourceNodeId);
                const targetGraphNode = graph.get(connection.targetNodeId);
                
                if (sourceGraphNode && targetGraphNode) {
                    sourceGraphNode.outputs.push({
                        targetNodeId: connection.targetNodeId,
                        targetPort: connection.targetPort,
                        connection: connection
                    });
                    
                    targetGraphNode.inputs.push({
                        sourceNodeId: connection.sourceNodeId,
                        sourcePort: connection.sourcePort,
                        targetPort: connection.targetPort,
                        connection: connection
                    });
                }
            });
            
            return graph;
        }

        // 找到起始节点
        findStartNodes(nodes, connections) {
            const nodesWithInputs = new Set();
            connections.forEach(conn => {
                nodesWithInputs.add(conn.targetNodeId);
            });
            
            return nodes.filter(node => !nodesWithInputs.has(node.id));
        }

        // 初始化节点输入数据
        initializeNodeInputData(nodes) {
            nodes.forEach(node => {
                const inputData = {};
                
                // 如果节点有动态输入参数，初始化这些参数
                if (node.dynamicInputs && Array.isArray(node.dynamicInputs)) {
                    node.dynamicInputs.forEach(input => {
                        inputData[input.name] = null;
                    });
                }
                
                this.nodeInputData.set(node.id, inputData);
            });
        }

        // 执行节点链 - 使用拓扑排序避免循环依赖问题
        async executeNodeChain(startNode, executionGraph) {
            console.log(`[ExecutionEngine] 开始执行节点链，起始节点: ${startNode.id}`);
            
            // 使用队列进行广度优先执行
            const executionQueue = [startNode.id];
            const executed = new Set();
            const executing = new Set();
            
            while (executionQueue.length > 0) {
                const nodeId = executionQueue.shift();
                
                // 跳过已执行的节点
                if (executed.has(nodeId)) {
                    continue;
                }
                
                // 检查循环依赖
                if (executing.has(nodeId)) {
                    console.warn(`[ExecutionEngine] 跳过正在执行的节点: ${nodeId}`);
                    continue;
                }
                
                const graphNode = executionGraph.get(nodeId);
                if (!graphNode) {
                    console.error(`[ExecutionEngine] 节点 ${nodeId} 不存在`);
                    continue;
                }
                
                // 检查所有输入节点是否已执行
                const allInputsReady = graphNode.inputs.every(input => executed.has(input.sourceNodeId));
                
                if (!allInputsReady) {
                    // 将节点重新加入队列末尾，等待输入节点执行完成
                    executionQueue.push(nodeId);
                    continue;
                }
                
                // 收集输入数据
                this.collectInputData(nodeId, graphNode);
                
                // 检查是否所有必需参数都已准备好
                if (this.areRequiredInputsReady(nodeId, graphNode.node)) {
                    executing.add(nodeId);
                    
                    try {
                        // 执行节点
                        await this.executeNode(graphNode.node);
                        
                        // 传播输出数据到下游节点
                        this.propagateOutputData(nodeId, graphNode);
                        
                        // 将下游节点加入执行队列
                        graphNode.outputs.forEach(output => {
                            if (!executed.has(output.targetNodeId) && !executionQueue.includes(output.targetNodeId)) {
                                console.log(`[ExecutionEngine] 将下游节点加入队列: ${output.targetNodeId}`);
                                executionQueue.push(output.targetNodeId);
                            }
                        });
                        
                        executed.add(nodeId);
                        console.log(`[ExecutionEngine] 节点 ${nodeId} 执行完成`);
                        
                    } catch (error) {
                        console.error(`[ExecutionEngine] 节点 ${nodeId} 执行失败:`, error);
                        throw error;
                    } finally {
                        executing.delete(nodeId);
                    }
                } else {
                    console.log(`[ExecutionEngine] 节点 ${nodeId} 输入未准备好，跳过执行`);
                    executed.add(nodeId); // 标记为已处理，避免无限循环
                }
            }
            
            console.log(`[ExecutionEngine] 节点链执行完成，已执行节点:`, Array.from(executed));
        }

        // 收集输入数据
        // 收集输入数据
        collectInputData(nodeId, graphNode) {
            const inputData = this.nodeInputData.get(nodeId) || {};
            
            graphNode.inputs.forEach(input => {
                const sourceResult = this.nodeResults.get(input.sourceNodeId);
                if (sourceResult) {
                    // 解析JSON数据并支持字段访问
                    const processedData = this.processInputData(sourceResult);
                    
                    // 确保目标参数名有效，避免undefined键
                    const targetParam = input.targetPort || input.connection?.targetParam || 'input';
                    
                    console.log(`[ExecutionEngine] 收集输入数据: ${input.sourceNodeId} -> ${nodeId}, 参数: ${targetParam}`);
                    
                    // 只有当目标参数名有效时才设置数据
                    if (targetParam && targetParam !== 'undefined') {
                        inputData[targetParam] = processedData;
                    } else {
                        console.warn(`[ExecutionEngine] 跳过无效的目标参数名: ${targetParam}`);
                    }
                }
            });
            
            this.nodeInputData.set(nodeId, inputData);
        }

        // 检查必需输入是否准备好
        areRequiredInputsReady(nodeId, node) {
            const inputData = this.nodeInputData.get(nodeId) || {};
            const nodeConfig = node.config || {};
            
            console.log(`[ExecutionEngine] 检查节点 ${nodeId} 的输入准备状态:`);
            console.log(`[ExecutionEngine] - 输入数据:`, inputData);
            console.log(`[ExecutionEngine] - 节点配置:`, nodeConfig);
            console.log(`[ExecutionEngine] - 动态输入:`, node.dynamicInputs);
            
            // 如果没有动态输入参数，检查节点配置是否有必需的参数
            if (!node.dynamicInputs || !Array.isArray(node.dynamicInputs)) {
                console.log(`[ExecutionEngine] 节点 ${nodeId} 没有动态输入，检查配置参数`);
                
                // 对于文件操作节点，检查基本配置
                if (node.pluginId === 'FileOperator') {
                    // 如果配置中有url或从输入数据中获取到url，则认为准备就绪
                    const hasUrl = nodeConfig.url || inputData.url;
                    const hasDownloadDir = nodeConfig.downloadDir || inputData.downloadDir;
                    
                    console.log(`[ExecutionEngine] FileOperator 节点检查: url=${hasUrl}, downloadDir=${hasDownloadDir}`);
                    
                    if (!hasUrl && !hasDownloadDir) {
                        console.log(`[ExecutionEngine] FileOperator 节点缺少必要参数`);
                        return false;
                    }
                }
                
                return true;
            }
            
            // 检查所有必需参数是否都有数据
            for (const input of node.dynamicInputs) {
                const hasInputData = inputData[input.name] !== null && inputData[input.name] !== undefined && inputData[input.name] !== '';
                const hasConfigData = nodeConfig[input.name] !== null && nodeConfig[input.name] !== undefined && nodeConfig[input.name] !== '';
                
                console.log(`[ExecutionEngine] 检查参数 ${input.name}: required=${input.required}, hasInputData=${hasInputData}, hasConfigData=${hasConfigData}`);
                
                if (input.required && !hasInputData && !hasConfigData) {
                    console.log(`[ExecutionEngine] Node ${nodeId} waiting for required input: ${input.name}`);
                    return false;
                }
            }
            
            console.log(`[ExecutionEngine] 节点 ${nodeId} 所有必需输入已准备就绪`);
            return true;
        }

        // 执行单个节点
        async executeNode(node) {
            console.log(`[ExecutionEngine] Executing node: ${node.id} (${node.name})`);
            
            // 更新节点状态为执行中
            this.updateNodeStatus(node.id, 'running');
            
            try {
                let result;
                
                if (node.category === 'auxiliary') {
                    // 辅助节点的处理
                    result = await this.executeAuxiliaryNode(node);
                } else {
                    // 插件节点的处理
                    result = await this.executePluginNode(node);
                }
                
                // 存储执行结果
                this.nodeResults.set(node.id, result);
                
                // 更新节点状态为成功
                this.updateNodeStatus(node.id, 'success');
                
                console.log(`[ExecutionEngine] Node ${node.id} executed successfully`);
                
            } catch (error) {
                console.error(`[ExecutionEngine] Node ${node.id} execution failed:`, error);
                
                // 更新节点状态为失败
                this.updateNodeStatus(node.id, 'error');
                
                throw error;
            }
        }

        // 执行辅助节点
        async executeAuxiliaryNode(node) {
            const inputData = this.nodeInputData.get(node.id) || {};
            
            switch (node.pluginId) {
                case 'textDisplay':
                    return this.executeTextDisplayNode(node, inputData);
                case 'imageDisplay':
                    return this.executeImageDisplayNode(node, inputData);
                case 'htmlDisplay':
                    return this.executeHtmlDisplayNode(node, inputData);
                case 'jsonDisplay':
                    return this.executeJsonDisplayNode(node, inputData);
                case 'urlRenderer':
                    return this.executeUrlRendererNode(node, inputData);
                case 'regex':
                    return this.executeRegexNode(node, inputData);
                case 'dataTransform':
                    return this.executeDataTransformNode(node, inputData);
                case 'condition':
                    return this.executeConditionNode(inputData);
                case 'delay':
                    return this.executeDelayNode(inputData);
                case 'contentInput': // 新增内容输入器节点类型
                    return this.executeContentInputNode(node);
                default:
                    throw new Error(`未知的辅助节点类型: ${node.pluginId}`);
            }
        }

        // 执行内容输入器节点
        async executeContentInputNode(node) {
            console.log(`[ExecutionEngine] 执行内容输入器节点: ${node.id}`);
            const content = node.config && node.config.content !== undefined ? node.config.content : '';
            // 从节点配置中获取自定义输出参数名，如果未设置则默认为 'output'
            const outputParamName = node.config && node.config.outputParamName ? node.config.outputParamName : 'output';
            
            console.log(`[ExecutionEngine] 内容输入器输出内容: ${content} (使用参数名: ${outputParamName})`);
            
            // 使用自定义的参数名作为输出对象的键
            const result = {};
            result[outputParamName] = content;
            return result;
        }

        // 执行插件节点
        async executePluginNode(node) {
            const inputData = this.nodeInputData.get(node.id) || {};
            
            console.log(`[ExecutionEngine] 开始执行插件节点 ${node.id} (${node.name})`);
            console.log(`[ExecutionEngine] 节点配置:`, node.config);
            console.log(`[ExecutionEngine] 输入数据:`, inputData);
            
            // 合并节点配置和输入数据，支持数据引用解析
            const allParams = {};
            
            // 先添加节点配置中的参数，支持数据引用
            if (node.config) {
                for (const [key, value] of Object.entries(node.config)) {
                    const resolvedValue = this._resolveValue(value, inputData);
                    
                    // 特殊处理：如果解析结果是对象，尝试提取 'output' 属性或将其 JSON 字符串化
                    if (typeof resolvedValue === 'object' && resolvedValue !== null) {
                        if (resolvedValue.output !== undefined) {
                            allParams[key] = String(resolvedValue.output); // 提取 output 属性并转为字符串
                            console.log(`[ExecutionEngine] 提取对象参数 ${key} 的 'output' 属性: ${allParams[key]}`);
                        } else {
                            allParams[key] = JSON.stringify(resolvedValue); // 否则，将整个对象 JSON 字符串化
                            console.log(`[ExecutionEngine] JSON 字符串化复杂对象参数 ${key}: ${allParams[key]}`);
                        }
                    } else {
                        allParams[key] = resolvedValue; // 对于非对象类型，直接使用解析后的值
                        console.log(`[ExecutionEngine] 添加参数 ${key}: ${allParams[key]}`);
                    }
                }
            }
            
            // 再添加输入数据中的参数，支持智能字段提取
            Object.entries(inputData).forEach(([key, value]) => {
                // 跳过无效的键名，避免添加undefined参数
                if (!key || key === 'undefined' || key === 'null') {
                    console.warn(`[ExecutionEngine] 跳过无效的参数键: ${key}`);
                    return;
                }
                
                // 仅当 allParams 中没有该键，或者该键的值为 undefined/null/空字符串时，才从 inputData 中添加
                // 这样可以确保 node.config 中的配置（已解析变量）优先
                if (allParams[key] === undefined || allParams[key] === null || allParams[key] === '') {
                    if (value !== null && value !== undefined && value !== '') {
                        // 如果输入数据是对象，尝试提取有用的字段
                        if (typeof value === 'object' && value !== null) {
                            // 智能字段映射：根据参数名称自动提取对应字段
                            if (key === 'url') {
                                // 对于url参数，优先查找imageUrl、url等字段
                                const urlValue = value.imageUrl || value.url || value.downloadUrl || value;
                                allParams[key] = urlValue;
                                console.log(`[ExecutionEngine] 智能提取URL字段 ${key}: ${urlValue}`);
                            } else if (key === 'downloadDir' && value.downloadDir) {
                                allParams[key] = value.downloadDir;
                                console.log(`[ExecutionEngine] 提取downloadDir字段: ${value.downloadDir}`);
                            } else if (value.output !== undefined) { // 增加对 {output: ...} 格式的支持
                                allParams[key] = String(value.output);
                                console.log(`[ExecutionEngine] 提取输入数据对象 ${key} 的 'output' 属性: ${allParams[key]}`);
                            }
                            else {
                                // 对于其他复杂对象，不再直接跳过，而是尝试 JSON 字符串化
                                allParams[key] = JSON.stringify(value);
                                console.log(`[ExecutionEngine] JSON 字符串化输入数据复杂对象 ${key}: ${allParams[key]}`);
                            }
                        } else {
                            // 简单类型的值直接添加
                            allParams[key] = value;
                            console.log(`[ExecutionEngine] 添加简单参数 ${key}: ${value}`);
                        }
                    }
                } else {
                    console.log(`[ExecutionEngine] 参数 ${key} 已在节点配置中处理，跳过输入数据`);
                }
            });
            
            console.log(`[ExecutionEngine] 合并后的参数:`, allParams);
            
            // 构建请求体，参考 renderer.js 的格式
            let requestBody = `<<<[TOOL_REQUEST]>>>\n`;
            const requestParams = [];
            
            // 添加基础参数
            requestParams.push(`maid:「始」${this.USER_NAME}「末」`);
            requestParams.push(`tool_name:「始」${node.pluginId}「末」`);
            
            // 简化逻辑：从插件管理器获取插件信息，检查是否需要command参数
            let needsCommand = false;
            let commandToUse = null;
            
            if (this.pluginManager) {
                const pluginKey = `${node.category}_${node.pluginId}`;
                const pluginInfo = this.pluginManager.getPluginInfo(pluginKey);
                
                if (pluginInfo && pluginInfo.commands && pluginInfo.commands.length > 0) {
                    const commandInfo = pluginInfo.commands[0]; // 使用第一个命令
                    needsCommand = commandInfo.needsCommand || false;
                    
                    if (needsCommand) {
                        // 优先使用节点配置的command，然后使用插件默认command
                        commandToUse = node.commandId || node.selectedCommand || 
                                     (node.config && node.config.command) || 
                                     commandInfo.command;
                    }
                    
                    console.log(`[ExecutionEngine] 插件 ${node.pluginId} needsCommand: ${needsCommand}, command: ${commandToUse}`);
                } else {
                    console.log(`[ExecutionEngine] 未找到插件 ${pluginKey} 的信息，跳过command参数`);
                }
            }
            
            // 只有需要command参数的插件才添加command参数
            if (needsCommand && commandToUse) {
                requestParams.push(`command:「始」${commandToUse}「末」`);
                console.log(`[ExecutionEngine] 使用指令: ${commandToUse}`);
            } else {
                console.log(`[ExecutionEngine] 节点 ${node.id} (${node.pluginId}) 不需要command参数`);
            }
            
            // 添加所有参数（配置 + 输入数据）
            for (const [key, value] of Object.entries(allParams)) {
                // 确保值不是 null, undefined 或空字符串，除非插件明确需要空值
                if (value !== null && value !== undefined && value !== '') { 
                    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    requestParams.push(`${key}:「始」${valueStr}「末」`);
                    console.log(`[ExecutionEngine] 添加参数 ${key}: ${valueStr}`);
                } else {
                    console.log(`[ExecutionEngine] 参数 ${key} 的值为 ${value}，跳过添加`);
                }
            }
            
            // 构建最终请求体，最后一个参数不加逗号
            for (let i = 0; i < requestParams.length; i++) {
                if (i === requestParams.length - 1) {
                    // 最后一个参数不加逗号
                    requestBody += `${requestParams[i]}\n`;
                } else {
                    // 其他参数加逗号
                    requestBody += `${requestParams[i]},\n`;
                }
            }
            
            requestBody += `<<<[END_TOOL_REQUEST]>>>`;
            
            console.log(`[ExecutionEngine] 完整请求体:`, requestBody);
            console.log(`[ExecutionEngine] 请求URL: ${this.VCP_SERVER_URL}`);
            
            // 发送请求
            const startTime = Date.now();
            console.log(`[ExecutionEngine] 发送请求到服务器...`);
            
            const response = await fetch(this.VCP_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': `Bearer ${this.VCP_API_KEY}`
                },
                body: requestBody
            });
            
            const endTime = Date.now();
            console.log(`[ExecutionEngine] 请求耗时: ${endTime - startTime}ms`);
            console.log(`[ExecutionEngine] 响应状态: ${response.status} ${response.statusText}`);
            console.log(`[ExecutionEngine] 响应头:`, Object.fromEntries(response.headers.entries()));
            
            const responseText = await response.text();
            console.log(`[ExecutionEngine] 原始响应文本:`, responseText);
            
            if (!response.ok) {
                console.error(`[ExecutionEngine] 请求失败: HTTP ${response.status}`);
                try {
                    const errorJson = JSON.parse(responseText);
                    console.error(`[ExecutionEngine] 错误详情:`, errorJson);
                    throw new Error(`HTTP ${response.status}: ${errorJson.error || responseText}`);
                } catch (e) {
                    console.error(`[ExecutionEngine] 解析错误响应失败:`, e);
                    throw new Error(`HTTP ${response.status}: ${responseText}`);
                }
            }
            
            let data;
            try {
                data = JSON.parse(responseText);
                console.log(`[ExecutionEngine] 解析后的响应数据:`, data);
            } catch (e) {
                console.error(`[ExecutionEngine] 解析响应JSON失败:`, e);
                console.log(`[ExecutionEngine] 将响应文本作为结果返回`);
                return responseText;
            }
            
            // 提取结果数据 - 优先返回完整的数据对象
            let result = data;
            console.log(`[ExecutionEngine] 初步提取的结果:`, result);
            
            // 如果数据有特定的结构，尝试提取有用的信息
            if (data.result && typeof data.result.content === 'string') {
                console.log(`[ExecutionEngine] 尝试解析 result.content:`, data.result.content);
                try {
                    const parsedContent = JSON.parse(data.result.content);
                    console.log(`[ExecutionEngine] 解析后的 content:`, parsedContent);
                    result = parsedContent.original_plugin_output || parsedContent;
                    console.log(`[ExecutionEngine] 最终提取的结果:`, result);
                } catch (e) {
                    console.log(`[ExecutionEngine] 解析 content 失败，使用原始数据:`, e);
                    result = data;
                }
            }
            
            // 确保返回的是完整的数据对象，包含所有字段（如imageUrl等）
            if (typeof result === 'string' && data && typeof data === 'object') {
                console.log(`[ExecutionEngine] 结果是字符串但原始数据是对象，返回原始数据以保留所有字段`);
                result = data;
            }
            
            // 检查结果中是否包含错误信息
            if (result && typeof result === 'object') {
                if (result.error) {
                    console.error(`[ExecutionEngine] 插件返回错误:`, result.error);
                }
                if (result.success !== undefined) {
                    console.log(`[ExecutionEngine] 插件执行状态:`, result.success ? '成功' : '失败');
                }
                if (result.message) {
                    console.log(`[ExecutionEngine] 插件消息:`, result.message);
                }
                if (result.data) {
                    console.log(`[ExecutionEngine] 插件数据:`, result.data);
                }
            }
            
            console.log(`[ExecutionEngine] 节点 ${node.id} 执行完成，返回结果:`, result);
            return result;
        }

        // 执行正则表达式节点
        executeRegexNode(node, inputData) {
            const config = node.config || {};
            const { pattern, flags = 'g', operation = 'match', replacement = '' } = config;
            
            // 从输入数据中提取文本内容
            let text = '';
            if (inputData.input && typeof inputData.input === 'object') {
                // 如果输入是对象，尝试提取文本内容
                text = inputData.input.original_plugin_output || 
                       inputData.input.text || 
                       inputData.input.content || 
                       inputData.input.message ||
                       JSON.stringify(inputData.input);
            } else if (inputData.input) {
                text = String(inputData.input);
            } else if (inputData.text) {
                text = inputData.text;
            } else {
                // 如果没有找到文本，将整个输入转为字符串
                text = JSON.stringify(inputData);
            }
            
            if (!pattern) {
                throw new Error('正则表达式节点需要 pattern 参数');
            }
            
            console.log(`[ExecutionEngine] 正则处理 - 文本: ${text.substring(0, 100)}...`);
            console.log(`[ExecutionEngine] 正则处理 - 模式: ${pattern}`);
            
            try {
                const regex = new RegExp(pattern, flags);
                let result;

                switch (operation) {
                    case 'match':
                        const matches = [];
                        const captureGroups = [];
                        let match;
                        while ((match = regex.exec(text)) !== null) {
                            matches.push(match[0]); // 完整匹配
                            // 如果有捕获组，使用捕获组的内容；否则使用完整匹配
                            if (match.length > 1) {
                                captureGroups.push(match[1]); // 第一个捕获组
                            } else {
                                captureGroups.push(match[0]); // 完整匹配
                            }
                            if (!flags.includes('g')) break;
                        }
                        
                        return {
                            matches: matches,
                            output: captureGroups, // 返回捕获组内容
                            text: text
                        };
                    
                    case 'replace':
                        result = text.replace(regex, replacement);
                        return { output: result };
                    
                    case 'test':
                        result = regex.test(text);
                        return { output: result };
                    
                    case 'split':
                        result = text.split(regex);
                        return { output: result };
                    
                    default:
                        result = text.match(regex);
                        return { output: result || [], matches: result || [] };
                }
            } catch (error) {
                throw new Error(`正则表达式执行失败: ${error.message}`);
            }
        }

        // 执行数据转换节点
        executeDataTransformNode(node, inputData) {
            console.log('[ExecutionEngine] 数据转换 - 输入数据:', inputData);
            console.log('[ExecutionEngine] 数据转换 - 节点配置:', node.config);
            
            const { transformType, customScript, outputParamName } = node.config || {};
            let result;
            
            try {
                if (transformType === 'custom' && customScript) {
                    // 自定义脚本转换 - 将所有输入数据作为变量传递给脚本
                    const scriptVars = Object.keys(inputData);
                    const scriptValues = Object.values(inputData);
                    
                    console.log('[ExecutionEngine] 执行自定义脚本，可用变量:', scriptVars);
                    
                    // 创建函数，将所有输入数据作为参数传递
                    const func = new Function(...scriptVars, customScript);
                    result = func(...scriptValues);
                    
                    console.log('[ExecutionEngine] 自定义脚本执行结果:', result);
                } else {
                    // 默认转换：如果有 data 参数则使用，否则使用第一个输入参数
                    const dataKey = inputData.data !== undefined ? 'data' : Object.keys(inputData)[0];
                    const data = inputData[dataKey];
                    
                    console.log('[ExecutionEngine] 默认转换，使用参数:', dataKey, '值:', data);
                    
                    switch (transformType) {
                        case 'json':
                            result = typeof data === 'string' ? JSON.parse(data) : data;
                            break;
                        case 'string':
                            result = typeof data === 'object' ? JSON.stringify(data) : String(data);
                            break;
                        case 'array':
                            result = Array.isArray(data) ? data : [data];
                            break;
                        default:
                            result = data;
                    }
                }
                
                // 使用自定义输出参数名或默认的 'result'
                const outputKey = outputParamName || 'result';
                const output = { [outputKey]: result };
                
                console.log('[ExecutionEngine] 数据转换完成，输出:', output);
                return output;
                
            } catch (error) {
                console.error('[ExecutionEngine] 数据转换执行失败:', error);
                throw new Error(`数据转换失败: ${error.message}`);
            }
        }

        // 执行条件节点
        executeConditionNode(inputData) {
            const { condition, trueValue, falseValue } = inputData;
            return condition ? trueValue : falseValue;
        }

        // 执行延时节点
        async executeDelayNode(inputData) {
            const { delay = 1000, data } = inputData;
            await new Promise(resolve => setTimeout(resolve, delay));
            return data;
        }

        // 执行URL渲染器节点
        executeUrlRendererNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行URL渲染器节点:`, node.id);
            console.log(`[ExecutionEngine] 节点配置:`, node.config);
            console.log(`[ExecutionEngine] 输入数据:`, inputData);
            
            const config = node.config || {};
            let { urlPath = 'imageUrl', renderType = 'image', width = 300, height = 200 } = node.config || {};
            
            // 对 urlPath 进行变量解析
            console.log(`[ExecutionEngine] URL渲染器 - 原始urlPath: ${urlPath}`);
            urlPath = this._resolveValue(urlPath, inputData);
            console.log(`[ExecutionEngine] URL渲染器 - 解析后urlPath: "${urlPath}", 类型: ${typeof urlPath}`); // 加上双引号方便观察空格

            // 从输入数据或配置中获取URL
            let url = null;
            
            // Debugging: Check the conditions
            console.log(`[ExecutionEngine] URL渲染器 - Debugging URL check:`);
            console.log(`[ExecutionEngine]   urlPath 是否为真: ${!!urlPath}`);
            console.log(`[ExecutionEngine]   urlPath 是否为字符串: ${typeof urlPath === 'string'}`);
            console.log(`[ExecutionEngine]   urlPath 是否以 'http://' 开头: ${typeof urlPath === 'string' && urlPath.startsWith('http://')}`);
            console.log(`[ExecutionEngine]   urlPath 是否以 'https://' 开头: ${typeof urlPath === 'string' && urlPath.startsWith('https://')}`);
            
            // 首先检查解析后的 urlPath 是否直接是一个URL
            if (urlPath && (typeof urlPath === 'string') && (urlPath.startsWith('http://') || urlPath.startsWith('https://'))) {
                url = urlPath;
                console.log(`[ExecutionEngine] 从解析后的 urlPath 中获取URL: ${url}`);
            } 
            // 否则，尝试从 inputData 中提取
            else if (inputData.input && typeof inputData.input === 'object') {
                // 根据 urlPath 配置从输入对象中提取URL
                // Here, urlPath is NOT a URL, but a path like 'imageUrl' or 'url'
                url = this._getNestedProperty(inputData.input, urlPath) || inputData.input.imageUrl || inputData.input.url;
                console.log(`[ExecutionEngine] 从输入数据中提取URL: ${url}`);
            } else if (inputData.url) {
                url = inputData.url;
                console.log(`[ExecutionEngine] 从输入数据url字段获取: ${url}`);
            } else if (inputData.imageUrl) {
                url = inputData.imageUrl;
                console.log(`[ExecutionEngine] 从输入数据imageUrl字段获取: ${url}`);
            } else if (node.config.url) { // Changed from config.url to node.config.url
                url = this._resolveValue(node.config.url, inputData); // Ensure node.config.url is also resolved
                console.log(`[ExecutionEngine] 从配置url字段获取: ${url}`);
            }
            
            console.log(`[ExecutionEngine] 提取的URL:`, url);
            
            if (!url) {
                console.warn(`[ExecutionEngine] URL渲染器未找到有效的URL`);
                return { error: '未找到有效的URL进行渲染' };
            }
            
            // 根据渲染类型生成相应的HTML内容
            let htmlContent = '';
            let actualRenderType = renderType;
            
            // 处理 auto 类型：根据URL自动判断渲染方式
            if (renderType === 'auto') {
                if (url.match(/\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?.*)?$/i)) {
                    actualRenderType = 'image';
                } else if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('bilibili.com')) {
                    actualRenderType = 'iframe';
                } else {
                    actualRenderType = 'link';
                }
                console.log(`[ExecutionEngine] Auto模式检测到渲染类型: ${actualRenderType}`);
            }
            
            switch (actualRenderType) {
                case 'image':
                    htmlContent = `<img src="${url}" alt="渲染图片" style="max-width: ${width}px; max-height: ${height}px;" />`;
                    break;
                case 'iframe':
                    htmlContent = `<iframe src="${url}" width="${width}" height="${height}" frameborder="0"></iframe>`;
                    break;
                case 'link':
                    htmlContent = `<a href="${url}" target="_blank">${url}</a>`;
                    break;
                default:
                    htmlContent = `<div>URL: <a href="${url}" target="_blank">${url}</a></div>`;
            }
            
            // 更新节点的显示内容
            console.log(`[ExecutionEngine] 尝试更新节点 ${node.id} 的显示内容`);
            
            // 尝试多种选择器来找到节点元素
            let nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
            if (!nodeElement) {
                nodeElement = document.querySelector(`#${node.id} .node-content`);
            }
            if (!nodeElement) {
                nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            }
            if (!nodeElement) {
                nodeElement = document.querySelector(`#${node.id}`);
            }
            
            if (nodeElement) {
                console.log(`[ExecutionEngine] 找到节点元素，更新内容:`, htmlContent);
                
                // 如果是 .node-content 元素，直接设置内容
                if (nodeElement.classList.contains('node-content')) {
                    nodeElement.innerHTML = htmlContent;
                } else {
                    // 如果是节点容器，查找或创建 .node-content 子元素
                    let contentElement = nodeElement.querySelector('.node-content');
                    if (!contentElement) {
                        contentElement = nodeElement.querySelector('.node-body');
                    }
                    if (!contentElement) {
                        // 创建一个内容区域
                        contentElement = document.createElement('div');
                        contentElement.className = 'node-rendered-content';
                        contentElement.style.cssText = 'padding: 10px; margin-top: 5px; border-top: 1px solid #333;';
                        nodeElement.appendChild(contentElement);
                    }
                    contentElement.innerHTML = htmlContent;
                }
                
                console.log(`[ExecutionEngine] 节点 ${node.id} 显示内容已更新`);
            } else {
                console.warn(`[ExecutionEngine] 未找到节点 ${node.id} 的DOM元素`);
                
                // 尝试通过 stateManager 更新节点
                if (this.stateManager && this.stateManager.updateNodeContent) {
                    console.log(`[ExecutionEngine] 尝试通过 stateManager 更新节点内容`);
                    this.stateManager.updateNodeContent(node.id, htmlContent);
                }
            }
            
            return {
                success: true,
                url: url,
                htmlContent: htmlContent,
                renderType: renderType
            };
        }

        // 执行文本显示节点
        executeTextDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行文本显示节点:`, node.id);
            
            let text = '';
            if (inputData.input && typeof inputData.input === 'object') {
                text = inputData.input.text || inputData.input.message || JSON.stringify(inputData.input);
            } else if (inputData.text) {
                text = inputData.text;
            } else if (inputData.message) {
                text = inputData.message;
            }
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.textContent = text;
                }
            }
            
            return { success: true, text: text };
        }

        // 执行图片显示节点
        executeImageDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行图片显示节点:`, node.id);
            
            let imageUrl = '';
            if (inputData.input && typeof inputData.input === 'object') {
                imageUrl = inputData.input.imageUrl || inputData.input.url;
            } else if (inputData.imageUrl) {
                imageUrl = inputData.imageUrl;
            } else if (inputData.url) {
                imageUrl = inputData.url;
            }
            
            if (imageUrl) {
                const imgHtml = `<img src="${imageUrl}" alt="显示图片" style="max-width: 200px; max-height: 200px;" />`;
                
                // 更新节点显示
                if (this.stateManager) {
                    const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                    if (nodeElement) {
                        nodeElement.innerHTML = imgHtml;
                    }
                }
            }
            
            return { success: true, imageUrl: imageUrl };
        }

        // 执行HTML显示节点
        executeHtmlDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行HTML显示节点:`, node.id);
            
            let htmlContent = '';
            if (inputData.input && typeof inputData.input === 'object') {
                htmlContent = inputData.input.html || inputData.input.htmlContent || inputData.input.content;
            } else if (inputData.html) {
                htmlContent = inputData.html;
            } else if (inputData.htmlContent) {
                htmlContent = inputData.htmlContent;
            }
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.innerHTML = htmlContent;
                }
            }
            
            return { success: true, htmlContent: htmlContent };
        }

        // 执行JSON显示节点
        executeJsonDisplayNode(node, inputData) {
            console.log(`[ExecutionEngine] 执行JSON显示节点:`, node.id);
            
            let jsonData = inputData.input || inputData;
            const jsonString = JSON.stringify(jsonData, null, 2);
            
            // 更新节点显示
            if (this.stateManager) {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"] .node-content`);
                if (nodeElement) {
                    nodeElement.innerHTML = `<pre>${jsonString}</pre>`;
                }
            }
            
            return { success: true, jsonData: jsonData };
        }

        // 传播输出数据
        // 传播输出数据
        propagateOutputData(nodeId, graphNode) {
            const result = this.nodeResults.get(nodeId);
            const sourceNode = graphNode.node;
            console.log(`[ExecutionEngine] 传播节点 ${nodeId} 的输出数据:`, result);
            
            graphNode.outputs.forEach(output => {
                const targetInputData = this.nodeInputData.get(output.targetNodeId) || {};
                
                // 优先使用节点配置的自定义输出参数名
                let targetParam = output.connection.targetParam || output.targetPort || 'input';
                let useCustomOutputName = false;
                
                // 如果源节点是辅助节点且配置了自定义输出参数名，使用它
                if (sourceNode.category === 'auxiliary' && sourceNode.config && sourceNode.config.outputParamName) {
                    targetParam = sourceNode.config.outputParamName;
                    useCustomOutputName = true;
                    console.log(`[ExecutionEngine] 使用自定义输出参数名: ${targetParam}`);
                }
                
                // 增强数据传递：支持字段映射和直接访问
                let dataToPass = result;
                
                // 特殊处理：对于正则节点使用自定义输出名时，应该只传递 output 字段
                if (useCustomOutputName && sourceNode.pluginId === 'regex' && result && typeof result === 'object' && result.output !== undefined) {
                    dataToPass = result.output;
                    console.log(`[ExecutionEngine] 正则节点使用自定义输出名，传递 output 字段:`, dataToPass);
                }
                // 如果目标参数有特定的字段映射需求，进行智能提取
                else if (typeof result === 'object' && result !== null) {
                    // 根据目标参数名进行智能字段映射
                    switch (targetParam) {
                        case 'url':
                        case 'imageUrl':
                            dataToPass = result.imageUrl || result.url || result.downloadUrl || result;
                            console.log(`[ExecutionEngine] 智能提取URL字段: ${dataToPass}`);
                            break;
                        case 'filePath':
                            dataToPass = result.filePath || result.path || result.file || result;
                            break;
                        case 'text':
                        case 'content':
                            dataToPass = result.text || result.content || result.message || result;
                            break;
                        default:
                            // 对于其他参数，如果结果对象中有同名字段，优先使用
                            if (result.hasOwnProperty(targetParam)) {
                                dataToPass = result[targetParam];
                                console.log(`[ExecutionEngine] 使用同名字段 ${targetParam}: ${dataToPass}`);
                            } else {
                                dataToPass = result;
                            }
                            break;
                    }
                }
                
                targetInputData[targetParam] = dataToPass;
                
                console.log(`[ExecutionEngine] 设置节点 ${output.targetNodeId} 的输入参数 ${targetParam}:`, dataToPass);
                
                this.nodeInputData.set(output.targetNodeId, targetInputData);
                
                // 检查目标节点是否现在可以执行
                const targetNode = this.stateManager.getNode(output.targetNodeId);
                if (targetNode && this.areRequiredInputsReady(output.targetNodeId, targetNode)) {
                    console.log(`[ExecutionEngine] 节点 ${output.targetNodeId} 现在可以执行了`);
                }
            });
        }

        // 更新节点状态
        updateNodeStatus(nodeId, status) {
            if (this.stateManager) {
                const node = this.stateManager.getNode(nodeId);
                if (node) {
                    node.status = status;
                    this.stateManager.updateNode(nodeId, { status });
                }
            }
        }

        // 停止执行
        stopExecution() {
            this.isExecuting = false;
            console.log('[ExecutionEngine] Execution stopped');
        }

        // 获取节点结果
        getNodeResult(nodeId) {
            return this.nodeResults.get(nodeId);
        }

        // 获取所有结果
        getAllResults() {
            return Object.fromEntries(this.nodeResults);
        }

        // 清除结果
        clearResults() {
            this.nodeResults.clear();
            this.nodeInputData.clear();
        }

        // 处理输入数据，支持JSON解析
        processInputData(data) {
            console.log(`[ExecutionEngine] 处理输入数据:`, data);
            
            // 如果数据是字符串，尝试解析为JSON
            if (typeof data === 'string') {
                try {
                    const parsed = JSON.parse(data);
                    console.log(`[ExecutionEngine] 成功解析JSON:`, parsed);
                    return parsed;
                } catch (e) {
                    console.log(`[ExecutionEngine] 字符串不是有效JSON，返回原始字符串`);
                    return data;
                }
            }
            
            return data;
        }


        // 设置嵌套对象的值（支持 a.b.c 格式）
        setNestedValue(obj, path, value) {
            const keys = path.split('.');
            let current = obj;
            
            for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                if (!(key in current) || typeof current[key] !== 'object') {
                    current[key] = {};
                }
                current = current[key];
            }
            
            current[keys[keys.length - 1]] = value;
        }

        // 辅助方法：安全获取嵌套属性
        _getNestedProperty(obj, path) {
            if (!obj || typeof obj !== 'object' || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {
                if (current === null || typeof current !== 'object' || !current.hasOwnProperty(part)) {
                    return undefined;
                }
                current = current[part];
            }
            return current;
        }

        // 辅助方法：解析带有 {{...}} 语法的变量
        _resolveValue(value, inputData) {
            if (typeof value !== 'string') {
                return value; // 只处理字符串
            }

            const regex = /\{\{(.*?)\}\}/g;
            let resolved = value;
            let match;
            let hasMatch = false;

            // First pass: check if the entire string is a single {{...}} expression
            const fullMatchRegex = /^\{\{(.*?)\}\}$/;
            const fullMatch = value.match(fullMatchRegex);
            if (fullMatch) {
                const path = fullMatch[1].trim(); // path is 'input.output'
                if (path.startsWith('input.')) {
                    let resolvedData = this._getNestedProperty(inputData, path);
                    // 特殊处理：如果解析结果是对象且包含 'output' 属性，则提取其值
                    if (typeof resolvedData === 'object' && resolvedData !== null && resolvedData.output !== undefined) {
                        return String(resolvedData.output); // 返回 'output' 属性的值并转为字符串
                    }
                    return resolvedData; // 返回原始解析值，可以是任何类型
                } else {
                    console.warn(`[ExecutionEngine] 无法解析的变量路径 (整串匹配): ${path}`);
                    return value; // Return original value if path is not 'input.xxx'
                }
            }

            // Second pass: replace multiple {{...}} expressions within a string
            while ((match = regex.exec(value)) !== null) {
                hasMatch = true;
                const fullPlaceholder = match[0]; // e.g., {{input.output}}
                const path = match[1].trim(); // e.g., input.output

                if (path.startsWith('input.')) {
                    let resolvedData = this._getNestedProperty(inputData, path);
                    // 特殊处理：如果解析结果是对象且包含 'output' 属性，则提取其值
                    if (typeof resolvedData === 'object' && resolvedData !== null && resolvedData.output !== undefined) {
                        resolvedData = String(resolvedData.output); // 使用 'output' 属性的值并转为字符串
                    } else if (typeof resolvedData === 'object' && resolvedData !== null) {
                        resolvedData = JSON.stringify(resolvedData); // 对于其他对象，将其 JSON 字符串化
                    }
                    // Replace the placeholder with the string representation of the resolved data
                    resolved = resolved.replace(fullPlaceholder, resolvedData !== undefined ? String(resolvedData) : '');
                } else {
                    console.warn(`[ExecutionEngine] 无法解析的变量路径 (部分匹配): ${path}`);
                    // If not resolvable, keep the placeholder or replace with empty string
                    resolved = resolved.replace(fullPlaceholder, ''); // Or keep fullPlaceholder if you want to show it's unresolved
                }
            }
            return resolved;
        }
    }

    // 导出为全局单例
    window.WorkflowEditor_ExecutionEngine = WorkflowEditor_ExecutionEngine.getInstance();
})();