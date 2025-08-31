// VCPDistributedServer.js
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const dotenv = require('dotenv');
const os = require('os');
const mime = require('mime-types');
 // const { ipcMain } = require('electron'); // This was incorrect. ipcMain should be injected.
 const pluginManager = require('./Plugin.js');

// DEBUG_MODE is now passed in config
// const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

class DistributedServer {
    constructor(config = {}) {
        this.mainServerUrl = config.mainServerUrl;
        this.vcpKey = config.vcpKey;
        this.serverName = config.serverName || 'Unnamed-Distributed-Server';
        this.port = config.port || 0; // 0 表示随机选择一个可用端口
        this.debugMode = config.debugMode || false;
        this.rendererProcess = config.rendererProcess; // To communicate with the renderer
        this.handleMusicControl = config.handleMusicControl; // Inject the music control handler
        this.handleDiceControl = config.handleDiceControl; // Inject the dice control handler
        this.handleCanvasControl = config.handleCanvasControl; // Inject the canvas control handler
        this.ws = null;
        this.app = express(); // 创建 Express 应用
        this.server = http.createServer(this.app); // 创建 HTTP 服务器
        this.reconnectInterval = 5000;
        this.maxReconnectInterval = 60000;
        this.reconnectTimeoutId = null; // To keep track of the reconnect timeout
        this.stopped = false; // Flag to prevent reconnection when stopped manually
        this.initialConnection = true; // Flag to handle one-time actions on first connect
    }

    async initialize() {
        console.log(`[${this.serverName}] Initializing...`);

        // Load server-specific config
        const serverConfigPath = path.join(__dirname, 'config.env');
        try {
            if (fsSync.existsSync(serverConfigPath)) {
                const serverEnv = dotenv.parse(fsSync.readFileSync(serverConfigPath));
                if (serverEnv.DIST_SERVER_PORT) {
                    const newPort = parseInt(serverEnv.DIST_SERVER_PORT, 10);
                    if (!isNaN(newPort)) {
                        this.port = newPort;
                        console.log(`[${this.serverName}] Port loaded from config.env: ${this.port}`);
                    }
                }
            }
        } catch (e) {
            console.error(`[${this.serverName}] Error reading server config.env:`, e);
        }

        // The base path should be relative to this file's location.
        const basePath = path.dirname(require.resolve('./VCPDistributedServer.js'));
        pluginManager.setProjectBasePath(basePath);
        await pluginManager.loadPlugins();

        // 初始化服务类插件
        await pluginManager.initializeServices(this.app, null, basePath);

        this.server.listen(this.port, '0.0.0.0', () => {
            this.port = this.server.address().port; // 获取实际监听的端口
            console.log(`[${this.serverName}] HTTP server listening on 0.0.0.0:${this.port}`);
            // 在 HTTP 服务器启动后，再连接到主服务器
            this.connect();
        });
    }

