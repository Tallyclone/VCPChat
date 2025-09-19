/**
 * 简化版工作流编辑器加载器 v2.0
 * 
 * 架构简化：
 * 1. StateManager 作为唯一数据源
 * 2. 移除 ConnectionManager 的状态存储功能
 * 3. 简化组件间的依赖关系
 * 
 * 更新日志：
 * - 修复了重复声明问题
 * - 添加了load()方法作为入口点
 * - 修复了实例导出问题
 */

class WorkflowEditorLoader_Simplified {
    constructor() {
        this.isLoaded = false;
        this.components = {};
    }

    // 主入口方法 - renderer.js 调用的接口
    async load() {
        return await this.loadWorkflowEditor();
    }

    async loadWorkflowEditor() {
        if (this.isLoaded) {
            console.log('[WorkflowEditorLoader] 工作流编辑器已加载');
            return;
        }

        try {
            console.log('[WorkflowEditorLoader] 开始加载简化版工作流编辑器...');

            // 1. 加载核心组件
            await this.loadCoreComponents();

            // 2. 初始化组件（简化的依赖关系）
            this.initializeComponents();

            // 3. 建立组件间的连接
            this.connectComponents();

            this.isLoaded = true;
            console.log('[WorkflowEditorLoader] ✅ 简化版工作流编辑器加载完成');

        } catch (error) {
            console.error('[WorkflowEditorLoader] 加载失败:', error);
            throw error;
        }
    }

    async loadCoreComponents() {
        console.log('[WorkflowEditorLoader] 加载核心组件...');

        // 检查必需的组件是否已加载
        const requiredComponents = [
            'WorkflowEditor_StateManager',
            'WorkflowEditor_CanvasManager_JSPlumb', 
            'WorkflowEditor_ExecutionEngine',
            'WorkflowEditor_UIManager',
            'WorkflowEditor_NodeManager',
            'WorkflowEditor_PluginManager'
        ];

        for (const componentName of requiredComponents) {
            if (!window[componentName]) {
                throw new Error(`必需组件未加载: ${componentName}`);
            }
            console.log(`[WorkflowEditorLoader] ✓ ${componentName} 已加载`);
        }

        // 可选组件（简化版 ConnectionManager）
        if (window.WorkflowEditor_ConnectionManager_Simplified) {
            console.log('[WorkflowEditorLoader] ✓ 使用简化版 ConnectionManager');
        } else if (window.WorkflowEditor_ConnectionManager) {
            console.log('[WorkflowEditorLoader] ⚠️ 使用原版 ConnectionManager（建议升级到简化版）');
        }
    }

    initializeComponents() {
        console.log('[WorkflowEditorLoader] 初始化组件...');

        // 1. StateManager - 核心数据源（使用单例实例）
        this.components.stateManager = window.WorkflowEditor_StateManager;
        console.log('[WorkflowEditorLoader] ✓ StateManager 初始化完成');

        // 2. CanvasManager - 视图层（使用单例实例）
        this.components.canvasManager = window.WorkflowEditor_CanvasManager_JSPlumb;
        console.log('[WorkflowEditorLoader] ✓ CanvasManager 初始化完成');

        // 3. NodeManager - 节点管理（使用单例实例）
        this.components.nodeManager = window.WorkflowEditor_NodeManager;
        console.log('[WorkflowEditorLoader] ✓ NodeManager 初始化完成');

        // 4. PluginManager - 插件管理（使用单例实例）
        this.components.pluginManager = window.WorkflowEditor_PluginManager;
        console.log('[WorkflowEditorLoader] ✓ PluginManager 初始化完成');

        // 5. ExecutionEngine - 执行引擎
        this.components.executionEngine = window.WorkflowEditor_ExecutionEngine;
        console.log('[WorkflowEditorLoader] ✓ ExecutionEngine 准备完成');

        // 6. ConnectionManager - 简化版（可选）
        if (window.WorkflowEditor_ConnectionManager_Simplified) {
            this.components.connectionManager = new window.WorkflowEditor_ConnectionManager_Simplified();
            console.log('[WorkflowEditorLoader] ✓ 简化版 ConnectionManager 初始化完成');
        }

        // 7. UIManager - 用户界面管理（使用单例实例）
        this.components.uiManager = window.WorkflowEditor_UIManager;
        console.log('[WorkflowEditorLoader] ✓ UIManager 初始化完成');
    }

