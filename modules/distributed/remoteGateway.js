const WebSocket = require('ws');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');

const SUPPORTED_CANVAS_EXTENSIONS = [
    '.txt', '.js', '.py', '.css', '.html', '.json', '.md', '.rs', '.ts',
    '.cpp', '.h', '.cs', '.java', '.go', '.rb', '.php', '.swift', '.kt',
    '.sh', '.yml', '.yaml', '.toml', '.xml'
];

const groupChat = require('../../Groupmodules/groupchat');

class RemoteGateway {
    constructor(config) {
        this.port = config.port || 17888;
        this.host = config.host || '0.0.0.0';
        this.token = config.token || '';
        this.settingsManager = config.settingsManager;
        this.agentConfigManager = config.agentConfigManager;
        this.vcpClient = config.vcpClient;
        this.paths = config.paths;
        this.projectRoot = config.projectRoot;
        this.connectVcpLogCallback = config.connectVcpLog;
        this.disconnectVcpLogCallback = config.disconnectVcpLog;
        this.getCurrentThemeCallback = config.getCurrentTheme;
        this.getCachedModelsCallback = config.getCachedModels;
        this.refreshModelsCallback = config.refreshModels;
        this.musicHandlers = config.musicHandlers || null;
        this.logger = config.logger || console;

        this.server = null;
        this.wss = null;
        this.clients = new Set();
        this.heartbeatTimer = null;

        this.maxPayloadBytes = config.maxPayloadBytes || 1024 * 1024; // 1MB
        this.maxConcurrentRpcPerClient = config.maxConcurrentRpcPerClient || 16;
        this.heartbeatIntervalMs = config.heartbeatIntervalMs || 30000;

        this.auditLogFile = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'remote_gateway_audit.log');
    }

    async start() {
        this.server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ status: 'ok', service: 'vchat-remote-gateway' }));
                return;
            }

            if (req.url === '/meta') {
                const settings = await this.settingsManager.readSettings();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    service: 'vchat-remote-gateway',
                    protocolVersion: 1,
                    protocolCompat: [1],
                    serverVersion: '1.2.0',
                    capabilities: ['chat', 'topics', 'agents', 'settings', 'stream', 'canvas', 'file', 'themes', 'vcplog', 'models', 'search', 'prompt', 'group', 'notes', 'forum', 'memo', 'music'],
                    mode: settings.remoteGatewayEnabled ? 'enabled' : 'disabled'
                }));
                return;
            }

            if (req.url === '/remote-manifest') {
                const settings = await this.settingsManager.readSettings();
                const hostHeader = req.headers.host || `${this.host}:${this.port}`;
                const base = `http://${hostHeader}`;
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    version: settings.remoteBundleVersion || Date.now().toString(),
                    updatedAt: settings.remoteBundleUpdatedAt || Date.now(),
                    desktopBundleUrl: `${base}/remote-bundles/desktop/index.html`,
                    mobileBundleUrl: `${base}/remote-bundles/mobile/index.html`,
                    notes: 'Remote bundle manifest for hot-update style loading'
                }));
                return;
            }

            if (req.url && req.url.startsWith('/remote-bundles/')) {
                const relativePath = decodeURIComponent(req.url.replace('/remote-bundles/', '')).replace(/^\/+/, '');
                const bundlesRoot = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'RemoteBundles');
                const absolutePath = path.join(bundlesRoot, relativePath);
                this.ensurePathAllowed(absolutePath, [bundlesRoot]);

                if (!(await fs.pathExists(absolutePath))) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Bundle file not found' }));
                    return;
                }

                const ext = path.extname(absolutePath).toLowerCase();
                const contentTypeMap = {
                    '.html': 'text/html; charset=utf-8',
                    '.js': 'application/javascript; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.svg': 'image/svg+xml'
                };
                const contentType = contentTypeMap[ext] || 'application/octet-stream';
                const content = await fs.readFile(absolutePath);
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        });

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (socket) => this.handleConnection(socket));

        this.startHeartbeat();

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, this.host, () => {
                this.logger.log(`[RemoteGateway] listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const client of this.clients) {
            try {
                client.close();
            } catch (e) {
                // ignore
            }
        }
        this.clients.clear();

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    handleConnection(socket) {
        socket.isAuthed = false;
        socket.clientId = null;
        socket.rpcInFlight = 0;
        socket.isAlive = true;
        this.clients.add(socket);

        socket.send(JSON.stringify({
            type: 'hello',
            protocolVersion: 1,
            protocolCompat: [1],
            requiresAuth: true
        }));

        socket.on('pong', () => {
            socket.isAlive = true;
        });

        socket.on('message', async (rawMessage) => {
            try {
                const messageSize = Buffer.byteLength(rawMessage);

                if (messageSize > this.maxPayloadBytes) {
                    throw new Error(`Payload too large. Max ${this.maxPayloadBytes} bytes`);
                }

                const message = JSON.parse(rawMessage.toString());
                await this.handleMessage(socket, message);
            } catch (error) {
                socket.send(JSON.stringify({ type: 'error', error: error.message || 'Invalid message' }));
            }
        });

        socket.on('close', () => {
            this.clients.delete(socket);
        });

        socket.on('error', () => {
            this.clients.delete(socket);
        });
    }

    async handleMessage(socket, message) {
        if (message.type === 'auth') {
            const ok = !!this.token && message.token === this.token;
            if (!ok) {
                socket.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Invalid token' }));
                socket.close();
                return;
            }

            socket.isAuthed = true;
            socket.clientId = message.clientId || `client_${Date.now()}`;
            socket.send(JSON.stringify({ type: 'auth_result', success: true, clientId: socket.clientId }));

            await this.audit('auth.success', socket, {});
            return;
        }

        if (!socket.isAuthed) {
            socket.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
            return;
        }

        if (message.type === 'rpc') {
            if (socket.rpcInFlight >= this.maxConcurrentRpcPerClient) {
                socket.send(JSON.stringify({
                    type: 'rpc_result',
                    id: message.id,
                    success: false,
                    error: `Too many concurrent RPC. Limit=${this.maxConcurrentRpcPerClient}`
                }));
                return;
            }

            socket.rpcInFlight += 1;
            try {
                const result = await this.executeMethod(message.method, message.params || {}, socket);
                socket.send(JSON.stringify({ type: 'rpc_result', id: message.id, success: true, result }));
            } catch (e) {
                socket.send(JSON.stringify({ type: 'rpc_result', id: message.id, success: false, error: e.message }));
            } finally {
                socket.rpcInFlight = Math.max(0, socket.rpcInFlight - 1);
            }
        }
    }

    ensureRole(_socket, _requiredRole) {
        // 个人自用简化：token 鉴权通过即允许调用
        return;
    }

    async saveSettings(settingsPatch = {}, socket) {
        if (!settingsPatch || typeof settingsPatch !== 'object' || Array.isArray(settingsPatch)) {
            throw new Error('settingsPatch must be an object');
        }

        await this.settingsManager.updateSettings(existing => ({
            ...existing,
            ...settingsPatch,
            updatedAt: Date.now()
        }));

        const settings = await this.settingsManager.readSettings();
        this.publish('settings.updated', {
            by: socket?.clientId || 'unknown',
            updatedAt: Date.now(),
            keys: Object.keys(settingsPatch || {})
        });
        await this.audit('settings.updated', socket, { keys: Object.keys(settingsPatch || {}) });

        return settings;
    }

    async executeMethod(method, params, socket) {
        switch (method) {
            case 'loadSettings':
                this.ensureRole(socket, 'viewer');
                return this.settingsManager.readSettings();
            case 'saveSettings':
                this.ensureRole(socket, 'operator');
                return this.saveSettings(params.settingsPatch || {}, socket);
            case 'getAgents':
                this.ensureRole(socket, 'viewer');
                return this.getAgents();
            case 'getAllItems':
                this.ensureRole(socket, 'viewer');
                return this.getAllItems();
            case 'createAgent':
                this.ensureRole(socket, 'operator');
                return this.createAgent(params.agentName, params.initialConfig, socket);
            case 'deleteAgent':
                this.ensureRole(socket, 'operator');
                return this.deleteAgent(params.agentId, socket);
            case 'saveAgentOrder':
                this.ensureRole(socket, 'operator');
                return this.saveAgentOrder(params.orderedAgentIds || [], socket);
            case 'saveCombinedItemOrder':
                this.ensureRole(socket, 'operator');
                return this.saveCombinedItemOrder(params.orderedItemsWithTypes || [], socket);
            case 'getGlobalWarehouse':
                return this.getGlobalWarehouse();
            case 'saveGlobalWarehouse':
                return this.saveGlobalWarehouse(params.data, socket);
            case 'loadPresetPrompts':
                return this.loadPresetPrompts(params.presetPath);
            case 'loadPresetContent':
                return this.loadPresetContent(params.filePath);
            case 'getActiveSystemPrompt':
                return this.getActiveSystemPrompt(params.agentId);
            case 'programmaticSetPromptMode':
                return this.programmaticSetPromptMode(params.agentId, params.mode, socket);
            case 'getAgentConfig':
                this.ensureRole(socket, 'viewer');
                return this.getAgentConfig(params.agentId);
            case 'saveAgentConfig':
                this.ensureRole(socket, 'operator');
                return this.saveAgentConfig(params.agentId, params.config, socket);
            case 'getAgentTopics':
                this.ensureRole(socket, 'viewer');
                return this.getAgentTopics(params.agentId);
            case 'renameTopic':
                this.ensureRole(socket, 'operator');
                return this.renameTopic(params.agentId, params.topicId, params.newTitle, socket);
            case 'deleteTopic':
                this.ensureRole(socket, 'operator');
                return this.deleteTopic(params.agentId, params.topicId, socket);
            case 'saveTopicOrder':
                this.ensureRole(socket, 'operator');
                return this.saveTopicOrder(params.agentId, params.orderedTopicIds, socket);
            case 'setTopicUnread':
                this.ensureRole(socket, 'operator');
                return this.setTopicUnread(params.agentId, params.topicId, params.unread, socket);
            case 'toggleTopicLock':
                this.ensureRole(socket, 'operator');
                return this.toggleTopicLock(params.agentId, params.topicId, socket);
            case 'getChatHistory':
                this.ensureRole(socket, 'viewer');
                return this.getChatHistory(params.agentId, params.topicId);
            case 'saveChatHistory':
                this.ensureRole(socket, 'operator');
                return this.saveChatHistory(params.agentId, params.topicId, params.history, socket);
            case 'createNewTopicForAgent':
                this.ensureRole(socket, 'operator');
                return this.createNewTopicForAgent(params.agentId, params.topicName, params.locked, socket);
            case 'sendToVCP':
                this.ensureRole(socket, 'operator');
                return this.sendToVCP(params, socket);
            case 'getCanvasHistory':
                this.ensureRole(socket, 'viewer');
                return this.getCanvasHistory();
            case 'getCanvasContent':
                this.ensureRole(socket, 'viewer');
                return this.getCanvasContent(params.filePath);
            case 'saveCanvasContent':
                this.ensureRole(socket, 'operator');
                return this.saveCanvasContent(params.filePath, params.content, socket);
            case 'createCanvas':
                this.ensureRole(socket, 'operator');
                return this.createCanvas(params.title, socket);
            case 'readHostFile':
                this.ensureRole(socket, 'admin');
                return this.readHostFile(params.filePath, socket);
            case 'getThemes':
                return this.getThemes();
            case 'applyTheme':
                return this.applyTheme(params.themeFileName, socket);
            case 'getCurrentTheme':
                return this.getCurrentTheme();
            case 'connectVCPLog':
                return this.connectVCPLog(params.url, params.key, socket);
            case 'disconnectVCPLog':
                return this.disconnectVCPLog(socket);
            case 'getCachedModels':
                return this.getCachedModels();
            case 'refreshModels':
                return this.refreshModels(socket);
            case 'exportTopicAsMarkdown':
                return this.exportTopicAsMarkdown(params.topicName, params.markdownContent, socket);
            case 'getUnreadTopicCounts':
                return this.getUnreadTopicCounts();
            case 'searchTopicsByContent':
                return this.searchTopicsByContent(params.itemId, params.itemType, params.searchTerm);
            case 'uploadRemoteBundle':
                return this.uploadRemoteBundle(params.platform, params.fileName, params.base64, socket);
            case 'listRemoteBundles':
                return this.listRemoteBundles(params.platform);
            case 'setRemoteBundleVersion':
                return this.setRemoteBundleVersion(params.version, socket);
            case 'getFileAsBase64':
                return this.getFileAsBase64(params.filePath, socket);
            case 'getTextContent':
                return this.getTextContent(params.filePath, params.fileType, socket);
            case 'handleTextPasteAsFile':
                return this.handleTextPasteAsFile(params.agentId, params.topicId, params.textContent, socket);
            case 'handleTextPasteAsGroupFile':
                return this.handleTextPasteAsGroupFile(params.groupId, params.topicId, params.textContent, socket);

            case 'createAgentGroup':
                return this.createAgentGroup(params.groupName, params.initialConfig, socket);
            case 'getAgentGroups':
                return this.getAgentGroups();
            case 'getAgentGroupConfig':
                return this.getAgentGroupConfig(params.groupId);
            case 'saveAgentGroupConfig':
                return this.saveAgentGroupConfig(params.groupId, params.configData, socket);
            case 'deleteAgentGroup':
                return this.deleteAgentGroup(params.groupId, socket);
            case 'getGroupTopics':
                return this.getGroupTopics(params.groupId, params.searchTerm);
            case 'createNewTopicForGroup':
                return this.createNewTopicForGroup(params.groupId, params.topicName, socket);
            case 'deleteGroupTopic':
                return this.deleteGroupTopic(params.groupId, params.topicId, socket);
            case 'saveGroupTopicTitle':
                return this.saveGroupTopicTitle(params.groupId, params.topicId, params.newTitle, socket);
            case 'getGroupChatHistory':
                return this.getGroupChatHistory(params.groupId, params.topicId);
            case 'saveGroupChatHistory':
                return this.saveGroupChatHistory(params.groupId, params.topicId, params.history, socket);
            case 'sendGroupChatMessage':
                return this.sendGroupChatMessage(params.groupId, params.topicId, params.userMessage, socket);

            case 'readNotesTree':
                return this.readNotesTree();
            case 'writeTxtNote':
                return this.writeTxtNote(params.noteData, socket);
            case 'deleteItem':
                return this.deleteItem(params.itemPath, socket);
            case 'createNoteFolder':
                return this.createNoteFolder(params.parentPath, params.folderName, socket);
            case 'renameItem':
                return this.renameItem(params.data, socket);
            case 'notesMoveItems':
                return this.notesMoveItems(params.data, socket);
            case 'searchNotes':
                return this.searchNotes(params.query);
            case 'getCachedNetworkNotes':
                return this.getCachedNetworkNotes();

            case 'loadForumConfig':
                return this.loadForumConfig();
            case 'saveForumConfig':
                return this.saveForumConfig(params.config, socket);
            case 'loadAgentsList':
                return this.loadAgentsList();
            case 'loadUserAvatar':
                return this.loadUserAvatar();
            case 'loadAgentAvatar':
                return this.loadAgentAvatar(params.folderName);
            case 'loadMemoConfig':
                return this.loadMemoConfig();
            case 'saveMemoConfig':
                return this.saveMemoConfig(params.config, socket);

            case 'getMusicPlaylist':
                return this.getMusicPlaylist();
            case 'getCustomPlaylists':
                return this.getCustomPlaylists();
            case 'musicLoad':
                return this.musicLoad(params.track, socket);
            case 'musicPlay':
                return this.musicPlay(socket);
            case 'musicPause':
                return this.musicPause(socket);
            case 'musicSeek':
                return this.musicSeek(params.positionSeconds, socket);
            case 'musicGetState':
                return this.musicGetState();
            case 'musicSetVolume':
                return this.musicSetVolume(params.volume, socket);
            case 'musicGetDevices':
                return this.musicGetDevices(params.options || {});
            case 'musicConfigureOutput':
                return this.musicConfigureOutput(params.data || {}, socket);
            case 'musicSetEq':
                return this.musicSetEq(params.data || {}, socket);
            case 'musicSetEqType':
                return this.musicSetEqType(params.data || {}, socket);
            case 'musicConfigureOptimizations':
                return this.musicConfigureOptimizations(params.data || {}, socket);
            case 'musicConfigureUpsampling':
                return this.musicConfigureUpsampling(params.data || {}, socket);
            case 'musicGetLyrics':
                return this.musicGetLyrics(params.data || {});
            case 'musicFetchLyrics':
                return this.musicFetchLyrics(params.data || {});

            default:
                throw new Error(`Unknown method: ${method}`);
        }
    }

    async getAgents() {
        const { AGENT_DIR } = this.paths;
        const folders = await fs.readdir(AGENT_DIR);
        const agents = [];

        for (const folderName of folders) {
            const agentPath = path.join(AGENT_DIR, folderName);
            const stat = await fs.stat(agentPath);
            if (!stat.isDirectory()) continue;

            const configPath = path.join(agentPath, 'config.json');
            let config = {};
            if (await fs.pathExists(configPath)) {
                config = await fs.readJson(configPath);
            }

            agents.push({
                id: folderName,
                name: config.name || folderName,
                config,
                type: 'agent'
            });
        }

        return agents;
    }

    async getAllItems() {
        const agents = await this.getAgents();
        return { success: true, items: [...agents] };
    }

    async createAgent(agentName, initialConfig = null, socket) {
        if (!agentName || typeof agentName !== 'string') {
            throw new Error('agentName is required');
        }

        const baseName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const agentId = `${baseName}_${Date.now()}`;
        const agentDir = path.join(this.paths.AGENT_DIR, agentId);

        if (await fs.pathExists(agentDir)) {
            throw new Error('Agent folder already exists');
        }

        await fs.ensureDir(agentDir);

        let configToSave;
        if (initialConfig) {
            configToSave = { ...initialConfig, name: agentName };
        } else {
            configToSave = {
                name: agentName,
                systemPrompt: `你是 ${agentName}。`,
                model: 'gemini-2.5-flash-preview-05-20',
                temperature: 0.7,
                contextTokenLimit: 1000000,
                maxOutputTokens: 60000,
                topics: [{ id: 'default', name: '主要对话', createdAt: Date.now() }],
                disableCustomColors: true,
                useThemeColorsInChat: true
            };
        }

        if (!Array.isArray(configToSave.topics) || configToSave.topics.length === 0) {
            configToSave.topics = [{ id: 'default', name: '主要对话', createdAt: Date.now() }];
        }

        if (this.agentConfigManager) {
            await this.agentConfigManager.writeAgentConfig(agentId, configToSave);
        } else {
            await fs.writeJson(path.join(agentDir, 'config.json'), configToSave, { spaces: 2 });
        }

        const firstTopicId = configToSave.topics[0].id || 'default';
        const topicHistoryDir = path.join(this.paths.USER_DATA_DIR, agentId, 'topics', firstTopicId);
        await fs.ensureDir(topicHistoryDir);
        const historyFilePath = path.join(topicHistoryDir, 'history.json');
        if (!await fs.pathExists(historyFilePath)) {
            await fs.writeJson(historyFilePath, [], { spaces: 2 });
        }

        this.publish('agent.created', { agentId, agentName, by: socket?.clientId || 'unknown', createdAt: Date.now() });
        await this.audit('agent.created', socket, { agentId, agentName });

        return { success: true, agentId, agentName, config: configToSave, avatarUrl: null };
    }

    async deleteAgent(agentId, socket) {
        if (!agentId) throw new Error('agentId is required');

        const agentDir = path.join(this.paths.AGENT_DIR, agentId);
        const userDataAgentDir = path.join(this.paths.USER_DATA_DIR, agentId);
        if (await fs.pathExists(agentDir)) await fs.remove(agentDir);
        if (await fs.pathExists(userDataAgentDir)) await fs.remove(userDataAgentDir);

        this.publish('agent.deleted', { agentId, by: socket?.clientId || 'unknown', deletedAt: Date.now() });
        await this.audit('agent.deleted', socket, { agentId });

        return { success: true, message: `Agent ${agentId} 已删除。` };
    }

    async saveAgentOrder(orderedAgentIds, socket) {
        if (!Array.isArray(orderedAgentIds)) throw new Error('orderedAgentIds must be an array');

        const normalized = orderedAgentIds.map(id => String(id || '').trim()).filter(Boolean);
        await this.settingsManager.updateSettings(existing => ({
            ...existing,
            agentOrder: normalized
        }));

        this.publish('agent.order.updated', { orderedAgentIds: normalized, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('agent.order.updated', socket, { count: normalized.length });
        return { success: true, orderedAgentIds: normalized };
    }

    async saveCombinedItemOrder(orderedItemsWithTypes, socket) {
        if (!Array.isArray(orderedItemsWithTypes)) throw new Error('orderedItemsWithTypes must be an array');

        await this.settingsManager.updateSettings(existing => ({
            ...existing,
            combinedItemOrder: orderedItemsWithTypes
        }));

        this.publish('item.order.updated', { orderedItemsWithTypes, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('item.order.updated', socket, { count: orderedItemsWithTypes.length });
        return { success: true };
    }

    async getGlobalWarehouse() {
        const filePath = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'global_prompt_warehouse.json');
        if (!await fs.pathExists(filePath)) {
            await fs.writeJson(filePath, []);
            return { success: true, data: [] };
        }
        const data = await fs.readJson(filePath);
        return { success: true, data };
    }

    async saveGlobalWarehouse(data, socket) {
        if (!Array.isArray(data)) throw new Error('data must be an array');
        const filePath = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'global_prompt_warehouse.json');
        await fs.writeJson(filePath, data, { spaces: 2 });
        this.publish('prompt.warehouse.updated', { count: data.length, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('prompt.warehouse.updated', socket, { count: data.length });
        return { success: true };
    }

    async loadPresetPrompts(presetPath) {
        if (!presetPath || typeof presetPath !== 'string') throw new Error('presetPath is required');

        let absolutePath = presetPath;
        if (!path.isAbsolute(presetPath)) {
            const cleanPath = presetPath.replace(/^\.[/\\]/, '');
            if (cleanPath.startsWith('AppData')) {
                absolutePath = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, cleanPath.substring('AppData'.length).replace(/^[/\\]/, ''));
            } else {
                const projectRoot = path.dirname(this.paths.APP_DATA_ROOT_IN_PROJECT);
                absolutePath = path.join(projectRoot, cleanPath);
            }
        }

        absolutePath = path.resolve(absolutePath);
        if (!await fs.pathExists(absolutePath)) {
            await fs.ensureDir(absolutePath);
            return { success: true, presets: [] };
        }

        const files = await fs.readdir(absolutePath);
        const presets = [];
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (ext !== '.md' && ext !== '.txt') continue;
            const filePath = path.join(absolutePath, file);
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) continue;
            presets.push({
                name: path.basename(file, ext),
                path: filePath,
                extension: ext,
                size: stats.size,
                modified: stats.mtime
            });
        }
        presets.sort((a, b) => b.modified - a.modified);
        return { success: true, presets };
    }

    async loadPresetContent(filePath) {
        if (!filePath) throw new Error('filePath is required');
        if (!await fs.pathExists(filePath)) return { success: false, error: '文件不存在' };
        const content = await fs.readFile(filePath, 'utf-8');
        return { success: true, content };
    }

    async getActiveSystemPrompt(agentId) {
        if (!agentId) throw new Error('agentId is required');
        const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
        if (!await fs.pathExists(configPath)) return { success: false, error: 'Agent配置不存在' };

        const config = await fs.readJson(configPath);
        const promptMode = config.promptMode || 'original';
        let systemPrompt = '';

        switch (promptMode) {
            case 'original':
                systemPrompt = config.originalSystemPrompt || config.systemPrompt || '';
                break;
            case 'modular':
                if (config.advancedSystemPrompt && typeof config.advancedSystemPrompt === 'object') {
                    const blocks = config.advancedSystemPrompt.blocks || [];
                    systemPrompt = blocks
                        .filter(block => !block.disabled)
                        .map(block => {
                            if (block.type === 'newline') return '\n';
                            let content = block.content || '';
                            if (block.variants && block.variants.length > 0) {
                                const selectedIndex = block.selectedVariant || 0;
                                content = block.variants[selectedIndex] || content;
                            }
                            return content;
                        })
                        .join('');
                } else if (typeof config.advancedSystemPrompt === 'string') {
                    systemPrompt = config.advancedSystemPrompt;
                }
                break;
            case 'preset':
                systemPrompt = config.presetSystemPrompt || '';
                break;
            default:
                systemPrompt = config.systemPrompt || '';
        }

        return { success: true, systemPrompt, promptMode };
    }

    async programmaticSetPromptMode(agentId, mode, socket) {
        if (!agentId || !mode) throw new Error('agentId and mode are required');
        const allowed = ['original', 'modular', 'preset'];
        if (!allowed.includes(mode)) throw new Error(`invalid prompt mode: ${mode}`);

        if (this.agentConfigManager) {
            await this.agentConfigManager.updateAgentConfig(agentId, config => ({ ...config, promptMode: mode }));
        } else {
            const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
            const config = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
            config.promptMode = mode;
            await fs.writeJson(configPath, config, { spaces: 2 });
        }

        this.publish('prompt.mode.updated', { agentId, mode, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('prompt.mode.updated', socket, { agentId, mode });
        return { success: true, promptMode: mode };
    }

    async getAgentConfig(agentId) {
        if (!agentId) throw new Error('agentId is required');
        const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
        if (!(await fs.pathExists(configPath))) throw new Error(`Agent config not found: ${agentId}`);
        return fs.readJson(configPath);
    }

    async saveAgentConfig(agentId, config, socket) {
        if (!agentId || !config || typeof config !== 'object') {
            throw new Error('agentId and config are required');
        }

        if (this.agentConfigManager) {
            await this.agentConfigManager.updateAgentConfig(agentId, (existing) => ({
                ...existing,
                ...config
            }));
        } else {
            const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
            const existing = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
            await fs.writeJson(configPath, { ...existing, ...config }, { spaces: 2 });
        }

        this.publish('agent.config.updated', { agentId, by: socket.clientId, updatedAt: Date.now() });
        await this.audit('agent.config.updated', socket, { agentId });
        return { success: true };
    }

    async getAgentTopics(agentId) {
        if (!agentId) throw new Error('agentId is required');
        const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
        if (!(await fs.pathExists(configPath))) return [];
        const config = await fs.readJson(configPath);
        return Array.isArray(config.topics) ? config.topics : [];
    }

    async renameTopic(agentId, topicId, newTitle, socket) {
        if (!agentId || !topicId || !newTitle) throw new Error('agentId/topicId/newTitle are required');

        await this.updateAgentTopics(agentId, (topics) => {
            const index = topics.findIndex(t => t.id === topicId);
            if (index === -1) throw new Error(`Topic not found: ${topicId}`);
            topics[index] = { ...topics[index], name: newTitle };
            return topics;
        });

        this.publish('topic.renamed', { agentId, topicId, newTitle, by: socket.clientId });
        await this.audit('topic.renamed', socket, { agentId, topicId, newTitle });
        return { success: true };
    }

    async deleteTopic(agentId, topicId, socket) {
        if (!agentId || !topicId) throw new Error('agentId/topicId are required');

        await this.updateAgentTopics(agentId, (topics) => topics.filter(t => t.id !== topicId));

        const topicDir = path.join(this.paths.USER_DATA_DIR, agentId, 'topics', topicId);
        if (await fs.pathExists(topicDir)) {
            await fs.remove(topicDir);
        }

        this.publish('topic.deleted', { agentId, topicId, by: socket.clientId });
        await this.audit('topic.deleted', socket, { agentId, topicId });
        return { success: true };
    }

    async saveTopicOrder(agentId, orderedTopicIds, socket) {
        if (!agentId || !Array.isArray(orderedTopicIds)) throw new Error('agentId and orderedTopicIds are required');
        if (orderedTopicIds.length === 0) throw new Error('orderedTopicIds must not be empty');

        const normalized = orderedTopicIds
            .map(id => String(id || '').trim())
            .filter(Boolean);

        if (normalized.length === 0) {
            throw new Error('orderedTopicIds contains no valid ids');
        }

        await this.updateAgentTopics(agentId, (topics) => {
            const topicMap = new Map(topics.map(t => [t.id, t]));
            const ordered = [];

            normalized.forEach(id => {
                if (topicMap.has(id)) {
                    ordered.push(topicMap.get(id));
                    topicMap.delete(id);
                }
            });

            ordered.push(...topicMap.values());
            return ordered;
        });

        this.publish('topic.order.updated', { agentId, orderedTopicIds: normalized, by: socket.clientId });
        await this.audit('topic.order.updated', socket, { agentId, count: normalized.length });
        return { success: true, orderedTopicIds: normalized };
    }

    async setTopicUnread(agentId, topicId, unread, socket) {
        if (!agentId || !topicId || typeof unread !== 'boolean') {
            throw new Error('agentId/topicId/unread are required');
        }

        await this.updateAgentTopics(agentId, (topics) => {
            const index = topics.findIndex(t => t.id === topicId);
            if (index === -1) throw new Error(`Topic not found: ${topicId}`);
            topics[index] = { ...topics[index], unread };
            return topics;
        });

        this.publish('topic.unread.updated', { agentId, topicId, unread, by: socket.clientId });
        await this.audit('topic.unread.updated', socket, { agentId, topicId, unread });
        return { success: true };
    }

    async toggleTopicLock(agentId, topicId, socket) {
        if (!agentId || !topicId) throw new Error('agentId/topicId are required');

        let lockState = null;
        await this.updateAgentTopics(agentId, (topics) => {
            const index = topics.findIndex(t => t.id === topicId);
            if (index === -1) throw new Error(`Topic not found: ${topicId}`);
            lockState = !topics[index].locked;
            topics[index] = { ...topics[index], locked: lockState };
            return topics;
        });

        this.publish('topic.lock.updated', { agentId, topicId, locked: lockState, by: socket.clientId });
        await this.audit('topic.lock.updated', socket, { agentId, topicId, locked: lockState });
        return { success: true, locked: lockState };
    }

    async updateAgentTopics(agentId, mutator) {
        if (this.agentConfigManager) {
            await this.agentConfigManager.updateAgentConfig(agentId, (config) => {
                const currentTopics = Array.isArray(config.topics) ? [...config.topics] : [];
                const updatedTopics = mutator(currentTopics);
                return {
                    ...config,
                    topics: updatedTopics
                };
            });
            return;
        }

        const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
        const config = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
        const currentTopics = Array.isArray(config.topics) ? [...config.topics] : [];
        const updatedTopics = mutator(currentTopics);
        config.topics = updatedTopics;
        await fs.writeJson(configPath, config, { spaces: 2 });
    }

    async getChatHistory(agentId, topicId) {
        if (!agentId || !topicId) throw new Error('agentId and topicId are required');
        const historyFile = path.join(this.paths.USER_DATA_DIR, agentId, 'topics', topicId, 'history.json');
        if (!(await fs.pathExists(historyFile))) return [];
        return fs.readJson(historyFile);
    }

    async saveChatHistory(agentId, topicId, history, socket) {
        if (!agentId || !topicId || !Array.isArray(history)) {
            throw new Error('agentId/topicId/history are required');
        }

        const historyDir = path.join(this.paths.USER_DATA_DIR, agentId, 'topics', topicId);
        await fs.ensureDir(historyDir);
        const historyFile = path.join(historyDir, 'history.json');
        await fs.writeJson(historyFile, history, { spaces: 2 });

        this.publish('chat.history.updated', {
            agentId,
            topicId,
            by: socket?.clientId || 'unknown',
            updatedAt: Date.now()
        });

        const latestMessage = history.length > 0 ? history[history.length - 1] : null;
        if (latestMessage) {
            this.publish('chat.message.append', {
                agentId,
                topicId,
                message: latestMessage,
                by: socket?.clientId || 'unknown',
                updatedAt: Date.now()
            });
        }

        await this.audit('chat.history.updated', socket, { agentId, topicId });
        return { success: true };
    }

    async createNewTopicForAgent(agentId, topicName, locked = true, socket) {
        if (!agentId) throw new Error('agentId is required');

        const newTopicId = `topic_${Date.now()}`;
        const topic = {
            id: newTopicId,
            name: topicName || '新话题',
            createdAt: Date.now(),
            locked: !!locked,
            unread: false,
            creatorSource: 'remote'
        };

        if (this.agentConfigManager) {
            await this.agentConfigManager.updateAgentConfig(agentId, (config) => ({
                ...config,
                topics: [topic, ...(config.topics || [])]
            }));
        } else {
            const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
            const config = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
            config.topics = [topic, ...(config.topics || [])];
            await fs.writeJson(configPath, config, { spaces: 2 });
        }

        this.publish('topic.created', { agentId, topic });
        await this.audit('topic.created', socket, { agentId, topicId: newTopicId });
        return { success: true, topic };
    }

    async sendToVCP(params, socket) {
        if (!this.vcpClient) {
            throw new Error('vcpClient is not configured');
        }

        const settings = await this.settingsManager.readSettings();
        const vcpUrl = params.vcpUrl || settings.vcpServerUrl;
        const vcpApiKey = params.vcpApiKey || settings.vcpApiKey;
        const messageId = params.messageId || `remote_${Date.now()}`;
        const modelConfig = params.modelConfig || { stream: true };
        const context = {
            ...(params.context || {}),
            source: 'remote-gateway',
            clientId: socket.clientId
        };

        if (!vcpUrl || !vcpApiKey) {
            throw new Error('vcpUrl or vcpApiKey missing (check host settings)');
        }

        const proxyWebContents = {
            isDestroyed: () => false,
            send: (_channel, payload) => {
                this.publishToClient(socket, 'chat.stream.event', payload);

                if (payload.type === 'data') {
                    const chunkText = this.extractChunkText(payload.chunk);
                    if (chunkText) {
                        this.publishToClient(socket, 'chat.stream.chunk', {
                            messageId: payload.messageId,
                            content: chunkText,
                            context: payload.context
                        });
                        this.publishToClient(socket, 'bubble.render.meta', {
                            messageId: payload.messageId,
                            mode: 'append',
                            text: chunkText
                        });
                    }
                }

                if (payload.type === 'end') {
                    this.publishToClient(socket, 'chat.stream.end', {
                        messageId: payload.messageId,
                        context: payload.context
                    });
                }

                if (payload.type === 'error') {
                    this.publishToClient(socket, 'chat.stream.error', {
                        messageId: payload.messageId,
                        error: payload.error,
                        context: payload.context
                    });
                }
            }
        };

        const result = await this.vcpClient.sendToVCP({
            vcpUrl,
            vcpApiKey,
            messages: params.messages || [],
            modelConfig,
            messageId,
            context,
            webContents: proxyWebContents,
            streamChannel: 'vcp-stream-event'
        });

        await this.audit('chat.sendToVCP', socket, { messageId });
        return result;
    }

    extractChunkText(chunk) {
        if (!chunk) return '';
        if (chunk?.choices?.[0]?.delta?.content) return chunk.choices[0].delta.content;
        if (chunk?.delta?.content) return chunk.delta.content;
        if (typeof chunk?.content === 'string') return chunk.content;
        return '';
    }

    async getCanvasHistory() {
        const files = await fs.readdir(this.paths.CANVAS_CACHE_DIR);
        return files
            .filter(file => SUPPORTED_CANVAS_EXTENSIONS.includes(path.extname(file).toLowerCase()))
            .map(file => ({
                path: path.join(this.paths.CANVAS_CACHE_DIR, file),
                title: file
            }))
            .sort((a, b) => b.title.localeCompare(a.title));
    }

    async getCanvasContent(filePath) {
        if (!filePath) throw new Error('filePath is required');
        this.ensurePathAllowed(filePath, [this.paths.CANVAS_CACHE_DIR]);
        const content = await fs.readFile(filePath, 'utf-8');
        return { path: filePath, content };
    }

    async saveCanvasContent(filePath, content, socket) {
        if (!filePath) throw new Error('filePath is required');
        this.ensurePathAllowed(filePath, [this.paths.CANVAS_CACHE_DIR]);
        await fs.writeFile(filePath, content || '', 'utf-8');

        this.publish('canvas.content.updated', {
            path: filePath,
            by: socket.clientId,
            updatedAt: Date.now()
        });

        await this.audit('canvas.content.updated', socket, { path: filePath });
        return { success: true };
    }

    async createCanvas(title, socket) {
        const safeTitle = (title || `canvas_${Date.now()}.txt`).replace(/[\\/:*?"<>|]/g, '_');
        const filePath = path.join(this.paths.CANVAS_CACHE_DIR, safeTitle.endsWith('.txt') ? safeTitle : `${safeTitle}.txt`);
        await fs.ensureDir(this.paths.CANVAS_CACHE_DIR);
        await fs.writeFile(filePath, '// New Canvas', 'utf-8');

        this.publish('canvas.created', {
            path: filePath,
            title: path.basename(filePath),
            by: socket.clientId,
            createdAt: Date.now()
        });

        await this.audit('canvas.created', socket, { path: filePath });
        return { success: true, path: filePath };
    }

    async getThemes() {
        if (!this.projectRoot) throw new Error('projectRoot not configured');
        const themesDir = path.join(this.projectRoot, 'styles', 'themes');
        const files = await fs.readdir(themesDir);

        const result = [];
        for (const file of files) {
            if (!file.startsWith('themes') || !file.endsWith('.css')) continue;
            const filePath = path.join(themesDir, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const nameMatch = content.match(/\* Theme Name: (.*)/);
            const name = nameMatch ? nameMatch[1].trim() : path.basename(file, '.css').replace('themes', '');
            result.push({ fileName: file, name });
        }

        return result;
    }

    async applyTheme(themeFileName, socket) {
        if (!this.projectRoot) throw new Error('projectRoot not configured');
        if (!themeFileName) throw new Error('themeFileName is required');

        const sourcePath = path.join(this.projectRoot, 'styles', 'themes', themeFileName);
        const targetPath = path.join(this.projectRoot, 'styles', 'themes.css');
        const themeContent = await fs.readFile(sourcePath, 'utf-8');
        await fs.writeFile(targetPath, themeContent, 'utf-8');

        this.publish('theme.applied', {
            themeFileName,
            by: socket?.clientId || 'unknown',
            updatedAt: Date.now()
        });

        await this.audit('theme.applied', socket, { themeFileName });
        return { success: true };
    }

    getCurrentTheme() {
        if (typeof this.getCurrentThemeCallback === 'function') {
            return this.getCurrentThemeCallback();
        }
        return 'dark';
    }

    connectVCPLog(url, key, socket) {
        if (!url || !key) throw new Error('url and key are required');
        if (typeof this.connectVcpLogCallback !== 'function') {
            throw new Error('connectVcpLog callback is not configured');
        }
        this.connectVcpLogCallback(url, key);
        this.audit('vcplog.connect', socket, { url }).catch(() => {});
        return { success: true };
    }

    disconnectVCPLog(socket) {
        if (typeof this.disconnectVcpLogCallback !== 'function') {
            throw new Error('disconnectVcpLog callback is not configured');
        }
        this.disconnectVcpLogCallback();
        this.audit('vcplog.disconnect', socket, {}).catch(() => {});
        return { success: true };
    }

    getCachedModels() {
        if (typeof this.getCachedModelsCallback !== 'function') {
            return [];
        }
        return this.getCachedModelsCallback() || [];
    }

    async refreshModels(socket) {
        if (typeof this.refreshModelsCallback !== 'function') {
            throw new Error('refreshModels callback is not configured');
        }
        const models = await this.refreshModelsCallback();
        this.publish('models.updated', { models, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('models.refresh', socket, { count: Array.isArray(models) ? models.length : 0 });
        return { success: true, models };
    }

    async exportTopicAsMarkdown(topicName, markdownContent, socket) {
        if (!topicName || !markdownContent) {
            throw new Error('topicName and markdownContent are required');
        }

        const safeTopicName = String(topicName).replace(/[/\\?%*:|"<>]/g, '-');
        const ts = new Date();
        const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
        const exportDir = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'RemoteExports');
        await fs.ensureDir(exportDir);
        const filePath = path.join(exportDir, `${safeTopicName}-${stamp}.md`);
        await fs.writeFile(filePath, markdownContent, 'utf8');

        this.publish('topic.exported', { topicName, filePath, by: socket?.clientId || 'unknown', exportedAt: Date.now() });
        await this.audit('topic.exported', socket, { topicName, filePath });
        return { success: true, filePath };
    }

    async getUnreadTopicCounts() {
        const unreadCounts = {};
        const folders = await fs.readdir(this.paths.AGENT_DIR);

        for (const folderName of folders) {
            const agentPath = path.join(this.paths.AGENT_DIR, folderName);
            const stat = await fs.stat(agentPath);
            if (!stat.isDirectory()) continue;

            const configPath = path.join(agentPath, 'config.json');
            if (!(await fs.pathExists(configPath))) continue;

            const config = await fs.readJson(configPath);
            const topics = Array.isArray(config.topics) ? config.topics : [];
            const unread = topics.filter(t => t.unread === true).length;
            if (unread > 0) unreadCounts[folderName] = unread;
        }

        return { success: true, unreadCounts };
    }

    async searchTopicsByContent(itemId, itemType, searchTerm) {
        if (!itemId || !itemType || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
            return { success: false, error: 'Invalid arguments for topic content search.', matchedTopicIds: [] };
        }

        const searchTermLower = searchTerm.toLowerCase();
        const matchedTopicIds = [];

        const basePath = itemType === 'agent'
            ? this.paths.AGENT_DIR
            : path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'AgentGroups');

        const configPath = path.join(basePath, itemId, 'config.json');
        if (!(await fs.pathExists(configPath))) return { success: true, matchedTopicIds: [] };

        const itemConfig = await fs.readJson(configPath);
        if (!itemConfig || !Array.isArray(itemConfig.topics)) {
            return { success: true, matchedTopicIds: [] };
        }

        for (const topic of itemConfig.topics) {
            const historyFilePath = path.join(this.paths.USER_DATA_DIR, itemId, 'topics', topic.id, 'history.json');
            if (!(await fs.pathExists(historyFilePath))) continue;

            try {
                const history = await fs.readJson(historyFilePath);
                if (!Array.isArray(history)) continue;

                for (const message of history) {
                    if (message.content && typeof message.content === 'string' && message.content.toLowerCase().includes(searchTermLower)) {
                        matchedTopicIds.push(topic.id);
                        break;
                    }
                }
            } catch (e) {
                // ignore single-topic read error
            }
        }

        return { success: true, matchedTopicIds: [...new Set(matchedTopicIds)] };
    }

    async uploadRemoteBundle(platform, fileName, base64, socket) {
        if (!platform || !['desktop', 'mobile'].includes(platform)) {
            throw new Error('platform must be desktop or mobile');
        }
        if (!fileName || typeof fileName !== 'string') throw new Error('fileName is required');
        if (!base64 || typeof base64 !== 'string') throw new Error('base64 is required');

        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        const bundlesRoot = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'RemoteBundles', platform);
        await fs.ensureDir(bundlesRoot);

        const targetPath = path.join(bundlesRoot, safeName);
        this.ensurePathAllowed(targetPath, [bundlesRoot]);

        const buffer = Buffer.from(base64, 'base64');
        await fs.writeFile(targetPath, buffer);

        await this.audit('remote.bundle.upload', socket, { platform, fileName: safeName, bytes: buffer.length });
        return { success: true, path: targetPath };
    }

    async listRemoteBundles(platform) {
        if (!platform || !['desktop', 'mobile'].includes(platform)) {
            throw new Error('platform must be desktop or mobile');
        }
        const bundlesRoot = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'RemoteBundles', platform);
        await fs.ensureDir(bundlesRoot);

        const files = await fs.readdir(bundlesRoot);
        const items = [];
        for (const file of files) {
            const fullPath = path.join(bundlesRoot, file);
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) continue;
            items.push({ name: file, size: stat.size, mtimeMs: stat.mtimeMs });
        }

        items.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return { success: true, platform, files: items };
    }

    async setRemoteBundleVersion(version, socket) {
        const normalized = String(version || '').trim();
        if (!normalized) throw new Error('version is required');

        await this.settingsManager.updateSettings(settings => ({
            ...settings,
            remoteBundleVersion: normalized,
            remoteBundleUpdatedAt: Date.now()
        }));

        this.publish('remote.bundle.version.updated', {
            version: normalized,
            updatedAt: Date.now(),
            by: socket?.clientId || 'unknown'
        });

        await this.audit('remote.bundle.version.updated', socket, { version: normalized });
        return { success: true, version: normalized };
    }

    async getFileAsBase64(filePath, socket) {
        if (!filePath) throw new Error('filePath is required');

        const settings = await this.settingsManager.readSettings();
        const allowedRoots = Array.isArray(settings.remoteAllowedRoots) && settings.remoteAllowedRoots.length > 0
            ? settings.remoteAllowedRoots
            : [this.paths.APP_DATA_ROOT_IN_PROJECT];

        this.ensurePathAllowed(filePath, allowedRoots);
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString('base64');

        await this.audit('file.base64.read', socket, { filePath, bytes: buffer.length });
        return { success: true, filePath, base64 };
    }

    async getTextContent(filePath, fileType, socket) {
        if (!filePath) throw new Error('filePath is required');

        const settings = await this.settingsManager.readSettings();
        const allowedRoots = Array.isArray(settings.remoteAllowedRoots) && settings.remoteAllowedRoots.length > 0
            ? settings.remoteAllowedRoots
            : [this.paths.APP_DATA_ROOT_IN_PROJECT];

        this.ensurePathAllowed(filePath, allowedRoots);

        let content = '';
        if (fileType === 'json') {
            content = JSON.stringify(await fs.readJson(filePath), null, 2);
        } else {
            content = await fs.readFile(filePath, 'utf8');
        }

        await this.audit('file.text.read', socket, { filePath, fileType: fileType || 'text' });
        return { success: true, filePath, content };
    }

    async handleTextPasteAsFile(agentId, topicId, textContent, socket) {
        if (!agentId || !topicId || typeof textContent !== 'string') {
            throw new Error('agentId/topicId/textContent are required');
        }

        const topicDir = path.join(this.paths.USER_DATA_DIR, agentId, 'topics', topicId);
        const filesDir = path.join(topicDir, 'files');
        await fs.ensureDir(filesDir);

        const fileName = `pasted_text_${Date.now()}.txt`;
        const filePath = path.join(filesDir, fileName);
        await fs.writeFile(filePath, textContent, 'utf8');

        const fileData = {
            name: fileName,
            path: filePath,
            type: 'text/plain',
            size: Buffer.byteLength(textContent, 'utf8')
        };

        this.publish('chat.file.added', { agentId, topicId, file: fileData, by: socket?.clientId || 'unknown', createdAt: Date.now() });
        await this.audit('chat.file.added', socket, { agentId, topicId, filePath });
        return { success: true, file: fileData };
    }

    async handleTextPasteAsGroupFile(groupId, topicId, textContent, socket) {
        if (!groupId || !topicId || typeof textContent !== 'string') {
            throw new Error('groupId/topicId/textContent are required');
        }

        const topicDir = path.join(this.paths.USER_DATA_DIR, groupId, 'topics', topicId);
        const filesDir = path.join(topicDir, 'files');
        await fs.ensureDir(filesDir);

        const fileName = `group_pasted_text_${Date.now()}.txt`;
        const filePath = path.join(filesDir, fileName);
        await fs.writeFile(filePath, textContent, 'utf8');

        const fileData = {
            name: fileName,
            path: filePath,
            type: 'text/plain',
            size: Buffer.byteLength(textContent, 'utf8')
        };

        this.publish('group.chat.file.added', { groupId, topicId, file: fileData, by: socket?.clientId || 'unknown', createdAt: Date.now() });
        await this.audit('group.chat.file.added', socket, { groupId, topicId, filePath });
        return { success: true, file: fileData };
    }

    async createAgentGroup(groupName, initialConfig, socket) {
        const result = await groupChat.createAgentGroup(groupName, initialConfig);
        this.publish('group.created', { groupName, result, by: socket?.clientId || 'unknown', createdAt: Date.now() });
        await this.audit('group.created', socket, { groupName });
        return result;
    }

    async getAgentGroups() {
        return groupChat.getAgentGroups();
    }

    async getAgentGroupConfig(groupId) {
        if (!groupId) throw new Error('groupId is required');
        return groupChat.getAgentGroupConfig(groupId);
    }

    async saveAgentGroupConfig(groupId, configData, socket) {
        if (!groupId || !configData) throw new Error('groupId and configData are required');
        const result = await groupChat.saveAgentGroupConfig(groupId, configData);
        this.publish('group.config.updated', { groupId, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('group.config.updated', socket, { groupId });
        return result;
    }

    async deleteAgentGroup(groupId, socket) {
        if (!groupId) throw new Error('groupId is required');
        const result = await groupChat.deleteAgentGroup(groupId);
        this.publish('group.deleted', { groupId, by: socket?.clientId || 'unknown', deletedAt: Date.now() });
        await this.audit('group.deleted', socket, { groupId });
        return result;
    }

    async getGroupTopics(groupId, searchTerm) {
        if (!groupId) throw new Error('groupId is required');
        return groupChat.getGroupTopics(groupId, searchTerm);
    }

    async createNewTopicForGroup(groupId, topicName, socket) {
        if (!groupId) throw new Error('groupId is required');
        const result = await groupChat.createNewTopicForGroup(groupId, topicName);
        this.publish('group.topic.created', { groupId, topicName, result, by: socket?.clientId || 'unknown', createdAt: Date.now() });
        await this.audit('group.topic.created', socket, { groupId, topicName });
        return result;
    }

    async deleteGroupTopic(groupId, topicId, socket) {
        if (!groupId || !topicId) throw new Error('groupId/topicId are required');
        const result = await groupChat.deleteGroupTopic(groupId, topicId);
        this.publish('group.topic.deleted', { groupId, topicId, by: socket?.clientId || 'unknown', deletedAt: Date.now() });
        await this.audit('group.topic.deleted', socket, { groupId, topicId });
        return result;
    }

    async saveGroupTopicTitle(groupId, topicId, newTitle, socket) {
        if (!groupId || !topicId || !newTitle) throw new Error('groupId/topicId/newTitle are required');
        const result = await groupChat.saveGroupTopicTitle(groupId, topicId, newTitle);
        this.publish('group.topic.renamed', { groupId, topicId, newTitle, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('group.topic.renamed', socket, { groupId, topicId, newTitle });
        return result;
    }

    async getGroupChatHistory(groupId, topicId) {
        if (!groupId || !topicId) throw new Error('groupId/topicId are required');
        return groupChat.getGroupChatHistory(groupId, topicId);
    }

    async saveGroupChatHistory(groupId, topicId, history, socket) {
        if (!groupId || !topicId || !Array.isArray(history)) {
            throw new Error('groupId/topicId/history are required');
        }

        const historyDir = path.join(this.paths.USER_DATA_DIR, groupId, 'topics', topicId);
        await fs.ensureDir(historyDir);
        const historyFile = path.join(historyDir, 'history.json');
        await fs.writeJson(historyFile, history, { spaces: 2 });

        this.publish('group.chat.history.updated', { groupId, topicId, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('group.chat.history.updated', socket, { groupId, topicId });
        return { success: true };
    }

    async sendGroupChatMessage(groupId, topicId, userMessage, socket) {
        if (!groupId || !topicId || !userMessage) {
            throw new Error('groupId/topicId/userMessage are required');
        }

        const sendStreamChunkToRemote = (data) => {
            this.publishToClient(socket, 'group.vcp.stream.event', data);
            if (data?.type === 'data') {
                const chunkText = this.extractChunkText(data.chunk);
                if (chunkText) {
                    this.publishToClient(socket, 'group.vcp.stream.chunk', {
                        messageId: data.messageId,
                        content: chunkText,
                        context: data.context
                    });
                }
            }
        };

        const getAgentConfigById = async (agentId) => {
            const configPath = path.join(this.paths.AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(configPath)) return { error: `Agent config for ${agentId} not found.` };
            const config = await fs.readJson(configPath);
            config.id = agentId;
            return config;
        };

        await groupChat.handleGroupChatMessage(groupId, topicId, userMessage, sendStreamChunkToRemote, getAgentConfigById);
        await this.audit('group.chat.send', socket, { groupId, topicId });
        return { success: true, message: 'Group chat message processing started and completed.' };
    }

    async readNotesTree() {
        const notesDir = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
        await fs.ensureDir(notesDir);

        const readDirectoryStructure = async (dirPath) => {
            const items = [];
            const files = await fs.readdir(dirPath, { withFileTypes: true });
            const orderFilePath = path.join(dirPath, '.folder-order.json');
            let orderedIds = [];

            try {
                if (await fs.pathExists(orderFilePath)) {
                    const orderData = await fs.readJson(orderFilePath);
                    orderedIds = orderData.order || [];
                }
            } catch (_) {}

            for (const file of files) {
                const fullPath = path.join(dirPath, file.name);
                if (file.name.startsWith('.') || file.name.endsWith('.json')) continue;

                if (file.isDirectory()) {
                    items.push({
                        id: `folder-${Buffer.from(fullPath).toString('hex')}`,
                        type: 'folder',
                        name: file.name,
                        path: fullPath,
                        children: await readDirectoryStructure(fullPath)
                    });
                } else if (file.isFile() && (file.name.endsWith('.txt') || file.name.endsWith('.md'))) {
                    try {
                        const content = await fs.readFile(fullPath, 'utf8');
                        const lines = content.split('\n');
                        const id = `note-${Buffer.from(fullPath).toString('hex')}`;

                        let title = path.basename(file.name, path.extname(file.name));
                        let username = 'unknown';
                        let timestamp = (await fs.stat(fullPath)).mtime.getTime();
                        let noteContent = content;

                        const header = lines[0];
                        const parts = header ? header.split('-') : [];
                        const potentialTimestamp = parts.length > 0 ? parseInt(parts[parts.length - 1], 10) : NaN;
                        if (parts.length >= 3 && !isNaN(potentialTimestamp) && potentialTimestamp > 0) {
                            username = parts[parts.length - 2];
                            timestamp = potentialTimestamp;
                            noteContent = lines.slice(1).join('\n');
                            const headerTitle = parts.slice(0, -2).join('-');
                            title = headerTitle || title;
                        }

                        items.push({
                            id,
                            type: 'note',
                            title,
                            username,
                            timestamp,
                            content: noteContent,
                            fileName: file.name,
                            path: fullPath
                        });
                    } catch (_) {}
                }
            }

            items.sort((a, b) => {
                const indexA = orderedIds.indexOf(a.id);
                const indexB = orderedIds.indexOf(b.id);
                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                if (indexA !== -1) return -1;
                if (indexB !== -1) return 1;
                if (a.type === 'folder' && b.type !== 'folder') return -1;
                if (a.type !== 'folder' && b.type === 'folder') return 1;
                return (a.name || a.title).localeCompare(b.name || b.title);
            });

            return items;
        };

        return readDirectoryStructure(notesDir);
    }

    async writeTxtNote(noteData, socket) {
        if (!noteData || typeof noteData !== 'object') {
            throw new Error('noteData is required');
        }

        const notesDir = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
        await fs.ensureDir(notesDir);

        const { title, username, timestamp, content, oldFilePath, directoryPath, ext } = noteData;
        let filePath;
        let isNewNote = false;

        if (oldFilePath && await fs.pathExists(oldFilePath)) {
            filePath = oldFilePath;
        } else {
            isNewNote = true;
            const targetDir = directoryPath || notesDir;
            await fs.ensureDir(targetDir);
            const extension = ext || '.md';
            const newFileName = `${title}${extension}`;
            filePath = path.join(targetDir, newFileName);
            if (await fs.pathExists(filePath)) {
                throw new Error(`A note named '${title}' already exists.`);
            }
        }

        const fileContent = `${title}-${username}-${timestamp}\n${content}`;
        await fs.writeFile(filePath, fileContent, 'utf8');

        const newId = `note-${Buffer.from(filePath).toString('hex')}`;
        this.publish('notes.updated', { action: isNewNote ? 'create' : 'update', filePath, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('notes.write', socket, { filePath, isNewNote });

        return {
            success: true,
            filePath,
            fileName: path.basename(filePath),
            id: newId,
            isNewNote
        };
    }

    async deleteItem(itemPath, socket) {
        if (!itemPath) throw new Error('itemPath is required');
        if (await fs.pathExists(itemPath)) {
            await fs.remove(itemPath);
            this.publish('notes.updated', { action: 'delete', itemPath, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
            await this.audit('notes.delete', socket, { itemPath });
            return { success: true, networkRescanTriggered: false };
        }
        return { success: false, error: 'Item not found.' };
    }

    async createNoteFolder(parentPath, folderName, socket) {
        if (!parentPath || !folderName) throw new Error('parentPath and folderName are required');
        const newFolderPath = path.join(parentPath, folderName);
        if (await fs.pathExists(newFolderPath)) {
            return { success: false, error: 'A folder with the same name already exists.' };
        }
        await fs.ensureDir(newFolderPath);
        const newId = `folder-${Buffer.from(newFolderPath).toString('hex')}`;

        this.publish('notes.updated', { action: 'create-folder', path: newFolderPath, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('notes.create-folder', socket, { parentPath, folderName, newFolderPath });

        return { success: true, path: newFolderPath, id: newId };
    }

    async renameItem(data, socket) {
        if (!data || typeof data !== 'object') throw new Error('data is required');
        const { oldPath, newName, newContentBody, ext } = data;
        if (!oldPath || !newName) throw new Error('oldPath and newName are required');

        const parentDir = path.dirname(oldPath);
        const stat = await fs.stat(oldPath);
        const isDirectory = stat.isDirectory();
        const sanitizedNewName = newName.replace(/[\\/:*?"<>|]/g, '');
        if (!sanitizedNewName) {
            return { success: false, error: 'Invalid name provided.' };
        }

        const newPath = isDirectory
            ? path.join(parentDir, sanitizedNewName)
            : path.join(parentDir, sanitizedNewName + (ext || path.extname(oldPath)));

        if (oldPath !== newPath && await fs.pathExists(newPath)) {
            return { success: false, error: 'A file or folder with the same name already exists.' };
        }

        if (isDirectory) {
            await fs.rename(oldPath, newPath);
        } else {
            const content = await fs.readFile(oldPath, 'utf8');
            const lines = content.split('\n');
            let newFileContent = content;

            if (lines.length > 0) {
                const header = lines[0];
                const oldContentBody = lines.slice(1).join('\n');
                const contentBody = newContentBody !== undefined ? newContentBody : oldContentBody;
                const parts = header.split('-');
                if (parts.length >= 3) {
                    const timestampStr = parts.pop();
                    const username = parts.pop();
                    const newHeader = `${sanitizedNewName}-${username}-${timestampStr}`;
                    newFileContent = `${newHeader}\n${contentBody}`;
                }
            }

            await fs.writeFile(newPath, newFileContent, 'utf8');
            if (oldPath !== newPath) {
                await fs.remove(oldPath);
            }
        }

        const type = isDirectory ? 'folder' : 'note';
        const newId = `${type}-${Buffer.from(newPath).toString('hex')}`;

        this.publish('notes.updated', { action: 'rename', oldPath, newPath, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('notes.rename', socket, { oldPath, newPath });

        return { success: true, newPath, newId };
    }

    async notesMoveItems(data, socket) {
        if (!data || typeof data !== 'object') throw new Error('data is required');
        const { sourcePaths, target } = data;
        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || !target || !target.destPath) {
            throw new Error('invalid move payload');
        }

        const moved = [];
        for (const sourcePath of sourcePaths) {
            const itemName = path.basename(sourcePath);
            const destPath = path.join(target.destPath, itemName);
            await fs.move(sourcePath, destPath, { overwrite: false });
            moved.push({ from: sourcePath, to: destPath });
        }

        this.publish('notes.updated', { action: 'move', moved, by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('notes.move', socket, { count: moved.length });

        return { success: true, moved };
    }

    async searchNotes(query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return { success: true, results: [] };

        const notesDir = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
        const results = [];

        const walk = async (dir) => {
            if (!await fs.pathExists(dir)) return;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                    continue;
                }
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (ext !== '.md' && ext !== '.txt') continue;
                try {
                    const content = await fs.readFile(full, 'utf8');
                    const lower = content.toLowerCase();
                    if (lower.includes(q) || entry.name.toLowerCase().includes(q)) {
                        results.push({ path: full, fileName: entry.name, preview: content.slice(0, 200) });
                    }
                } catch (_) {}
            }
        };

        await walk(notesDir);
        return { success: true, results };
    }

    async getCachedNetworkNotes() {
        const cachePath = path.join(this.paths.APP_DATA_ROOT_IN_PROJECT, 'network-notes-cache.json');
        return await fs.pathExists(cachePath) ? await fs.readJson(cachePath) : [];
    }

    async loadForumConfig() {
        const forumConfigFile = path.join(this.paths.USER_DATA_DIR, 'forum.config.json');
        if (await fs.pathExists(forumConfigFile)) {
            const config = await fs.readJson(forumConfigFile);
            return {
                username: config.username || '',
                password: config.password || '',
                replyUsername: config.replyUsername || '',
                rememberCredentials: config.rememberCredentials || false
            };
        }
        return {
            username: '',
            password: '',
            replyUsername: '',
            rememberCredentials: false
        };
    }

    async saveForumConfig(config, socket) {
        const forumConfigFile = path.join(this.paths.USER_DATA_DIR, 'forum.config.json');
        await fs.ensureDir(this.paths.USER_DATA_DIR);

        const configToSave = {
            username: config?.username || '',
            password: config?.rememberCredentials ? (config?.password || '') : '',
            replyUsername: config?.replyUsername || '',
            rememberCredentials: config?.rememberCredentials || false
        };

        await fs.writeJson(forumConfigFile, configToSave, { spaces: 2 });
        this.publish('forum.config.updated', { by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('forum.config.updated', socket, { keys: Object.keys(configToSave) });
        return { success: true };
    }

    async loadAgentsList() {
        const agents = await this.getAgents();
        return agents.map(agent => ({
            name: agent.name,
            folder: agent.id
        }));
    }

    async loadUserAvatar() {
        const avatarPath = path.join(this.paths.USER_DATA_DIR, 'user_avatar.png');
        if (await fs.pathExists(avatarPath)) {
            return `file://${avatarPath.replace(/\\/g, '/')}`;
        }
        return null;
    }

    async loadAgentAvatar(folderName) {
        if (!folderName) return null;
        const avatarPath = path.join(this.paths.AGENT_DIR, folderName, 'avatar.png');
        if (await fs.pathExists(avatarPath)) {
            return `file://${avatarPath.replace(/\\/g, '/')}`;
        }
        return null;
    }

    async loadMemoConfig() {
        const memoConfigFile = path.join(this.paths.USER_DATA_DIR, 'memo.config.json');
        if (await fs.pathExists(memoConfigFile)) {
            return fs.readJson(memoConfigFile);
        }
        return {};
    }

    async saveMemoConfig(config, socket) {
        const memoConfigFile = path.join(this.paths.USER_DATA_DIR, 'memo.config.json');
        await fs.ensureDir(this.paths.USER_DATA_DIR);
        await fs.writeJson(memoConfigFile, config || {}, { spaces: 2 });
        this.publish('memo.config.updated', { by: socket?.clientId || 'unknown', updatedAt: Date.now() });
        await this.audit('memo.config.updated', socket, {});
        return { success: true };
    }

    ensureMusicHandlers() {
        if (!this.musicHandlers) {
            throw new Error('music handlers are not configured');
        }
    }

    async getMusicPlaylist() {
        this.ensureMusicHandlers();
        return this.musicHandlers.getMusicPlaylist();
    }

    async getCustomPlaylists() {
        this.ensureMusicHandlers();
        return this.musicHandlers.getCustomPlaylists();
    }

    async musicLoad(track, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicLoad(track);
        await this.audit('music.load', socket, { hasTrack: !!track });
        return result;
    }

    async musicPlay(socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicPlay();
        await this.audit('music.play', socket, {});
        return result;
    }

    async musicPause(socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicPause();
        await this.audit('music.pause', socket, {});
        return result;
    }

    async musicSeek(positionSeconds, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicSeek(positionSeconds);
        await this.audit('music.seek', socket, { positionSeconds });
        return result;
    }

    async musicGetState() {
        this.ensureMusicHandlers();
        return this.musicHandlers.musicGetState();
    }

    async musicSetVolume(volume, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicSetVolume(volume);
        await this.audit('music.volume', socket, { volume });
        return result;
    }

    async musicGetDevices(options) {
        this.ensureMusicHandlers();
        return this.musicHandlers.musicGetDevices(options || {});
    }

    async musicConfigureOutput(data, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicConfigureOutput(data || {});
        await this.audit('music.configure_output', socket, data || {});
        return result;
    }

    async musicSetEq(data, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicSetEq(data || {});
        await this.audit('music.set_eq', socket, {});
        return result;
    }

    async musicSetEqType(data, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicSetEqType(data || {});
        await this.audit('music.set_eq_type', socket, data || {});
        return result;
    }

    async musicConfigureOptimizations(data, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicConfigureOptimizations(data || {});
        await this.audit('music.optimizations', socket, data || {});
        return result;
    }

    async musicConfigureUpsampling(data, socket) {
        this.ensureMusicHandlers();
        const result = await this.musicHandlers.musicConfigureUpsampling(data || {});
        await this.audit('music.upsampling', socket, data || {});
        return result;
    }

    async musicGetLyrics(data) {
        this.ensureMusicHandlers();
        return this.musicHandlers.musicGetLyrics(data || {});
    }

    async musicFetchLyrics(data) {
        this.ensureMusicHandlers();
        return this.musicHandlers.musicFetchLyrics(data || {});
    }

    async readHostFile(filePath, socket) {
        if (!filePath) throw new Error('filePath is required');
        const settings = await this.settingsManager.readSettings();
        const allowedRoots = Array.isArray(settings.remoteAllowedRoots) && settings.remoteAllowedRoots.length > 0
            ? settings.remoteAllowedRoots
            : [this.paths.APP_DATA_ROOT_IN_PROJECT];

        this.ensurePathAllowed(filePath, allowedRoots);
        const content = await fs.readFile(filePath, 'utf-8');
        await this.audit('file.read', socket, { filePath });
        return { filePath, content };
    }

    ensurePathAllowed(targetPath, allowedRoots) {
        const resolvedTarget = path.resolve(targetPath);
        const matched = allowedRoots.some(root => {
            const resolvedRoot = path.resolve(root);
            return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
        });

        if (!matched) {
            throw new Error(`Path not allowed: ${targetPath}`);
        }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) return;

        this.heartbeatTimer = setInterval(() => {
            for (const client of this.clients) {
                if (client.readyState !== WebSocket.OPEN) continue;

                if (client.isAlive === false) {
                    try { client.terminate(); } catch (_) {}
                    this.clients.delete(client);
                    continue;
                }

                client.isAlive = false;
                try { client.ping(); } catch (_) {}
            }
        }, this.heartbeatIntervalMs);
    }

    publish(event, payload) {
        const message = JSON.stringify({ type: 'event', event, payload });

        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN && client.isAuthed) {
                client.send(message);
            }
        }
    }

    publishToClient(socket, event, payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN || !socket.isAuthed) return;
        const message = JSON.stringify({ type: 'event', event, payload });
        socket.send(message);
    }

    async audit(action, socket, details = {}) {
        const line = JSON.stringify({
            ts: Date.now(),
            action,
            clientId: socket?.clientId || 'unknown',
            role: socket?.role || 'unknown',
            details
        });
        await fs.ensureDir(path.dirname(this.auditLogFile));
        await fs.appendFile(this.auditLogFile, line + '\n', 'utf-8');
    }
}

module.exports = RemoteGateway;
