// PowerShellViewer.js

// --- 终端初始化 ---
const terminalContainer = document.getElementById('terminal-container');
const commandInput = document.getElementById('command-input');
const sendButton = document.getElementById('send-button');

// 创建 FitAddon 实例
const fitAddon = new FitAddon.FitAddon();

// 创建一个函数来获取CSS变量值
function getCssVariable(variable) {
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: {},
    allowTransparency: true,
    windowsMode: true,
    // 禁用内置的复制行为，我们将通过Electron API手动处理
    copyOnSelect: false 
});

// 将 FitAddon 加载到终端实例中
term.loadAddon(fitAddon);

// 将终端挂载到 HTML 容器中
term.open(terminalContainer);

// --- 功能函数 ---

function fitTerminal() {
    try {
        fitAddon.fit();
        // 在调整前端后，立即将新的尺寸发送到后端
        if (window.electronAPI) {
            window.electronAPI.send('powershell-resize', { cols: term.cols, rows: term.rows });
        }
    } catch (e) {
        console.error("Failed to fit terminal:", e);
    }
}

function sendCommand() {
    const command = commandInput.value;
    if (command.trim() && window.electronAPI) {
        term.write(command + '\r\n');
        window.electronAPI.send('powershell-command', command);
        commandInput.value = '';
        commandInput.focus();
    }
}

// --- IPC 与事件监听 ---

if (window.electronAPI) {
    // --- 数据、清屏与主题 ---
    // 前端现在是一个纯粹的渲染器，所有状态和内容都由后端主导。
    window.electronAPI.on('powershell-data', (data) => {
        term.write(data);
    });

    window.electronAPI.on('powershell-clear', () => {
        term.clear();
    });
    window.electronAPI.on('theme-init', ({ themeName }) => {
        // 移除所有可能存在的主题类，以防万一
        document.body.className = '';
        // 将从后端收到的主题名称作为类添加到body上
        document.body.classList.add(themeName);

        // 延迟执行以确保CSS变量已应用
        setTimeout(() => {
            term.options.theme = {
                background: 'transparent',
                foreground: getCssVariable('--primary-text'),
                cursor: getCssVariable('--highlight-text'),
                selectionBackground: getCssVariable('--accent-bg'),
                black: getCssVariable('--tertiary-bg'),
                red: getCssVariable('--danger-color'),
                green: getCssVariable('--success-color'),
                yellow: getCssVariable('--quoted-text'),
                blue: getCssVariable('--button-bg'),
                magenta: getCssVariable('--highlight-text'),
                cyan: getCssVariable('--secondary-text'),
                white: getCssVariable('--primary-text'),
                brightBlack: getCssVariable('--secondary-text'),
                brightRed: getCssVariable('--danger-hover-bg'),
                brightGreen: getCssVariable('--success-color'),
                brightYellow: getCssVariable('--quoted-text'),
                brightBlue: getCssVariable('--button-hover-bg'),
                brightMagenta: getCssVariable('--highlight-text'),
                brightCyan: getCssVariable('--secondary-text'),
                brightWhite: getCssVariable('--primary-text')
            };
            term.refresh(0, term.rows - 1);
        }, 100);
    });

    // --- 原生复制逻辑 ---
    // 监听右键点击事件，用于复制
    terminalContainer.addEventListener('contextmenu', (e) => {
        e.preventDefault(); // 阻止默认的右键菜单
        const selection = term.getSelection();
        if (selection) {
            window.electronAPI.send('copy-to-clipboard', selection);
        }
    });

    // 监听键盘复制事件 (Ctrl+C)
    term.attachCustomKeyEventHandler((arg) => {
        if (arg.ctrlKey && arg.code === 'KeyC' && arg.type === 'keydown') {
            const selection = term.getSelection();
            if (selection) {
                window.electronAPI.send('copy-to-clipboard', selection);
                return false; // 阻止事件进一步传播，避免终端解释为中断信号
            }
        }
        return true;
    });

} else {
    console.error('Fatal Error: electronAPI not found.');
    term.writeln('Error: Could not connect to the backend.');
}

// --- 窗口与输入监听 ---
window.addEventListener('DOMContentLoaded', () => {
    fitTerminal();
    if (window.electronAPI) {
        window.electronAPI.send('powershell-gui-ready');
    }
});
window.addEventListener('resize', () => setTimeout(fitTerminal, 0));
sendButton.addEventListener('click', sendCommand);
commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendCommand();
});