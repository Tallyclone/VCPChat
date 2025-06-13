// Assistantmodules/assistant.js

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const closeBtn = document.getElementById('close-btn-assistant');

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
    let activeStreamingMessageId = null;
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });

    const scrollToBottom = () => {
        chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    };

    // --- Independent Rendering Logic for Assistant ---

    const renderMessage = (message) => {
        const messageItem = document.createElement('div');
        messageItem.classList.add('message-item', message.role);
        messageItem.dataset.messageId = message.id || `msg_${Date.now()}`;

        const avatarImg = document.createElement('img');
        avatarImg.classList.add('chat-avatar');
        
        const senderNameDiv = document.createElement('div');
        senderNameDiv.classList.add('sender-name');

        if (message.role === 'user') {
            avatarImg.src = globalSettings.userAvatarUrl || '../assets/default_avatar.png';
            senderNameDiv.textContent = globalSettings.userName || '你';
        } else { // assistant
            avatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
            senderNameDiv.textContent = agentConfig.name || 'AI';
        }
        
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('md-content');
        contentDiv.innerHTML = markedInstance.parse(message.content);

        const nameTimeDiv = document.createElement('div');
        nameTimeDiv.classList.add('name-time-block');
        nameTimeDiv.appendChild(senderNameDiv);

        const detailsAndBubbleWrapper = document.createElement('div');
        detailsAndBubbleWrapper.classList.add('details-and-bubble-wrapper');
        detailsAndBubbleWrapper.appendChild(nameTimeDiv);
        detailsAndBubbleWrapper.appendChild(contentDiv);

        messageItem.appendChild(avatarImg);
        messageItem.appendChild(detailsAndBubbleWrapper);
        
        chatMessagesDiv.appendChild(messageItem);
        scrollToBottom();
        return messageItem;
    };

    const showThinkingIndicator = (messageId) => {
        activeStreamingMessageId = messageId;
        const thinkingMessage = {
            id: messageId,
            role: 'assistant',
            content: '<span class="thinking-indicator">思考中<span class="thinking-indicator-dots">...</span></span>',
        };
        const messageItem = renderMessage(thinkingMessage);
        messageItem.classList.add('streaming');
    };

    const appendStreamChunk = (messageId, chunk) => {
        if (messageId !== activeStreamingMessageId) return;

        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (!messageItem) return;

        const contentDiv = messageItem.querySelector('.md-content');
        const thinkingIndicator = contentDiv.querySelector('.thinking-indicator');
        
        let messageInHistory = currentChatHistory.find(m => m.id === messageId);
        
        if (!messageInHistory) {
            messageInHistory = { id: messageId, role: 'assistant', content: '', timestamp: Date.now() };
            currentChatHistory.push(messageInHistory);
        }
        
        if (thinkingIndicator) {
            contentDiv.innerHTML = ''; // Clear "Thinking..." on first chunk
        }

        let textToAppend = "";
        if (chunk && chunk.choices && chunk.choices.length > 0 && chunk.choices[0].delta) {
            textToAppend = chunk.choices[0].delta.content || "";
        }
        messageInHistory.content += textToAppend;
        contentDiv.innerHTML = markedInstance.parse(messageInHistory.content);
        
        scrollToBottom();
    };

    const finalizeStreamedMessage = (messageId, type, error) => {
        if (messageId !== activeStreamingMessageId) return;

        const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.remove('streaming');
            if (type === 'error') {
                const contentDiv = messageItem.querySelector('.md-content');
                contentDiv.innerHTML += `<p class="error-text" style="color: var(--danger-color);">错误: ${error}</p>`;
            }
        }
        activeStreamingMessageId = null;
        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        messageInput.focus();
    };

    // --- Main Logic ---

    closeBtn.addEventListener('click', () => window.close());

    window.electronAPI.onAssistantData(async (data) => {
        console.log('Received assistant data:', data);
        const { selectedText, action, agentId: receivedAgentId, theme } = data;
        
        agentId = receivedAgentId;
        globalSettings = await window.electronAPI.loadSettings();
        agentConfig = await window.electronAPI.getAgentConfig(agentId);

        if (!agentConfig || agentConfig.error) {
            agentNameSpan.textContent = "错误";
            chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">加载助手配置失败: ${agentConfig?.error || '未知错误'}</p></div>`;
            return;
        }

        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
        agentAvatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
        agentNameSpan.textContent = agentConfig.name;

        const prompts = {
            translate: '请将上方文本翻译为简体中文；若原文为中文，则翻译为英文。',
            summarize: '请提取上方文本的核心要点，若含有数据内容可以MD列表等形式呈现。',
            explain: '请通俗易懂地解释上方文本中的关键概念或术语。',
            search: '请将上方文本作为核心关键词进行Tavily网络搜索，并返回最相关的结果摘要。'
        };
        const actionPrompt = prompts[action] || '';
        const initialPrompt = `[引用文本：${selectedText}]\n\n${actionPrompt}`;

        // Clear previous state and send the new prompt
        chatMessagesDiv.innerHTML = '';
        currentChatHistory = [];
        sendMessage(initialPrompt);
    });

    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Assistant Window] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
    });

    const sendMessage = async (messageContent) => {
        if (!messageContent.trim() || !agentConfig) return;

        // 1. Add user message to history and render it
        const userMessage = { role: 'user', content: messageContent, timestamp: Date.now() };
        currentChatHistory.push(userMessage);
        renderMessage(userMessage);
        
        messageInput.value = '';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;

        // 2. Show "thinking" bubble in UI (without adding to history)
        const thinkingMessageId = `assistant_msg_${Date.now()}`;
        showThinkingIndicator(thinkingMessageId);

        try {
            // 3. Prepare and send the request to VCP
            const latestAgentConfig = await window.electronAPI.getAgentConfig(agentId);
            if (!latestAgentConfig || latestAgentConfig.error) throw new Error(`无法获取最新的助手配置: ${latestAgentConfig?.error || '未知错误'}`);
            agentConfig = latestAgentConfig;

            const systemPrompt = (agentConfig.systemPrompt || '').replace(/\{\{AgentName\}\}/g, agentConfig.name);
            const messagesForVCP = [];
            if (systemPrompt) messagesForVCP.push({ role: 'system', content: systemPrompt });
            
            // Build from the clean history which only contains actual conversation
            const historyForVCP = currentChatHistory.map(msg => ({ role: msg.role, content: msg.content }));
            messagesForVCP.push(...historyForVCP);

            const modelConfig = {
                model: agentConfig.model,
                temperature: agentConfig.temperature,
                stream: true,
                max_tokens: agentConfig.maxOutputTokens
            };

            await window.electronAPI.sendToVCP(globalSettings.vcpServerUrl, globalSettings.vcpApiKey, messagesForVCP, modelConfig, thinkingMessageId);

        } catch (error) {
            console.error('Error sending message to VCP:', error);
            finalizeStreamedMessage(thinkingMessageId, 'error', `请求失败: ${error.message}`);
        }
    };

    window.electronAPI.onVCPStreamChunk((chunkData) => {
        if (chunkData.messageId !== activeStreamingMessageId) return;

        if (chunkData.type === 'data') {
            appendStreamChunk(chunkData.messageId, chunkData.chunk);
        } else if (chunkData.type === 'end' || chunkData.type === 'error') {
            finalizeStreamedMessage(chunkData.messageId, chunkData.type, chunkData.error || 'completed');
        }
    });

    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
});