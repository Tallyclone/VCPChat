// Assistantmodules/assistant-bar.js

document.addEventListener('DOMContentLoaded', () => {
    const assistantAvatar = document.getElementById('assistantAvatar');
    const buttons = document.querySelectorAll('.assistant-button');

    // 1. 监听主进程发来的初始化数据
    window.electronAPI.onAssistantBarData((data) => {
        console.log('Assistant bar received data:', data);
        if (data.agentAvatarUrl) {
            assistantAvatar.src = data.agentAvatarUrl;
        }
        // 应用主题
        document.body.classList.toggle('light-theme', data.theme === 'light');
        document.body.classList.toggle('dark-theme', data.theme === 'dark');
    });

    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Assistant Bar] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
    });

    // 2. 为所有按钮添加点击事件
    buttons.forEach(button => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-action');
            console.log(`Action button clicked: ${action}`);
            // 3. 通知主进程执行操作
            window.electronAPI.assistantAction(action);
        });
    });

    // 当鼠标离开窗口时，自动关闭
    document.body.addEventListener('mouseleave', () => {
        window.electronAPI.closeAssistantBar();
    });
});