    connect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Server is stopped, not connecting.`);
            return;
        }
        if (!this.mainServerUrl || !this.vcpKey) {
            console.error(`[${this.serverName}] Error: mainServerUrl or vcpKey is not configured. Cannot connect.`);
            return;
        }

        const connectionUrl = `${this.mainServerUrl.replace(/^http/, 'ws')}/vcp-distributed-server/VCP_Key=${this.vcpKey}`;
        console.log(`[${this.serverName}] Attempting to connect to main server at ${connectionUrl}`);

        // this.ws 现在是一个纯粹的客户端实例
        this.ws = new WebSocket(connectionUrl);

        this.ws.on('open', async () => {
            console.log(`[${this.serverName}] Successfully connected to main server.`);
            this.reconnectInterval = 5000;
            this.registerTools();
            await this.reportIPAddress();
        });

        this.ws.on('message', (message) => {
            this.handleMainServerMessage(message);
        });
        
        this.ws.on('close', () => {
            console.log(`[${this.serverName}] Disconnected from main server.`);
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error(`[${this.serverName}] WebSocket client error:`, error.message);
            // 'close' 事件会自动被触发，所以这里不需要额外的处理
        });
    }

    scheduleReconnect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Stop called, cancelling reconnection.`);
            return;
        }
        console.log(`[${this.serverName}] Attempting to reconnect in ${this.reconnectInterval / 1000}s...`);
        // Clear any existing timeout to avoid multiple reconnect loops
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
        }
        this.reconnectTimeoutId = setTimeout(() => this.connect(), this.reconnectInterval);
        // Exponential backoff
        this.reconnectInterval = Math.min(this.reconnectInterval * 2, this.maxReconnectInterval);
    }

    registerTools() {
        const manifests = pluginManager.getAllPluginManifests();

        // On the very first successful connection, send a notification about loaded plugins.
        if (this.initialConnection && manifests.length > 0) {
            const pluginCount = manifests.length;
            // Directly send a structured message to the renderer process for notification
            if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                // Add a delay to give the renderer process time to set up its listeners
                setTimeout(() => {
                    if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                        this.rendererProcess.send('vcp-log-message', {
                            type: 'vcp_log',
                            data: {
                                source: 'DistPluginManager',
                                content: `分布式服务器已启动，已推送 ${pluginCount} 个本地插件。`
                            }
                        });
                    }
                }, 1000); // 2-second delay
            }
            this.initialConnection = false; // Ensure this only runs once
        }

        if (manifests.length > 0) {
            const payload = {
                type: 'register_tools',
                data: {
                    serverName: this.serverName,
                    tools: manifests
                }
            };
            this.sendMessage(payload);
            console.log(`[${this.serverName}] Sent registration for ${manifests.length} tools to the main server.`);
        } else {
            if (this.debugMode) console.log(`[${this.serverName}] No local tools found to register.`);
        }
    }

    async reportIPAddress() {
        const { default: fetch } = await import('node-fetch');
        const networkInterfaces = os.networkInterfaces();
        const ipv4Addresses = [];
        let publicIp = null;

        for (const interfaceName in networkInterfaces) {
            const interfaces = networkInterfaces[interfaceName];
            for (const iface of interfaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ipv4Addresses.push(iface.address);
                }
            }
        }

        try {
            const response = await fetch('https://api.ipify.org?format=json');
            if (response.ok) {
                const data = await response.json();
                publicIp = data.ip;
            } else {
                console.error(`[${this.serverName}] Failed to fetch public IP, status: ${response.status}`);
            }
        } catch (e) {
            console.error(`[${this.serverName}] Could not fetch public IP:`, e.message);
        }
        
        const payload = {
            type: 'report_ip',
            data: {
                serverName: this.serverName,
                localIPs: ipv4Addresses,
                publicIP: publicIp
            }
        };
        this.sendMessage(payload);
        console.log(`[${this.serverName}] Reported IP addresses to main server: Local: ${ipv4Addresses.join(', ')}, Public: ${publicIp || 'N/A'}`);
    }

    async handleMainServerMessage(message) {
        try {
            const parsedMessage = JSON.parse(message);
            if (this.debugMode) console.log(`[${this.serverName}] Received message from main server:`, parsedMessage.type);

            if (parsedMessage.type === 'execute_tool') {
                await this.handleToolExecutionRequest(parsedMessage.data);
            }
        } catch (e) {
            console.error(`[${this.serverName}] Error parsing message from main server:`, e);
        }
    }

    async handleToolExecutionRequest(data) {
        const { requestId, toolName, toolArgs } = data;
        if (!requestId || !toolName) {
            console.error(`[${this.serverName}] Invalid tool execution request received.`);
            return;
        }

        if (this.debugMode) console.log(`[${this.serverName}] Executing tool '${toolName}' for request ID: ${requestId}`);

        let responsePayload;
        try {
            // --- 新增：处理内部文件请求 ---
            if (toolName === 'internal_request_file') {
                const filePath = toolArgs.filePath;
                try {
                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
                    
                    responsePayload = {
                        type: 'tool_result',
                        data: {
                            requestId,
                            status: 'success',
                            result: {
                                status: 'success',
                                fileData: fileBuffer.toString('base64'),
                                mimeType: mimeType
                            }
                        }
                    };
                } catch (e) {
                    if (e.code === 'ENOENT') {
                        throw new Error(`File not found on distributed server: ${filePath}`);
                    } else {
                        throw new Error(`Error reading file on distributed server: ${e.message}`);
                    }
                }
                this.sendMessage(responsePayload);
                if (this.debugMode) console.log(`[${this.serverName}] Sent file content for request ID: ${requestId}`);
                return; // 处理完毕，直接返回
            }
            // --- 结束：处理内部文件请求 ---

            const result = await pluginManager.processToolCall(toolName, toolArgs);
            let finalResult;

            // --- Special Handling for MusicController ---
            if (toolName === 'MusicController') {
                const commandPayload = JSON.parse(result);
                if (commandPayload.status === 'error') {
                    throw new Error(commandPayload.error);
                }
                
                if (typeof this.handleMusicControl !== 'function') {
                    throw new Error('Music control handler is not configured for the Distributed Server.');
                }

                // Directly call the injected handler function from main.js
                const resultFromMain = await this.handleMusicControl(commandPayload);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // For AI, we want a simple, natural language response.
                let naturalResponse = `指令 '${commandPayload.command}' 已成功执行。`;
                if (commandPayload.command === 'play' && commandPayload.target) {
                    naturalResponse = `已为您播放歌曲: ${commandPayload.target}`;
                } else if (commandPayload.command === 'play') {
                    naturalResponse = `已恢复播放。`;
                } else if (commandPayload.command === 'pause') {
                    naturalResponse = `已暂停播放。`;
                } else if (commandPayload.command === 'next') {
                    naturalResponse = `已切换到下一首。`;
                } else if (commandPayload.command === 'prev') {
                    naturalResponse = `已切换到上一首。`;
                }
                finalResult = { message: naturalResponse };

            } else if (toolName === 'SuperDice') {
                if (typeof this.handleDiceControl !== 'function') {
                    throw new Error('Dice control handler is not configured for the Distributed Server.');
                }
                // The toolArgs are already parsed, e.g., { notation: '2d20' }
                const resultFromMain = await this.handleDiceControl(toolArgs);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // The result from the dice roll is already structured, so we can pass it directly.
                finalResult = resultFromMain.data;

            } else {
                // --- Default Handling for all other plugins ---
                try {
                    // First, try to parse the result as JSON, which is the modern contract.
                    const parsedPluginResult = JSON.parse(result);
                    if (parsedPluginResult.status === 'success') {
                        finalResult = parsedPluginResult.result;

                        // --- Special Handling for create_canvas action ---
                        if (finalResult && finalResult._specialAction === 'create_canvas') {
                            if (typeof this.handleCanvasControl === 'function') {
                                console.log(`[${this.serverName}] Detected create_canvas action. Calling main process handler.`);
                                // Directly call the injected handler from main.js
                                this.handleCanvasControl(finalResult.payload.filePath);
                            } else {
                                console.error(`[${this.serverName}] Canvas control handler is not configured for the Distributed Server.`);
                            }
                        }
                        // --- End of special handling ---

                    } else {
                        // If the plugin itself reported an error, throw it to be caught below.
                        throw new Error(parsedPluginResult.error || 'Plugin reported an error without a message.');
                    }
                } catch (e) {
                    // If parsing fails, assume it's a legacy plugin returning a raw string.
                    // We check if the error is a JSON parsing error.
                    if (e instanceof SyntaxError) {
                        finalResult = result; // Use the raw output as the result.
                    } else {
                        // If it's another type of error (e.g., from the 'else' block above), re-throw it.
                        throw e; // Re-throw the original error to be handled by the outer catch block.
                    }
                }
            }

            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'success',
                    result: finalResult
                }
            };
        } catch (error) {
            console.error(`[${this.serverName}] Error executing tool '${toolName}':`, error.message);
            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'error',
                    error: error.message || 'An unknown error occurred.'
                }
            };
        }

        this.sendMessage(responsePayload);
        if (this.debugMode) console.log(`[${this.serverName}] Sent result for request ID: ${requestId}`);
    }

    sendMessage(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.error(`[${this.serverName}] Cannot send message, WebSocket is not open.`);
        }
    }

    stop() {
        console.log(`[${this.serverName}] Stopping server...`);
        this.stopped = true;
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
        if (this.ws) {
            // Remove listeners to prevent reconnection logic from firing on manual close
            this.ws.removeAllListeners('close');
            this.ws.removeAllListeners('error');
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, 'Client initiated disconnect'); // 1000 is a normal closure
            }
            this.ws = null;
        }
        console.log(`[${this.serverName}] Server stopped.`);
    }
}

module.exports = DistributedServer;