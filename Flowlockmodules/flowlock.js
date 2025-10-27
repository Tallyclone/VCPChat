// Flowlockmodules/flowlock.js
// 心流锁模块 - 用于实现自动续写功能

console.log('[Flowlock] Module loaded.');

class FlowlockManager {
    constructor() {
        this.isActive = false;
        this.currentAgentId = null;
        this.currentTopicId = null;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.isProcessing = false;
        this.customPrompt = null;
        this.customPrompter = null;
        
        // References to be injected
        this.electronAPI = null;
        this.uiHelper = null;
        this.currentSelectedItemRef = null;
        this.currentTopicIdRef = null;
        this.handleContinueWriting = null;
    }

    /**
     * 初始化心流锁管理器
     * @param {Object} refs - 依赖引用
     */
    initialize(refs) {
        if (!refs.electronAPI || !refs.uiHelper || !refs.currentSelectedItemRef || 
            !refs.currentTopicIdRef || !refs.handleContinueWriting) {
            console.error('[Flowlock] Initialization failed: Missing required references.');
            return;
        }

        this.electronAPI = refs.electronAPI;
        this.uiHelper = refs.uiHelper;
        this.currentSelectedItemRef = refs.currentSelectedItemRef;
        this.currentTopicIdRef = refs.currentTopicIdRef;
        this.handleContinueWriting = refs.handleContinueWriting;

        console.log('[Flowlock] Initialized successfully.');

        // 监听续写完成事件
        this.setupEventListeners();
    }

    /**
     * 设置事件监听器
     */
    setupEventListeners() {
        // 监听VCP流事件的结束
        if (this.electronAPI && this.electronAPI.onVCPStreamEvent) {
            // 注意：这里需要在renderer.js中正确触发心流锁的续写逻辑
            console.log('[Flowlock] Event listeners setup complete.');
        }
    }

    /**
     * 启动心流锁
     * @param {string} agentId - Agent ID
     * @param {string} topicId - Topic ID
     * @param {boolean} startImmediately - 是否立即开始续写
     */
    async start(agentId, topicId, startImmediately = false) {
        if (this.isActive) {
            console.log('[Flowlock] Already active.');
            return { success: false, message: '心流锁已经在运行中' };
        }

        this.isActive = true;
        this.currentAgentId = agentId;
        this.currentTopicId = topicId;
        this.retryCount = 0;
        this.isProcessing = false;

        console.log(`[Flowlock] Started for agent: ${agentId}, topic: ${topicId}`);
        
        // 更新UI状态 - 让标题发光
        this.updateUIGlowState(true);

        // 通知后端插件心流锁已启动
        if (this.electronAPI.invokeDistributedPlugin) {
            try {
                await this.electronAPI.invokeDistributedPlugin('Flowlock', 'start', {
                    agentId: agentId,
                    topicId: topicId
                });
            } catch (error) {
                console.warn('[Flowlock] Failed to notify backend plugin:', error);
            }
        }

        // 显示通知
        if (this.uiHelper && this.uiHelper.showToastNotification) {
            this.uiHelper.showToastNotification('心流锁已启动', 'success');
        }

        // 如果需要立即开始续写
        if (startImmediately) {
            setTimeout(() => this.triggerContinueWriting(), 500);
        }

        return { success: true, message: '心流锁已启动' };
    }

    /**
     * 停止心流锁
     */
    async stop() {
        if (!this.isActive) {
            console.log('[Flowlock] Not active.');
            return { success: false, message: '心流锁未运行' };
        }

        this.isActive = false;
        this.isProcessing = false;
        this.retryCount = 0;
        this.customPrompt = null;
        this.customPrompter = null;

        console.log('[Flowlock] Stopped.');

        // 更新UI状态 - 停止发光
        this.updateUIGlowState(false);

        // 通知后端插件心流锁已停止
        if (this.electronAPI.invokeDistributedPlugin) {
            try {
                await this.electronAPI.invokeDistributedPlugin('Flowlock', 'stop', {
                    agentId: this.currentAgentId,
                    topicId: this.currentTopicId
                });
            } catch (error) {
                console.warn('[Flowlock] Failed to notify backend plugin:', error);
            }
        }

        // 显示通知
        if (this.uiHelper && this.uiHelper.showToastNotification) {
            this.uiHelper.showToastNotification('心流锁已停止', 'info');
        }

        this.currentAgentId = null;
        this.currentTopicId = null;

        return { success: true, message: '心流锁已停止' };
    }

