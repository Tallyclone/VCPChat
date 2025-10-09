/**
 * Mailboxmodules - 邮箱模块管理器
 * 负责管理带预制消息的新建话题功能、Agent选择、会话发起和聊天窗口跳转
 */

window.mailboxManager = (() => {
    // --- 私有变量 ---
    let electronAPI;
    let chatManager;
    let currentAgentId = null;
    let currentTopicId = null;
    let isInitialized = false;

    // --- 初始化 ---
    function init(config) {
        electronAPI = config.electronAPI;
        chatManager = config.chatManager;

        if (!electronAPI) {
            console.error('[MailboxManager] electronAPI 未提供');
            return false;
        }

        if (!chatManager) {
            console.error('[MailboxManager] chatManager 未提供');
            return false;
        }

        isInitialized = true;
        console.log('[MailboxManager] 初始化成功');
        return true;
    }

    // --- 获取可用Agent列表 ---
    async function getAvailableAgents() {
        try {
            const response = await electronAPI.getAgents();
            if (response && !response.error) {
                return response;
            } else {
                console.error('[MailboxManager] 获取Agent列表失败:', response?.error);
                return [];
            }
        } catch (error) {
            console.error('[MailboxManager] 获取Agent列表时出错:', error);
            return [];
        }
    }

    // --- 选择Agent ---
    async function selectAgent(agentId, options = {}) {
        try {
            if (!agentId) {
                console.error('[MailboxManager] 未提供Agent ID');
                return { success: false, error: '未提供Agent ID' };
            }

            // 获取Agent配置
            const agentConfig = await electronAPI.getAgentConfig(agentId);
            if (!agentConfig || agentConfig.error) {
                return { success: false, error: agentConfig?.error || '获取Agent配置失败' };
            }

            currentAgentId = agentId;

            // 如果Agent有话题，且没有指定不自动选择话题
            if (agentConfig.topics && agentConfig.topics.length > 0 && !options.skipTopicSelection) {
                const firstTopic = agentConfig.topics[0];
                currentTopicId = firstTopic.id;

                // 通知聊天管理器选择这个Agent和话题
                if (chatManager && chatManager.selectItem) {
                    await chatManager.selectItem(agentId, 'agent', agentConfig.name, agentConfig.avatarUrl, agentConfig);
                    if (chatManager.selectTopic) {
                        await chatManager.selectTopic(firstTopic.id);
                    }
                }

                return {
                    success: true,
                    agentId: agentId,
                    topicId: firstTopic.id,
                    agentName: agentConfig.name
                };
            } else {
                // 只有在没有话题且需要创建默认话题时才创建
                if (!options.skipDefaultTopic && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                    const defaultTopicResult = await electronAPI.createNewTopicForAgent(agentId, "主要对话");
                    if (defaultTopicResult.success) {
                        currentTopicId = defaultTopicResult.topicId;

                        // 通知聊天管理器
                        if (chatManager && chatManager.selectItem) {
                            await chatManager.selectItem(agentId, 'agent', agentConfig.name, agentConfig.avatarUrl, agentConfig);
                            if (chatManager.selectTopic) {
                                await chatManager.selectTopic(defaultTopicResult.topicId);
                            }
                        }

                        return {
                            success: true,
                            agentId: agentId,
                            topicId: defaultTopicResult.topicId,
                            agentName: agentConfig.name,
                            createdDefaultTopic: true
                        };
                    } else {
                        return { success: false, error: defaultTopicResult.error };
                    }
                } else {
                    // 只是选择Agent，不选择或创建任何话题
                    if (chatManager && chatManager.selectItem) {
                        await chatManager.selectItem(agentId, 'agent', agentConfig.name, agentConfig.avatarUrl, agentConfig);
                    }

                    return {
                        success: true,
                        agentId: agentId,
                        topicId: null,
                        agentName: agentConfig.name,
                        topicSelectionSkipped: true
                    };
                }
            }
        } catch (error) {
            console.error('[MailboxManager] 选择Agent时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 检查Agent是否有预设消息 ---
    async function checkAgentPresetMessages(agentId) {
        try {
            if (!agentId) {
                return { hasPreset: false, messages: [], enabled: false };
            }

            // 获取Agent配置
            const agentConfig = await electronAPI.getAgentConfig(agentId);
            if (!agentConfig || agentConfig.error) {
                console.warn(`[MailboxManager] 获取Agent配置失败: ${agentConfig?.error}`);
                return { hasPreset: false, messages: [], enabled: false };
            }

            // 检查是否有预设消息且启用
            const hasPreset = agentConfig.presetMessageEnabled &&
                             agentConfig.presetMessages &&
                             agentConfig.presetMessages.length > 0;

            return {
                hasPreset,
                messages: agentConfig.presetMessages || [],
                enabled: agentConfig.presetMessageEnabled !== false
            };
        } catch (error) {
            console.error('[MailboxManager] 检查Agent预设消息时出错:', error);
            return { hasPreset: false, messages: [], enabled: false };
        }
    }

    // --- 创建带预制消息的新话题 ---
    async function createTopicWithPresetMessages(agentId, topicName, messages = [], options = {}) {
        try {
            if (!isInitialized) {
                return { success: false, error: 'MailboxManager 未初始化' };
            }

            if (!agentId) {
                return { success: false, error: '未提供Agent ID' };
            }

            if (!topicName || topicName.trim() === '') {
                return { success: false, error: '话题名称不能为空' };
            }

            // 验证消息格式
            if (messages && messages.length > 0) {
                for (const msg of messages) {
                    if (!msg.content || typeof msg.content !== 'string') {
                        return { success: false, error: '消息内容无效' };
                    }
                    if (msg.role && !['user', 'assistant', 'system'].includes(msg.role)) {
                        return { success: false, error: '消息角色必须是 user、assistant 或 system' };
                    }
                }
            }

            // 确保已选择正确的Agent
            if (currentAgentId !== agentId) {
                const selectResult = await selectAgent(agentId);
                if (!selectResult.success) {
                    return { success: false, error: `选择Agent失败: ${selectResult.error}` };
                }
            }

            // 调用聊天管理器创建带预制消息的话题
            if (chatManager && chatManager.createNewTopicWithMessages) {
                const result = await chatManager.createNewTopicWithMessages(agentId, topicName, messages, options);

                if (result.success) {
                    currentTopicId = result.topicId;

                    // 验证预制消息是否已保存到文件
                    if (messages && messages.length > 0) {
                        try {
                            // 重新获取聊天历史以验证消息是否正确保存
                            const verifyHistory = await electronAPI.getChatHistory(agentId, result.topicId);
                            if (verifyHistory && !verifyHistory.error && verifyHistory.length >= messages.length) {
                                console.log(`[MailboxManager] 验证成功: 话题 ${result.topicId} 包含 ${verifyHistory.length} 条消息`);
                            } else {
                                console.warn(`[MailboxManager] 验证警告: 话题 ${result.topicId} 历史消息数量不匹配`);
                            }
                        } catch (verifyError) {
                            console.warn(`[MailboxManager] 验证历史消息时出错:`, verifyError);
                        }
                    }

                    // 如果需要跳转到新话题
                    if (options.autoSwitch !== false) {
                        // 等待一小段时间确保话题创建和消息保存完成
                        setTimeout(async () => {
                            try {
                                if (chatManager.selectTopic) {
                                    await chatManager.selectTopic(result.topicId);
                                    console.log(`[MailboxManager] 已跳转到话题: ${result.topicId}`);
                                }
                            } catch (switchError) {
                                console.error(`[MailboxManager] 跳转话题时出错:`, switchError);
                            }
                        }, 200); // 增加等待时间确保文件写入完成
                    }

                    return result;
                } else {
                    return result;
                }
            } else {
                return { success: false, error: '聊天管理器不支持带预制消息的话题创建' };
            }

        } catch (error) {
            console.error('[MailboxManager] 创建带预制消息的话题时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 跳转到指定话题 ---
    async function switchToTopic(agentId, topicId) {
        try {
            if (!agentId || !topicId) {
                return { success: false, error: 'Agent ID 或 Topic ID 不能为空' };
            }

            // 确保已选择正确的Agent（跳过话题选择，避免自动跳转）
            if (currentAgentId !== agentId) {
                const selectResult = await selectAgent(agentId, { skipTopicSelection: true });
                if (!selectResult.success) {
                    return { success: false, error: `选择Agent失败: ${selectResult.error}` };
                }
            }

            // 跳转到指定话题
            if (chatManager && chatManager.selectTopic) {
                await chatManager.selectTopic(topicId);
                currentTopicId = topicId;
                return { success: true, agentId, topicId };
            } else {
                return { success: false, error: '聊天管理器不支持话题跳转' };
            }

        } catch (error) {
            console.error('[MailboxManager] 跳转话题时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 从JSON文件创建话题 ---
    async function createTopicFromJsonFile(jsonFilePath, agentId, topicName, options = {}) {
        try {
            if (!isInitialized) {
                return { success: false, error: 'MailboxManager 未初始化' };
            }

            if (!jsonFilePath) {
                return { success: false, error: '未提供JSON文件路径' };
            }

            if (!agentId) {
                return { success: false, error: '未提供Agent ID' };
            }

            if (!topicName || topicName.trim() === '') {
                return { success: false, error: '话题名称不能为空' };
            }

            // 读取JSON文件
            const jsonData = await electronAPI.readJsonFile(jsonFilePath);
            if (!jsonData) {
                return { success: false, error: '无法读取JSON文件或文件格式无效' };
            }

            // 验证JSON格式
            if (!jsonData.presetMessages || !Array.isArray(jsonData.presetMessages)) {
                return { success: false, error: 'JSON文件缺少presetMessages数组' };
            }

            // 验证消息格式
            const messages = jsonData.presetMessages;
            for (const msg of messages) {
                if (!msg.content || typeof msg.content !== 'string') {
                    return { success: false, error: '消息内容无效' };
                }
                if (msg.role && !['user', 'assistant', 'system'].includes(msg.role)) {
                    return { success: false, error: '消息角色必须是 user、assistant 或 system' };
                }
            }

            console.log(`[MailboxManager] 从JSON文件读取到 ${messages.length} 条消息`);
            return await createTopicWithPresetMessages(agentId, topicName, messages, options);

        } catch (error) {
            console.error('[MailboxManager] 从JSON文件创建话题时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 自动创建带预设消息的话题 ---
    async function createTopicWithAutoPreset(agentId, topicName, options = {}) {
        try {
            if (!isInitialized) {
                return { success: false, error: 'MailboxManager 未初始化' };
            }

            if (!agentId) {
                return { success: false, error: '未提供Agent ID' };
            }

            if (!topicName || topicName.trim() === '') {
                return { success: false, error: '话题名称不能为空' };
            }

            // 检查Agent是否有预设消息
            const presetCheck = await checkAgentPresetMessages(agentId);
            if (!presetCheck.hasPreset) {
                // 如果没有预设消息，创建普通话题
                return await createTopicWithPresetMessages(agentId, topicName, [], options);
            }

            // 使用预设消息创建话题
            console.log(`[MailboxManager] 使用预设消息创建话题，包含 ${presetCheck.messages.length} 条消息`);
            return await createTopicWithPresetMessages(agentId, topicName, presetCheck.messages, options);

        } catch (error) {
            console.error('[MailboxManager] 自动创建带预设消息的话题时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 获取当前状态 ---
    function getCurrentState() {
        return {
            isInitialized,
            currentAgentId,
            currentTopicId,
            hasActiveAgent: !!currentAgentId,
            hasActiveTopic: !!currentTopicId
        };
    }

    // --- 创建测试面板 ---
    function createTestPanel() {
        // 创建测试面板HTML
        const panelHTML = `
            <div id="mailboxTestPanel" style="position: fixed; top: 100px; right: 20px; width: 400px; height: 600px; background: var(--panel-bg); backdrop-filter: blur(12px) saturate(120%); -webkit-backdrop-filter: blur(12px) saturate(120%); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.1); z-index: 1000; display: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--primary-text);">
                <div style="padding: 15px; border-bottom: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.1); backdrop-filter: blur(8px); border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center;">
                    <h3 style="margin: 0; font-size: 16px; color: var(--primary-text);">Mailbox模块测试面板</h3>
                    <button id="closeMailboxTestPanel" style="background: none; border: none; font-size: 18px; cursor: pointer; color: var(--secondary-text); padding: 5px; border-radius: 4px; transition: background-color 0.2s;">×</button>
                </div>

                <div style="padding: 15px; max-height: 535px; overflow-y: auto;">
                    <!-- Agent选择区域 -->
                    <div style="margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px 0; font-size: 14px; color: var(--primary-text);">1. 选择Agent</h4>
                        <select id="agentSelect" style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--input-bg); color: var(--primary-text); font-size: 0.95em;">
                            <option value="">请选择Agent...</option>
                        </select>
                        <button id="selectAgentBtn" style="width: 100%; margin-top: 8px; padding: 8px; background: var(--button-bg); color: var(--primary-text); border: 1px solid var(--button-bg); border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">选择Agent</button>
                    </div>

                    <!-- 话题创建区域 -->
                    <div style="margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px 0; font-size: 14px; color: var(--primary-text);">2. 创建带预制消息的话题</h4>
                        <input type="text" id="topicNameInput" placeholder="话题名称" style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--input-bg); color: var(--primary-text); margin-bottom: 8px; font-size: 0.95em;">

                        <!-- 预制消息编辑器 -->
                        <div id="presetMessagesContainer" style="margin-bottom: 8px;">
                            <div class="message-item" style="margin-bottom: 8px; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px; background: rgba(255, 255, 255, 0.05); display: flex; gap: 10px;">
                                <!-- 左边 1/4 区域：角色选择、名字设定、删除按钮 -->
                                <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
                                    <!-- 角色选择 -->
                                    <div>
                                        <select class="messageRole" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); font-size: 0.9em;">
                                            <option value="user">用户</option>
                                            <option value="assistant">助手</option>
                                            <option value="system">系统</option>
                                        </select>
                                    </div>
                                    <!-- 名字设定 -->
                                    <div>
                                        <input type="text" class="messageName" placeholder="角色名字（可选）" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); font-size: 0.9em; box-sizing: border-box;" title="留空则使用默认名字">
                                    </div>
                                    <!-- 删除按钮 -->
                                    <div>
                                        <button class="removeMessageBtn" style="width: 100%; padding: 6px; background: var(--danger-color); color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; transition: background-color 0.2s;">删除</button>
                                    </div>
                                </div>
                                <!-- 右边 3/4 区域：消息内容 -->
                                <div style="flex: 3;">
                                    <textarea class="messageContent" placeholder="消息内容" style="width: 100%; min-height: 120px; padding: 8px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); resize: vertical; font-size: 0.9em; font-family: inherit;"></textarea>
                                </div>
                            </div>
                        </div>

                        <div style="margin-bottom: 8px;">
                            <button id="addMessageBtn" style="padding: 6px 12px; background: var(--button-bg); color: var(--primary-text); border: 1px solid var(--button-bg); border-radius: 4px; cursor: pointer; margin-right: 8px; transition: background-color 0.2s;">添加消息</button>
                            <button id="createTopicBtn" style="padding: 6px 12px; background: var(--user-bubble-bg); color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">创建话题</button>
                        </div>
                    </div>

                    <!-- 状态显示区域 -->
                    <div style="margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px 0; font-size: 14px; color: var(--primary-text);">3. 当前状态</h4>
                        <div id="currentState" style="padding: 10px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); border-radius: 4px; font-family: monospace; font-size: 12px; color: var(--primary-text);">
                            未初始化
                        </div>
                    </div>

                    <!-- 测试操作区域 -->
                    <div>
                        <h4 style="margin: 0 0 10px 0; font-size: 14px; color: var(--primary-text);">4. 测试操作</h4>
                        <button id="refreshAgentsBtn" style="width: 100%; margin-bottom: 8px; padding: 8px; background: var(--button-bg); color: var(--primary-text); border: 1px solid var(--button-bg); border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">刷新Agent列表</button>
                        <button id="testFileWatcherBtn" style="width: 100%; margin-bottom: 8px; padding: 8px; background: var(--button-bg); color: var(--primary-text); border: 1px solid var(--button-bg); border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">测试FileWatcher</button>
                        <button id="importPresetMessageBtn" style="width: 100%; padding: 8px; background: var(--user-bubble-bg); color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">导入预设信息</button>
                    </div>
                </div>
            </div>
        `;

        // 添加到页面
        document.body.insertAdjacentHTML('beforeend', panelHTML);

        // 绑定事件
        bindTestPanelEvents();

        // 添加预设消息测试按钮
        addPresetMessageTestButton();

        return true;
    }

    // --- 绑定测试面板事件 ---
    function bindTestPanelEvents() {
        const panel = document.getElementById('mailboxTestPanel');
        const closeBtn = document.getElementById('closeMailboxTestPanel');
        const agentSelect = document.getElementById('agentSelect');
        const selectAgentBtn = document.getElementById('selectAgentBtn');
        const topicNameInput = document.getElementById('topicNameInput');
        const addMessageBtn = document.getElementById('addMessageBtn');
        const createTopicBtn = document.getElementById('createTopicBtn');
        const refreshAgentsBtn = document.getElementById('refreshAgentsBtn');
        const testFileWatcherBtn = document.getElementById('testFileWatcherBtn');
        const currentStateDiv = document.getElementById('currentState');
        const messagesContainer = document.getElementById('presetMessagesContainer');

        // 关闭面板
        closeBtn?.addEventListener('click', () => {
            panel.style.display = 'none';
        });

        // 刷新Agent列表
        refreshAgentsBtn?.addEventListener('click', async () => {
            await loadAgentsToSelect();
        });

        // 选择Agent
        selectAgentBtn?.addEventListener('click', async () => {
            const selectedAgentId = agentSelect.value;
            if (!selectedAgentId) {
                alert('请选择一个Agent');
                return;
            }

            const result = await selectAgent(selectedAgentId);
            if (result.success) {
                updateCurrentState();
                alert(`成功选择Agent: ${result.agentName}`);
            } else {
                alert(`选择Agent失败: ${result.error}`);
            }
        });

        // 添加消息
        addMessageBtn?.addEventListener('click', () => {
            addPresetMessageInput();
        });

        // 创建话题
        createTopicBtn?.addEventListener('click', async () => {
            const topicName = topicNameInput.value.trim();
            if (!topicName) {
                alert('请输入话题名称');
                return;
            }

            if (!currentAgentId) {
                alert('请先选择一个Agent');
                return;
            }

            // 收集预制消息
            const messages = [];
            const messageItems = messagesContainer.querySelectorAll('.message-item');

            for (const item of messageItems) {
                const roleSelect = item.querySelector('.messageRole');
                const nameInput = item.querySelector('.messageName');
                const contentTextarea = item.querySelector('.messageContent');

                const role = roleSelect.value;
                const name = nameInput.value.trim();
                const content = contentTextarea.value.trim();

                if (content) {
                    const message = { role, content };
                    if (name) {
                        message.name = name;
                    }
                    messages.push(message);
                }
            }

            if (messages.length === 0) {
                alert('请至少添加一条预制消息');
                return;
            }

            const result = await createTopicWithPresetMessages(currentAgentId, topicName, messages);
            if (result.success) {
                updateCurrentState();
                alert(`成功创建话题 "${topicName}"，包含 ${result.messageCount} 条预制消息`);
            } else {
                alert(`创建话题失败: ${result.error}`);
            }
        });

        // 测试FileWatcher
        testFileWatcherBtn?.addEventListener('click', async () => {
            if (!currentAgentId || !currentTopicId) {
                alert('请先选择Agent并创建话题');
                return;
            }

            try {
                // 启动FileWatcher
                const agentConfig = await electronAPI.getAgentConfig(currentAgentId);
                if (agentConfig && agentConfig.agentDataPath) {
                    const historyFilePath = `${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`;
                    await electronAPI.watcherStart(historyFilePath, currentAgentId, currentTopicId);
                    alert('FileWatcher已启动，正在监控话题文件变化');
                } else {
                    alert('无法获取Agent配置或路径');
                }
            } catch (error) {
                alert(`启动FileWatcher失败: ${error.message}`);
            }
        });

        // 导入预设信息功能
        const importPresetMessageBtn = document.getElementById('importPresetMessageBtn');
        importPresetMessageBtn?.addEventListener('click', async () => {
            try {
                if (!currentAgentId) {
                    alert('请先选择一个Agent');
                    return;
                }

                uiHelperFunctions.showToastNotification('正在打开文件选择对话框...', 'info');

                // 使用现有的API导入预设消息文件
                const importResult = await electronAPI.importPresetMessages(currentAgentId);

                if (!importResult || !importResult.success) {
                    if (importResult && importResult.canceled) {
                        uiHelperFunctions.showToastNotification('已取消文件选择', 'info');
                        return;
                    }
                    throw new Error(importResult?.error || '导入失败');
                }

                // 获取导入的数据
                const jsonData = {
                    presetMessages: importResult.messages,
                    enabled: importResult.enabled
                };

                // 验证JSON格式
                if (!jsonData.presetMessages || !Array.isArray(jsonData.presetMessages)) {
                    throw new Error('JSON文件缺少presetMessages数组');
                }

                // 验证消息格式
                const messages = jsonData.presetMessages;
                for (const msg of messages) {
                    if (!msg.content || typeof msg.content !== 'string') {
                        throw new Error('消息内容无效');
                    }
                    if (msg.role && !['user', 'assistant', 'system'].includes(msg.role)) {
                        throw new Error('消息角色必须是 user、assistant 或 system');
                    }
                }

                // 清空现有的预制消息输入框
                const messagesContainer = document.getElementById('presetMessagesContainer');
                messagesContainer.innerHTML = '';

                // 导入消息到输入框
                messages.forEach(msg => {
                    addPresetMessageInput(msg.content, msg.role || 'user');
                });

                uiHelperFunctions.showToastNotification(`✅ 成功导入 ${messages.length} 条预设消息！`, 'success');

                // 提示用户可以通过手动输入话题名称并点击"创建话题"按钮来创建话题
                uiHelperFunctions.showToastNotification('导入完成！您可以在上方输入话题名称后点击"创建话题"按钮来创建带预制消息的话题。', 'info');

            } catch (error) {
                console.error('[MailboxManager] 导入预设信息时出错:', error);
                alert(`❌ 导入失败: ${error.message}`);
                uiHelperFunctions.showToastNotification(`导入失败: ${error.message}`, 'error');
            }
        });

        // 加载Agent列表
        loadAgentsToSelect();

        // 更新状态显示
        updateCurrentState();

        // 定期更新状态
        setInterval(updateCurrentState, 2000);
    }

    // --- 加载Agent列表到选择框 ---
    async function loadAgentsToSelect() {
        const agentSelect = document.getElementById('agentSelect');
        if (!agentSelect) return;

        try {
            const agents = await getAvailableAgents();
            agentSelect.innerHTML = '<option value="">请选择Agent...</option>';

            agents.forEach(agent => {
                const option = document.createElement('option');
                option.value = agent.id;
                option.textContent = agent.name || agent.id;
                agentSelect.appendChild(option);
            });
        } catch (error) {
            console.error('[MailboxManager] 加载Agent列表失败:', error);
        }
    }

    // --- 添加预制消息输入框 ---
    function addPresetMessageInput(content = '', role = 'user') {
        const container = document.getElementById('presetMessagesContainer');
        if (!container) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = 'message-item';
        messageDiv.style.cssText = 'margin-bottom: 8px; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px;';

        messageDiv.innerHTML = `
            <div style="display: flex; gap: 10px;">
                <!-- 左边 1/4 区域：角色选择、名字设定、删除按钮 -->
                <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
                    <!-- 角色选择 -->
                    <div>
                        <select class="messageRole" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); font-size: 0.9em;">
                            <option value="user" ${role === 'user' ? 'selected' : ''}>用户</option>
                            <option value="assistant" ${role === 'assistant' ? 'selected' : ''}>助手</option>
                            <option value="system" ${role === 'system' ? 'selected' : ''}>系统</option>
                        </select>
                    </div>
                    <!-- 名字设定 -->
                    <div>
                        <input type="text" class="messageName" placeholder="角色名字（可选）" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); font-size: 0.9em; box-sizing: border-box;" title="留空则使用默认名字">
                    </div>
                    <!-- 删除按钮 -->
                    <div>
                        <button class="removeMessageBtn" style="width: 100%; padding: 6px; background: var(--danger-color); color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; transition: background-color 0.2s;">删除</button>
                    </div>
                </div>
                <!-- 右边 3/4 区域：消息内容 -->
                <div style="flex: 3;">
                    <textarea class="messageContent" placeholder="消息内容" style="width: 100%; min-height: 120px; padding: 8px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--input-bg); color: var(--primary-text); resize: vertical; font-size: 0.9em; font-family: inherit;">${content}</textarea>
                </div>
            </div>
        `;

        // 绑定删除事件
        const removeBtn = messageDiv.querySelector('.removeMessageBtn');
        removeBtn.addEventListener('click', () => {
            messageDiv.remove();
        });

        container.appendChild(messageDiv);
    }

    // --- 更新当前状态显示 ---
    function updateCurrentState() {
        const stateDiv = document.getElementById('currentState');
        if (!stateDiv) return;

        const state = getCurrentState();
        stateDiv.innerHTML = `
            初始化状态: ${state.isInitialized ? '已初始化' : '未初始化'}<br>
            当前Agent ID: ${state.currentAgentId || '无'}<br>
            当前话题 ID: ${state.currentTopicId || '无'}<br>
            有活动Agent: ${state.hasActiveAgent ? '是' : '否'}<br>
            有活动话题: ${state.hasActiveTopic ? '是' : '否'}
        `;
    }

    // --- 测试预设消息功能 ---
    async function testPresetMessageWorkflow() {
        console.log('[MailboxManager] 开始测试预设消息工作流程...');

        try {
            // 1. 获取所有Agent
            const agents = await getAvailableAgents();
            if (agents.length === 0) {
                console.error('[MailboxManager] 没有找到任何Agent');
                return { success: false, error: '没有找到任何Agent' };
            }

            const testAgent = agents[0];
            console.log(`[MailboxManager] 使用测试Agent: ${testAgent.name} (${testAgent.id})`);

            // 2. 检查Agent是否有预设消息
            const presetCheck = await checkAgentPresetMessages(testAgent.id);
            console.log(`[MailboxManager] Agent预设消息检查结果:`, presetCheck);

            if (presetCheck.hasPreset) {
                console.log(`[MailboxManager] Agent已有${presetCheck.messages.length}条预设消息`);
            } else {
                console.log(`[MailboxManager] Agent没有预设消息，创建测试预设消息`);

                // 3. 创建测试预设消息
                const testMessages = [
                    { role: 'system', content: '你是测试Agent，请友好地回应用户。' },
                    { role: 'user', content: '你好，请介绍一下你自己。' },
                    { role: 'assistant', content: '你好！我是一个测试Agent，很高兴见到你。请问有什么我可以帮助你的吗？' }
                ];

                // 保存预设消息到Agent配置
                const saveResult = await electronAPI.saveAgentConfig(testAgent.id, {
                    presetMessages: testMessages,
                    presetMessageEnabled: true
                });

                if (!saveResult.success) {
                    console.error('[MailboxManager] 保存预设消息失败:', saveResult.error);
                    return { success: false, error: saveResult.error };
                }

                console.log('[MailboxManager] 测试预设消息已创建并保存');
            }

            // 4. 使用自动预设消息创建话题
            const topicName = `预设消息测试话题_${Date.now()}`;
            const createResult = await createTopicWithAutoPreset(testAgent.id, topicName);

            if (createResult.success) {
                console.log(`[MailboxManager] ✅ 预设消息工作流程测试成功！创建了话题: ${createResult.topicId}`);

                // 5. 验证话题历史是否包含预设消息
                const history = await electronAPI.getChatHistory(testAgent.id, createResult.topicId);
                if (history && history.length > 0) {
                    console.log(`[MailboxManager] ✅ 话题历史验证成功，包含 ${history.length} 条消息`);
                    return {
                        success: true,
                        topicId: createResult.topicId,
                        messageCount: history.length,
                        agentId: testAgent.id,
                        agentName: testAgent.name
                    };
                } else {
                    console.warn('[MailboxManager] ⚠️ 话题创建成功但历史消息为空');
                    return {
                        success: true,
                        topicId: createResult.topicId,
                        messageCount: 0,
                        agentId: testAgent.id,
                        agentName: testAgent.name,
                        warning: '话题历史消息为空'
                    };
                }
            } else {
                console.error('[MailboxManager] ❌ 预设消息工作流程测试失败:', createResult.error);
                return { success: false, error: createResult.error };
            }

        } catch (error) {
            console.error('[MailboxManager] 测试预设消息工作流程时出错:', error);
            return { success: false, error: error.message };
        }
    }

    // --- 显示测试面板 ---
    function showTestPanel() {
        let panel = document.getElementById('mailboxTestPanel');
        if (!panel) {
            createTestPanel();
            panel = document.getElementById('mailboxTestPanel');
        }
        panel.style.display = 'block';
    }

    // --- 隐藏测试面板 ---
    function hideTestPanel() {
        const panel = document.getElementById('mailboxTestPanel');
        if (panel) {
            panel.style.display = 'none';
        }
    }

    // --- 公共API ---
    return {
        init,
        getAvailableAgents,
        selectAgent,
        createTopicWithPresetMessages,
        createTopicWithAutoPreset,
        createTopicFromJsonFile,
        checkAgentPresetMessages,
        switchToTopic,
        getCurrentState,
        showTestPanel,
        hideTestPanel,
        createTestPanel,
        testPresetMessageWorkflow
    };
})();