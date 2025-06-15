// VCPDistributedServer.js
// VCPDistributedServer.js
const WebSocket = require('ws');
const path = require('path');
const pluginManager = require('./Plugin.js');

// DEBUG_MODE is now passed in config
// const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

class DistributedServer {
    constructor(config = {}) {
        this.mainServerUrl = config.mainServerUrl;
        this.vcpKey = config.vcpKey;
        this.serverName = config.serverName || 'Unnamed-Distributed-Server';
        this.debugMode = config.debugMode || false;
        this.ws = null;
        this.reconnectInterval = 5000;
        this.maxReconnectInterval = 60000;
        this.reconnectTimeoutId = null; // To keep track of the reconnect timeout
        this.stopped = false; // Flag to prevent reconnection when stopped manually
    }

    async initialize() {
        console.log(`[${this.serverName}] Initializing...`);
        // The base path should be relative to this file's location.
        const basePath = path.dirname(require.resolve('./VCPDistributedServer.js'));
        pluginManager.setProjectBasePath(basePath);
        await pluginManager.loadPlugins();
        this.connect();
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

        const connectionUrl = `${this.mainServerUrl}/vcp-distributed-server/VCP_Key=${this.vcpKey}`;
        console.log(`[${this.serverName}] Attempting to connect to main server at ${this.mainServerUrl}`);

        this.ws = new WebSocket(connectionUrl);

        this.ws.on('open', () => {
            console.log(`[${this.serverName}] Successfully connected to main server.`);
            this.reconnectInterval = 5000; // Reset reconnect interval on successful connection
            this.registerTools();
        });

        this.ws.on('message', (message) => {
            this.handleMainServerMessage(message);
        });

        this.ws.on('close', () => {
            console.log(`[${this.serverName}] Disconnected from main server.`);
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error(`[${this.serverName}] WebSocket error:`, error.message);
            // The 'close' event will be triggered next, which handles reconnection.
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
            // Use the new processToolCall method to handle argument formatting
            const result = await pluginManager.processToolCall(toolName, toolArgs);
            
            let parsedResult;
            try {
                // The result from the plugin is expected to be a JSON string.
                parsedResult = JSON.parse(result);
            } catch (e) {
                // If not JSON, wrap it.
                parsedResult = { original_plugin_output: result };
            }

            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'success',
                    result: parsedResult
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