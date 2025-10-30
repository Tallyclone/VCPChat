// Promptmodules/prompt-manager.js
// 系统提示词管理器 - 负责三种模式的切换和数据管理

class PromptManager {
    constructor() {
        this.currentMode = 'original'; // 'original' | 'modular' | 'preset'
        this.agentId = null;
        this.config = null;
        
        // 模块实例
        this.originalModule = null;
        this.modularModule = null;
        this.presetModule = null;
    }

    /**
     * 初始化提示词管理器
     * @param {Object} options - 初始化选项
     */
    init(options) {
        const {
            agentId,
            config,
            containerElement,
            electronAPI
        } = options;

        this.agentId = agentId;
        this.config = config;
        this.containerElement = containerElement;
        this.electronAPI = electronAPI;

        // 从配置中读取当前模式
        this.currentMode = config.promptMode || 'original';

        // 初始化三个模块
        this.initModules();

        // 渲染UI
        this.render();
    }

    /**
     * 初始化三个子模块
     */
    initModules() {
        if (window.OriginalPromptModule) {
            this.originalModule = new window.OriginalPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }

        if (window.ModularPromptModule) {
            this.modularModule = new window.ModularPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }

        if (window.PresetPromptModule) {
            this.presetModule = new window.PresetPromptModule({
                agentId: this.agentId,
                config: this.config,
                electronAPI: this.electronAPI
            });
        }
    }

    /**
     * 渲染主界面
     */
    render() {
        if (!this.containerElement) return;

        // 清空容器
        this.containerElement.innerHTML = '';

        // 创建模式切换按钮区域
        const modeSelector = this.createModeSelector();
        this.containerElement.appendChild(modeSelector);

        // 创建内容容器
        const contentContainer = document.createElement('div');
        contentContainer.className = 'prompt-content-container';
        contentContainer.id = 'promptContentContainer';
        this.containerElement.appendChild(contentContainer);

        // 渲染当前模式的内容
        this.renderCurrentMode();
    }

    /**
     * 创建模式切换按钮
     */
    createModeSelector() {
        const container = document.createElement('div');
        container.className = 'prompt-mode-selector';

        const modes = [
            { id: 'original', label: '原始富文本' },
            { id: 'modular', label: '模块化' },
            { id: 'preset', label: '临时与预制' }
        ];

        modes.forEach(mode => {
            const button = document.createElement('button');
            button.className = 'prompt-mode-button';
            button.dataset.mode = mode.id;
            button.textContent = mode.label;
            
            if (this.currentMode === mode.id) {
                button.classList.add('active');
            }

            button.addEventListener('click', () => this.switchMode(mode.id));
            container.appendChild(button);
        });

        return container;
    }

    /**
     * 切换模式
     * @param {string} mode - 目标模式
     */
    async switchMode(mode) {
        if (this.currentMode === mode) return;

        // 保存当前模式的数据
        await this.saveCurrentModeData();

        // 更新模式
        this.currentMode = mode;

        // 保存模式选择到配置
        await this.electronAPI.updateAgentConfig(this.agentId, {
            promptMode: mode
        });

        // 更新UI
        this.updateModeButtons();
        this.renderCurrentMode();

        // 触发Agent设置的完整保存
        if (window.settingsManager && typeof window.settingsManager.triggerAgentSave === 'function') {
            await window.settingsManager.triggerAgentSave();
        }
    }

    /**
     * 更新模式按钮的激活状态
     */
    updateModeButtons() {
        const buttons = this.containerElement.querySelectorAll('.prompt-mode-button');
        buttons.forEach(button => {
            if (button.dataset.mode === this.currentMode) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });
    }

    /**
     * 渲染当前模式的内容
     */
    renderCurrentMode() {
        const contentContainer = document.getElementById('promptContentContainer');
        if (!contentContainer) return;

        contentContainer.innerHTML = '';

        switch (this.currentMode) {
            case 'original':
                if (this.originalModule) {
                    this.originalModule.render(contentContainer);
                }
                break;
            case 'modular':
                if (this.modularModule) {
                    this.modularModule.render(contentContainer);
                }
                break;
            case 'preset':
                if (this.presetModule) {
                    this.presetModule.render(contentContainer);
                }
                break;
        }
    }

    /**
     * 保存当前模式的数据
     */
    async saveCurrentModeData() {
        switch (this.currentMode) {
            case 'original':
                if (this.originalModule) {
                    await this.originalModule.save();
                }
                break;
            case 'modular':
                if (this.modularModule) {
                    await this.modularModule.save();
                }
                break;
            case 'preset':
                if (this.presetModule) {
                    await this.presetModule.save();
                }
                break;
        }
    }

    /**
     * 获取当前激活的系统提示词
     * @returns {string} 格式化后的系统提示词
     */
    async getCurrentSystemPrompt() {
        switch (this.currentMode) {
            case 'original':
                return this.originalModule ? await this.originalModule.getPrompt() : '';
            case 'modular':
                return this.modularModule ? await this.modularModule.getFormattedPrompt() : '';
            case 'preset':
                return this.presetModule ? await this.presetModule.getPrompt() : '';
            default:
                return '';
        }
    }

    /**
     * 外部接口：切换到指定模式（用于插件调用）
     * @param {string} mode - 目标模式
     */
    async setMode(mode) {
        if (['original', 'modular', 'preset'].includes(mode)) {
            await this.switchMode(mode);
        }
    }

    /**
     * 外部接口：获取当前模式
     * @returns {string} 当前模式
     */
    getMode() {
        return this.currentMode;
    }
}

// 导出到全局
window.PromptManager = PromptManager;