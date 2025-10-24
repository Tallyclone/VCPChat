// PowerShellViewer.js

// xterm.js 和 FitAddon 现在通过 <script> 标签在 PowerShellViewer.html 中全局引入
// 因此不再需要使用 require()

// --- 终端初始化 ---
const terminalContainer = document.getElementById('terminal-container');

// 创建 FitAddon 实例
// 当通过 <script> 标签加载时, 构造函数位于 FitAddon.FitAddon
const fitAddon = new FitAddon.FitAddon();

// 创建终端实例
const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: {
        background: '#1e1e2e', // Catppuccin Macchiato Base
        foreground: '#cdd6f4', // Text
        cursor: '#f5e0dc',     // Rosewater
        selectionBackground: '#585b70', // Surface2
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#89dceb',
        white: '#a6adc8',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#89dceb',
        brightWhite: '#cdd6f4'
    },
    // 允许透明度，以便背景色生效
    allowTransparency: true,
    // 启用 Windows 的 Ctrl+C/Ctrl+V
    windowsMode: true
});

// 将 FitAddon 加载到终端实例中
term.loadAddon(fitAddon);

// 将终端挂载到 HTML 容器中
term.open(terminalContainer);

// --- 功能函数 ---

/**
 * 使终端尺寸适应其容器的大小
 */
function fitTerminal() {
    try {
        fitAddon.fit();
    } catch (e) {
        console.error("Failed to fit terminal:", e);
    }
}

// --- IPC 通信 ---

// 检查 preload 脚本是否成功注入了 API
if (window.electronAPI) {
    // 监听来自后端的终端数据流
    window.electronAPI.on('powershell-data', (data) => {
        // 将收到的数据写入前端终端
        term.write(data);
    });

    // 监听后端发送的清除终端的指令
    window.electronAPI.on('powershell-clear', () => {
        term.clear();
    });
} else {
    console.error('Fatal Error: electronAPI not found. Preload script might have failed.');
    term.writeln('Error: Could not connect to the backend. Please check the console for details.');
}

// --- 初始化和事件监听 ---

// 页面加载完成后，立即调整一次终端尺寸
window.addEventListener('DOMContentLoaded', () => {
    fitTerminal();
    // 可以在这里向后端发送一个信号，表示GUI已准备就绪
    if (window.electronAPI) {
        window.electronAPI.send('powershell-gui-ready');
    }
});

// 当窗口大小改变时，重新调整终端尺寸
window.addEventListener('resize', fitTerminal);

// 示例：显示欢迎信息
term.writeln('Welcome to VCP PowerShell Terminal!');
term.writeln('Waiting for AI commands...');