    /**
     * 设置自定义提示词
     * @param {string} prompt - 提示词内容
     */
    setCustomPrompt(prompt) {
        this.customPrompt = prompt;
        console.log(`[Flowlock] Custom prompt set: ${prompt}`);
    }

    /**
     * 设置自定义提示词来源
     * @param {Function} prompter - 提示词生成函数
     */
    setCustomPrompter(prompter) {
        this.customPrompter = prompter;
        console.log('[Flowlock] Custom prompter set.');
    }

    /**
     * 触发续写
     */
    async triggerContinueWriting() {
        if (!this.isActive) {
            console.log('[Flowlock] Not active, skipping continue writing.');
            return;
        }

        if (this.isProcessing) {
            console.log('[Flowlock] Already processing, skipping this trigger.');
            return;
        }

        // 检查当前上下文是否匹配
        const currentItem = this.currentSelectedItemRef ? this.currentSelectedItemRef.get() : null;
        const currentTopic = this.currentTopicIdRef ? this.currentTopicIdRef.get() : null;

        if (!currentItem || !currentTopic) {
            console.log('[Flowlock] No active chat context.');
            await this.stop();
            return;
        }

        if (currentItem.id !== this.currentAgentId || currentTopic !== this.currentTopicId) {
            console.log('[Flowlock] Chat context changed, stopping flowlock.');
            await this.stop();
            return;
        }

        this.isProcessing = true;

        try {
            // 获取提示词
            let prompt = '';
            if (this.customPrompter && typeof this.customPrompter === 'function') {
                prompt = await this.customPrompter();
            } else if (this.customPrompt) {
                prompt = this.customPrompt;
            }

            console.log(`[Flowlock] Triggering continue writing with prompt: "${prompt}"`);

            // 调用续写函数
            if (this.handleContinueWriting) {
                await this.handleContinueWriting(prompt);
                // 重置重试计数
                this.retryCount = 0;
            } else {
                console.error('[Flowlock] handleContinueWriting function not available.');
                await this.stop();
            }

        } catch (error) {
            console.error('[Flowlock] Error during continue writing:', error);
            
            this.retryCount++;
            
            if (this.retryCount >= this.maxRetries) {
                console.error(`[Flowlock] Max retries (${this.maxRetries}) reached. Stopping flowlock.`);
                if (this.uiHelper && this.uiHelper.showToastNotification) {
                    this.uiHelper.showToastNotification('心流锁续写失败次数过多，已自动停止', 'error');
                }
                await this.stop();
            } else {
                console.log(`[Flowlock] Retry ${this.retryCount}/${this.maxRetries}`);
                if (this.uiHelper && this.uiHelper.showToastNotification) {
                    this.uiHelper.showToastNotification(`心流锁续写失败，正在重试 (${this.retryCount}/${this.maxRetries})`, 'warning');
                }
                // 重试前等待一段时间
                setTimeout(() => {
                    this.isProcessing = false;
                    this.triggerContinueWriting();
                }, 2000);
            }
        }

        this.isProcessing = false;
    }

    /**
     * 监听消息完成事件并触发下一次续写
     * 应该在消息渲染完成后调用此方法
     */
    onMessageComplete() {
        if (!this.isActive || this.isProcessing) {
            return;
        }

        console.log('[Flowlock] Message complete, scheduling next continue writing.');
        
        // 延迟一小段时间再触发下一次续写，避免过于频繁
        setTimeout(() => {
            this.triggerContinueWriting();
        }, 1000);
    }

    /**
     * 更新UI发光状态
     * @param {boolean} shouldGlow - 是否应该发光
     */
    updateUIGlowState(shouldGlow) {
        const chatNameElement = document.getElementById('currentChatAgentName');
        if (!chatNameElement) {
            console.warn('[Flowlock] Chat name element not found.');
            return;
        }

        if (shouldGlow) {
            chatNameElement.classList.add('flowlock-active');
        } else {
            chatNameElement.classList.remove('flowlock-active');
        }

        console.log(`[Flowlock] UI glow state updated: ${shouldGlow}`);
    }

    /**
     * 获取当前状态
     */
    getState() {
        return {
            isActive: this.isActive,
            isProcessing: this.isProcessing,
            currentAgentId: this.currentAgentId,
            currentTopicId: this.currentTopicId,
            retryCount: this.retryCount,
            hasCustomPrompt: !!this.customPrompt,
            hasCustomPrompter: !!this.customPrompter
        };
    }
}

// 创建全局单例
const flowlockManager = new FlowlockManager();

// 导出到window对象供其他模块使用
window.flowlockManager = flowlockManager;

console.log('[Flowlock] Manager instance created and exposed globally.');