    connectComponents() {
        console.log('[WorkflowEditorLoader] 建立组件连接...');

        const { stateManager, canvasManager, nodeManager, pluginManager, executionEngine, connectionManager, uiManager } = this.components;

        // 1. StateManager 作为核心，不依赖其他组件
        console.log('[WorkflowEditorLoader] ✓ StateManager 独立运行');

        // 2. CanvasManager 依赖 StateManager
        canvasManager.init(stateManager);
        console.log('[WorkflowEditorLoader] ✓ CanvasManager → StateManager');

        // 3. NodeManager 依赖 StateManager
        nodeManager.init(stateManager);
        console.log('[WorkflowEditorLoader] ✓ NodeManager → StateManager');

        // 4. ExecutionEngine 依赖 StateManager 和 PluginManager
        executionEngine.init(stateManager, pluginManager);
        console.log('[WorkflowEditorLoader] ✓ ExecutionEngine → StateManager, PluginManager');

        // 5. ConnectionManager（如果使用简化版）依赖 StateManager 和 CanvasManager
        if (connectionManager) {
            connectionManager.initialize(stateManager, canvasManager);
            console.log('[WorkflowEditorLoader] ✓ ConnectionManager → StateManager, CanvasManager');
        }

        // 6. UIManager 只依赖 StateManager
        uiManager.init(stateManager);
        console.log('[WorkflowEditorLoader] ✓ UIManager → StateManager');

        // 设置全局引用（向后兼容）
        this.setGlobalReferences();
    }

    setGlobalReferences() {
        console.log('[WorkflowEditorLoader] 设置全局引用...');

        // 设置全局引用以保持向后兼容性
        window.WorkflowEditor_StateManager_Instance = this.components.stateManager;
        window.WorkflowEditor_CanvasManager = this.components.canvasManager;
        window.WorkflowEditor_NodeManager_Instance = this.components.nodeManager;
        window.WorkflowEditor_PluginManager_Instance = this.components.pluginManager;
        
        if (this.components.connectionManager) {
            window.WorkflowEditor_ConnectionManager_Instance = this.components.connectionManager;
        }
        
        window.WorkflowEditor_UIManager_Instance = this.components.uiManager;
        
        // 设置主要的工作流编辑器引用（renderer.js 需要这个）
        if (window.WorkflowEditor_Config) {
            window.workflowEditor = window.WorkflowEditor_Config.getInstance();
            console.log('[WorkflowEditorLoader] ✓ 设置 window.workflowEditor 引用:', window.workflowEditor);
            console.log('[WorkflowEditorLoader] ✓ workflowEditor.show 方法存在:', typeof window.workflowEditor.show);
            console.log('[WorkflowEditorLoader] ✓ workflowEditor.init 方法存在:', typeof window.workflowEditor.init);
        } else {
            console.warn('[WorkflowEditorLoader] WorkflowEditor_Config 未找到');
        }

        console.log('[WorkflowEditorLoader] ✓ 全局引用设置完成');
    }

    // 获取组件实例
    getComponent(name) {
        return this.components[name];
    }

    // 获取所有组件
    getAllComponents() {
        return { ...this.components };
    }

    // 调试信息
    debugArchitecture() {
        console.log('[WorkflowEditorLoader] 简化架构调试信息:');
        console.log('='.repeat(50));
        
        console.log('📊 数据层:');
        console.log('  └── StateManager (唯一数据源)');
        
        console.log('🎨 视图层:');
        console.log('  └── CanvasManager (视图渲染)');
        
        console.log('🔧 业务层:');
        console.log('  ├── NodeManager (节点管理)');
        console.log('  ├── PluginManager (插件管理)');
        console.log('  └── ExecutionEngine (执行引擎)');
        
        console.log('🖥️ 界面层:');
        console.log('  └── UIManager (用户界面)');
        
        if (this.components.connectionManager) {
            console.log('🔗 工具层:');
            console.log('  └── ConnectionManager (连接工具)');
        }
        
        console.log('='.repeat(50));
        
        // 输出组件状态
        Object.entries(this.components).forEach(([name, component]) => {
            const status = component ? '✅' : '❌';
            console.log(`${status} ${name}: ${!!component}`);
        });
    }
}

// 全局导出
if (typeof window !== 'undefined') {
    window.WorkflowEditorLoader_Simplified = WorkflowEditorLoader_Simplified;
    
    // 创建全局实例
    const loaderInstance = new WorkflowEditorLoader_Simplified();
    window.workflowEditorLoader = loaderInstance;
    
    // 为了兼容性，也导出实例为原名称（这样 renderer.js 可以调用 .load() 方法）
    window.WorkflowEditorLoader = loaderInstance;
}