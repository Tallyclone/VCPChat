// RAG Observer Configuration Script
// 从全局变量VCP_SETTINGS读取配置并应用主题

class RAGObserverConfig {
    constructor() {
        this.settings = null;
        this.wsConnection = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 3000; // 3秒
        this.isConnecting = false;
    }

    // 读取settings（从全局变量）
    loadSettings() {
        if (window.VCP_SETTINGS) {
            this.settings = window.VCP_SETTINGS;
            return this.settings;
        }
        // 如果无法加载，提供默认值
        console.warn('未找到VCP_SETTINGS，使用默认配置');
        return {
            vcpLogUrl: 'ws://127.0.0.1:5890',
            vcpLogKey: '',
            currentThemeMode: 'dark'
        };
    }

    // 应用主题
    applyTheme(themeMode) {
        const body = document.body;
        if (themeMode === 'light') {
            body.classList.add('light-theme');
        } else {
            body.classList.remove('light-theme');
        }
    }

    // 自动连接WebSocket
    autoConnect(isReconnect = false) {
        if (this.isConnecting) return;
        this.isConnecting = true;

        const settings = this.loadSettings();
        
        // 应用主题 (只在首次连接或设置变化时应用，但这里保持原样，因为它幂等)
        this.applyTheme(settings.currentThemeMode);
        
        // 获取连接信息
        const wsUrl = settings.vcpLogUrl || 'ws://127.0.0.1:5890';
        const vcpKey = settings.vcpLogKey || '';

        if (!vcpKey) {
            console.warn('警告: VCP Key 未设置');
            updateStatus('error', '配置错误：VCP Key 未设置');
            this.isConnecting = false;
            return;
        }

        // 连接WebSocket
        const wsUrlInfo = `${wsUrl}/vcpinfo/VCP_Key=${vcpKey}`;
        
        if (!isReconnect) {
            updateStatus('connecting', `连接中: ${wsUrl}`);
        } else {
            updateStatus('connecting', `重连中 (${this.reconnectAttempts}/${this.maxReconnectAttempts}): ${wsUrl}`);
        }

        this.wsConnection = new WebSocket(wsUrlInfo);
        
        this.wsConnection.onopen = (event) => {
            console.log('WebSocket 连接已建立:', event);
            updateStatus('open', 'VCPInfo 已连接！');
            this.reconnectAttempts = 0; // 连接成功，重置重连计数
            this.isConnecting = false;
        };

        this.wsConnection.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // 检查是否为RAG、元思考链或Agent私聊预览的详细信息
                if (data.type === 'RAG_RETRIEVAL_DETAILS' || data.type === 'META_THINKING_CHAIN' || data.type === 'AGENT_PRIVATE_CHAT_PREVIEW') {
                    if (window.startSpectrumAnimation) {
                        window.startSpectrumAnimation(3000); // 动画持续3秒
                    }
                    displayRagInfo(data); // displayRagInfo内部会处理这两种类型
                }
            } catch (e) {
                console.error('解析消息失败:', e);
            }
        };

        this.wsConnection.onclose = (event) => {
            this.isConnecting = false;
            console.log('WebSocket 连接已关闭:', event);
            updateStatus('closed', '连接已断开。尝试重连...');
            this.reconnect(); // 尝试重连
        };

        this.wsConnection.onerror = (error) => {
            this.isConnecting = false;
            console.error('WebSocket 错误:', error);
            // 错误处理：在 onclose 中处理重连，这里只更新状态
            updateStatus('error', '连接发生错误！请检查服务器或配置。');
        };
    }

    // 尝试重新连接
    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`尝试在 ${this.reconnectDelay / 1000} 秒后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => {
                this.autoConnect(true);
            }, this.reconnectDelay);
        } else {
            updateStatus('error', '连接失败，已达到最大重连次数。请检查配置或服务器状态。');
            console.error('已达到最大重连次数，停止重连。');
        }
    }

    // 定期检查settings变化（可选功能）
    watchSettings(interval = 5000) {
        setInterval(() => {
            const newSettings = this.loadSettings();
            if (newSettings.currentThemeMode !== this.settings?.currentThemeMode) {
                this.applyTheme(newSettings.currentThemeMode);
                this.settings = newSettings;
                console.log('主题已更新:', newSettings.currentThemeMode);
            }
        }, interval);
    }
}

// 页面加载时自动初始化
window.addEventListener('DOMContentLoaded', () => {
    const config = new RAGObserverConfig();
    config.autoConnect();
    // 启动设置监听（每5秒检查一次主题变化）
    config.watchSettings(5000);
});
