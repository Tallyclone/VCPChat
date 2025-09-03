// URL提取器节点集成补丁
// 将URL提取器节点注册到工作流编辑器中

(function() {
    'use strict';

    // 等待NodeManager加载完成后注册URL提取器节点
    function registerUrlExtractorNode() {
        if (window.WorkflowEditor_NodeManager) {
            const nodeManager = window.WorkflowEditor_NodeManager.getInstance();
            
            // 注册URL提取器节点类型
            nodeManager.registerNodeType('urlExtractor', {
                label: 'URL提取器',
                category: 'auxiliary',
                inputs: ['input'],
                outputs: ['urls', 'result'],
                configSchema: {
                    urlTypes: {
                        type: 'multiselect',
                        options: ['image', 'video', 'audio', 'all'],
                        default: ['image'],
                        description: '要提取的URL类型'
                    },
                    deduplication: {
                        type: 'boolean',
                        default: true,
                        description: '是否对提取的URL进行去重'
                    },
                    outputFormat: {
                        type: 'enum',
                        options: ['array', 'single', 'object'],
                        default: 'array',
                        description: '输出格式：array=URL数组，single=单个URL，object=详细信息对象'
                    },
                    outputParamName: {
                        type: 'string',
                        default: 'extractedUrls',
                        placeholder: '例如: imageUrls',
                        description: '输出参数名称'
                    }
                }
            });

            // 注册URL提取器节点执行器
            nodeManager.registerNodeExecutor('urlExtractor', async function(node, inputData) {
                return await nodeManager.executeUrlExtractorNode(node, inputData);
            });

            console.log('[URLExtractor] URL提取器节点已注册到工作流编辑器');
        } else {
            // 如果NodeManager还未加载，延迟注册
            setTimeout(registerUrlExtractorNode, 100);
        }
    }

    // 页面加载完成后注册节点
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerUrlExtractorNode);
    } else {
        registerUrlExtractorNode();
    }

    // 扩展现有的辅助节点类型注册方法
    if (window.WorkflowEditor_NodeManager) {
        const originalRegisterAuxiliaryNodeTypes = window.WorkflowEditor_NodeManager.prototype.registerAuxiliaryNodeTypes;
        
        window.WorkflowEditor_NodeManager.prototype.registerAuxiliaryNodeTypes = function() {
            // 调用原始方法
            if (originalRegisterAuxiliaryNodeTypes) {
                originalRegisterAuxiliaryNodeTypes.call(this);
            }
            
            // 注册URL提取器节点（如果还未注册）
            if (!this.nodeTypes.has('urlExtractor')) {
                this.registerNodeType('urlExtractor', {
                    label: 'URL提取器',
                    category: 'auxiliary',
                    inputs: ['input'],
                    outputs: ['urls', 'result'],
                    configSchema: {
                        urlTypes: {
                            type: 'multiselect',
                            options: ['image', 'video', 'audio', 'all'],
                            default: ['image'],
                            description: '要提取的URL类型'
                        },
                        deduplication: {
                            type: 'boolean',
                            default: true,
                            description: '是否对提取的URL进行去重'
                        },
                        outputFormat: {
                            type: 'enum',
                            options: ['array', 'single', 'object'],
                            default: 'array',
                            description: '输出格式'
                        },
                        outputParamName: {
                            type: 'string',
                            default: 'extractedUrls',
                            placeholder: '例如: imageUrls'
                        }
                    }
                });
            }
        };
    }

})();