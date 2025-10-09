// RAG Observer Configuration Script
// 从全局变量VCP_SETTINGS读取配置并应用主题

class RAGObserverConfig {
    constructor() {
        this.settings = null;
        this.wsConnection = null;
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
    autoConnect() {
        const settings = this.loadSettings();
        
        // 应用主题
        this.applyTheme(settings.currentThemeMode);
        
        // 获取连接信息
        const wsUrl = settings.vcpLogUrl || 'ws://127.0.0.1:5890';
        const vcpKey = settings.vcpLogKey || '';

        if (!vcpKey) {
            console.warn('警告: VCP Key 未设置');
            updateStatus('error', '配置错误：VCP Key 未设置');
            return;
        }

        // 连接WebSocket
        const wsUrlInfo = `${wsUrl}/vcpinfo/VCP_Key=${vcpKey}`;
        updateStatus('connecting', `连接中: ${wsUrl}`);

        this.wsConnection = new WebSocket(wsUrlInfo);
        
        this.wsConnection.onopen = (event) => {
            console.log('WebSocket 连接已建立:', event);
            updateStatus('open', 'VCPInfo 已连接！');
        };

        this.wsConnection.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'RAG_RETRIEVAL_DETAILS') {
                    displayRagInfo(data);
                }
            } catch (e) {
                console.error('解析消息失败:', e);
            }
        };

        this.wsConnection.onclose = (event) => {
            console.log('WebSocket 连接已关闭:', event);
            updateStatus('closed', '连接已断开。刷新页面重新连接。');
        };

        this.wsConnection.onerror = (error) => {
            console.error('WebSocket 错误:', error);
            updateStatus('error', '连接发生错误！请检查服务器或配置。');
        };
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
