const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

// --- 主逻辑 ---
async function main() {
    try {
        const input = await readStdin();
        const args = parseToolArgs(input);

        // 1. 动态计算 VchatDataURL 路径
        const VchatDataURL = path.join(__dirname, '..', '..', '..', 'AppData');

        // 2. 获取工具名称
        const toolName = args.tool_name;
        
        if (!toolName) {
            throw new Error("请求中缺少 'tool_name' 参数。");
        }

        // 3. 根据工具名称执行不同的命令
        let result;
        switch (toolName) {
            case 'CreateTopic':
                result = await handleCreateTopic(VchatDataURL, args);
                break;
            case 'ReadUnlockedTopics':
                result = await handleReadUnlockedTopics(VchatDataURL, args);
                break;
            case 'CheckNewTopics':
                result = await handleCheckNewTopics(VchatDataURL, args);
                break;
            case 'CheckUnreadMessages':
                result = await handleCheckUnreadMessages(VchatDataURL, args);
                break;
            case 'ReplyToTopic':
                result = await handleReplyToTopic(VchatDataURL, args);
                break;
            case 'CheckTopicOwnership':
                result = await handleCheckTopicOwnership(VchatDataURL, args);
                break;
            default:
                throw new Error(`未知的工具名称: ${toolName}`);
        }

        // 4. 输出结果
        console.log(JSON.stringify(result));

    } catch (error) {
        // 失败时，将JSON错误信息输出到 stderr，并以非零状态码退出
        console.error(JSON.stringify({ status: "error", error: `[AgentTopicCreator] ${error.message}` }));
        process.exit(1);
    }
}

// --- 命令处理函数 ---

async function handleCreateTopic(vchatPath, args) {
    const maidName = args.maid;
    const topicName = args.topic_name;
    const initialMessage = args.initial_message;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }
    if (!topicName) {
        throw new Error("请求中缺少 'topic_name' 参数。");
    }
    if (!initialMessage) {
        throw new Error("请求中缺少 'initial_message' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    await createTopic(vchatPath, agentInfo, topicName, initialMessage);

    return {
        status: 'success',
        message: `成功创建了新的话题：${topicName}`,
        agent_name: agentInfo.name,
        topic_name: topicName
    };
}

async function handleReadUnlockedTopics(vchatPath, args) {
    const maidName = args.maid;
    const includeRead = args.include_read || false;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    return await readUnlockedTopics(vchatPath, agentInfo, includeRead);
}

async function handleCheckNewTopics(vchatPath, args) {
    const maidName = args.maid;
    const days = args.days || 3;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    return await checkNewTopics(vchatPath, agentInfo, days);
}

async function handleCheckUnreadMessages(vchatPath, args) {
    const maidName = args.maid;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    return await checkUnreadMessages(vchatPath, agentInfo);
}

async function handleReplyToTopic(vchatPath, args) {
    const maidName = args.maid;
    const topicId = args.topic_id;
    const message = args.message;
    const senderName = args.sender_name;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }
    if (!topicId) {
        throw new Error("请求中缺少 'topic_id' 参数。");
    }
    if (!message) {
        throw new Error("请求中缺少 'message' 参数。");
    }
    if (!senderName) {
        throw new Error("请求中缺少 'sender_name' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    return await replyToTopic(vchatPath, agentInfo, topicId, message, senderName);
}

async function handleCheckTopicOwnership(vchatPath, args) {
    const maidName = args.maid;
    const topicId = args.topic_id;
    const callerName = args.caller_name;

    if (!maidName) {
        throw new Error("请求中缺少 'maid' 参数。");
    }
    if (!topicId) {
        throw new Error("请求中缺少 'topic_id' 参数。");
    }
    if (!callerName) {
        throw new Error("请求中缺少 'caller_name' 参数。");
    }

    const agentInfo = await findAgentInfo(vchatPath, maidName);
    if (!agentInfo) {
        throw new Error(`未找到名为 "${maidName}" 的Agent。`);
    }

    return await checkTopicOwnership(vchatPath, agentInfo, topicId, callerName);
}

// --- 辅助函数 ---

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
    });
}

function parseToolArgs(input) {
    let args;
    try {
        args = JSON.parse(input);
    } catch (e) {
        console.error(JSON.stringify({ status: "error", error: `[AgentTopicCreator] 无效的输入格式，无法解析JSON: ${input}` }));
        process.exit(1);
    }
    return args;
}

async function findAgentInfo(vchatPath, maidName) {
    const agentsDir = path.join(vchatPath, 'Agents');
    try {
        const agentFolders = await fs.readdir(agentsDir);
        for (const folder of agentFolders) {
            const configPath = path.join(agentsDir, folder, 'config.json');
            try {
                const content = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(content);
                if (config.name.includes(maidName)) {
                    config.uuid = folder; // Add uuid to the config object
                    return config;
                }
            } catch (e) {
                // 忽略无效的config.json文件
            }
        }
        return null;
    } catch (error) {
        throw new Error("无法读取 Agents 目录。");
    }
}

function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function createTopic(vchatPath, agentInfo, topicName, initialMessage) {
    const agentUuid = agentInfo.uuid;
    
    // 定义正确的路径
    const agentConfigDir = path.join(vchatPath, 'Agents', agentUuid);
    const agentConfigPath = path.join(agentConfigDir, 'config.json');
    const userDataDir = path.join(vchatPath, 'UserData', agentUuid);
    const topicsDir = path.join(userDataDir, 'topics');

    try {
        // 1. 读取并备份位于 Agents 目录下的 config.json
        let agentConfig;
        try {
            const agentConfigContent = await fs.readFile(agentConfigPath, 'utf-8');
            const backupPath = path.join(agentConfigDir, 'config.topic.backup.json');
            await fs.writeFile(backupPath, agentConfigContent, 'utf-8');
            agentConfig = JSON.parse(agentConfigContent);
        } catch (error) {
            // 如果 Agent 的 config.json 不存在或无效，这是一个严重错误
            if (error.code === 'ENOENT' || error instanceof SyntaxError) {
                 throw new Error(`Agent 的配置文件不存在或格式错误: ${agentConfigPath}`);
            } else {
                throw error; // 抛出其他读取错误
            }
        }

        // 2. 在 UserData 目录下创建话题文件夹和 history.json
        const newTopicId = `topic_${Date.now()}`;
        const newTopicPath = path.join(topicsDir, newTopicId);
        await fs.mkdir(newTopicPath, { recursive: true });

        const timestamp = Date.now();
        const messageId = `msg_${timestamp}_assistant_${generateRandomString(7)}`;
        const avatarPath = path.join(agentConfigDir, 'avatar.png');
        const avatarUrl = `file://${avatarPath.replace(/\\/g, '/')}`; // 确保是 file URL 兼容的路径
        const historyFilePath = path.join(newTopicPath, 'history.json');
        
        // 创建带有元数据的初始消息
        const initialHistory = [
            {
                "role": "assistant",
                "name": agentInfo.name,
                "content": initialMessage,
                "timestamp": timestamp,
                "id": messageId,
                "isThinking": false,
                "avatarUrl": avatarUrl,
                "avatarColor": agentInfo.avatarColor || "rgb(96,106,116)",
                "isGroupMessage": false,
                "agentId": agentUuid,
                "finishReason": "completed",
                "_metadata": {
                    "topicCreator": agentInfo.name,
                    "creatorAgentId": agentUuid,
                    "createdBy": "plugin",
                    "createdAt": timestamp
                }
            }
        ];
        await fs.writeFile(historyFilePath, JSON.stringify(initialHistory, null, 2), 'utf-8');

        // 3. 更新 Agent config.json 中的 topics 列表
        if (!agentConfig.topics) {
            agentConfig.topics = [];
        }
        
        // 添加带有扩展元数据的话题
        agentConfig.topics.unshift({
            id: newTopicId,
            name: topicName,
            createdAt: timestamp,
            locked: false,           // 插件创建的话题默认未锁定
            unread: true,            // 插件创建的话题默认未读
            creatorSource: "plugin:TopicCreator",
            _creator: {
                agentName: agentInfo.name,
                agentId: agentUuid,
                timestamp: timestamp
            }
        });
        
        // 4. 设置新话题为当前话题
        agentConfig.current_topic_id = newTopicId;

        // 5. 将更新后的配置写回到 Agents 目录
        await fs.writeFile(agentConfigPath, JSON.stringify(agentConfig, null, 2), 'utf-8');

    } catch (error) {
        throw new Error(`创建新话题时发生错误: ${error.message}`);
    }
}

// --- 新增的功能函数 ---

async function readUnlockedTopics(vchatPath, agentInfo, includeRead = false) {
    const agentConfigPath = path.join(vchatPath, 'Agents', agentInfo.uuid, 'config.json');
    const config = JSON.parse(await fs.readFile(agentConfigPath, 'utf-8'));
    
    const unlockedTopics = (config.topics || []).filter(topic => {
        if (topic.locked) return false;
        if (!includeRead && !topic.unread) return false;
        return true;
    });

    const topicsWithMessages = [];
    for (const topic of unlockedTopics) {
        const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topic.id, 'history.json');
        try {
            const history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
            topicsWithMessages.push({
                topic_id: topic.id,
                topic_name: topic.name,
                locked: topic.locked || false,
                unread: topic.unread || false,
                created_at: topic.createdAt,
                message_count: history.length,
                messages: history
            });
        } catch (e) {
            console.error(`Failed to read history for topic ${topic.id}:`, e);
        }
    }

    return {
        status: 'success',
        agent_name: agentInfo.name,
        agent_id: agentInfo.uuid,
        topics: topicsWithMessages,
        total_topics: topicsWithMessages.length
    };
}

async function checkNewTopics(vchatPath, agentInfo, days = 3) {
    const agentConfigPath = path.join(vchatPath, 'Agents', agentInfo.uuid, 'config.json');
    const config = JSON.parse(await fs.readFile(agentConfigPath, 'utf-8'));
    
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    const newUnlockedTopics = (config.topics || []).filter(topic => {
        return !topic.locked && topic.createdAt > cutoffTime;
    });

    return {
        status: 'success',
        agent_name: agentInfo.name,
        has_new_topics: newUnlockedTopics.length > 0,
        new_topics_count: newUnlockedTopics.length,
        topics: newUnlockedTopics.map(t => ({
            topic_id: t.id,
            topic_name: t.name,
            created_at: t.createdAt,
            age_hours: (Date.now() - t.createdAt) / (1000 * 60 * 60),
            locked: t.locked || false
        }))
    };
}

async function checkUnreadMessages(vchatPath, agentInfo) {
    const agentConfigPath = path.join(vchatPath, 'Agents', agentInfo.uuid, 'config.json');
    const config = JSON.parse(await fs.readFile(agentConfigPath, 'utf-8'));
    
    const unreadTopics = (config.topics || []).filter(topic => topic.unread);

    const unreadTopicsInfo = [];
    for (const topic of unreadTopics) {
        const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topic.id, 'history.json');
        try {
            const history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
            const lastMessage = history[history.length - 1];
            unreadTopicsInfo.push({
                topic_id: topic.id,
                topic_name: topic.name,
                locked: topic.locked || false,
                unread: topic.unread,
                last_message_time: lastMessage ? lastMessage.timestamp : topic.createdAt
            });
        } catch (e) {
            console.error(`Failed to read history for topic ${topic.id}:`, e);
        }
    }

    return {
        status: 'success',
        agent_name: agentInfo.name,
        has_unread: unreadTopicsInfo.length > 0,
        unread_topics: unreadTopicsInfo
    };
}

async function replyToTopic(vchatPath, agentInfo, topicId, message, senderName) {
    // 1. 检查话题是否存在且可操作
    const agentConfigPath = path.join(vchatPath, 'Agents', agentInfo.uuid, 'config.json');
    const config = JSON.parse(await fs.readFile(agentConfigPath, 'utf-8'));
    const topic = config.topics.find(t => t.id === topicId);
    
    if (!topic) {
        throw new Error(`话题 ${topicId} 不存在。`);
    }
    
    if (topic.locked && !topic.unread) {
        throw new Error(`话题 ${topicId} 已锁定且未标记为未读，无法添加回复。`);
    }

    // 2. 读取话题历史
    const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topicId, 'history.json');
    const history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));

    // 3. 添加新消息（署名发送者）
    const timestamp = Date.now();
    const newMessage = {
        role: 'assistant',
        name: senderName,
        content: message,
        timestamp: timestamp,
        id: `msg_${timestamp}_plugin_${generateRandomString(7)}`,
        isThinking: false,
        _metadata: {
            isPluginReply: true,
            originalSender: senderName,
            targetAgent: agentInfo.name
        }
    };

    history.push(newMessage);

    // 4. 保存更新后的历史
    await fs.writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8');

    return {
        status: 'success',
        message: `成功在 ${agentInfo.name} 的话题 "${topic.name}" 中添加回复。`,
        topic_id: topicId,
        sender: senderName
    };
}

async function checkTopicOwnership(vchatPath, agentInfo, topicId, callerName) {
    // 1. 读取 config.json
    const agentConfigPath = path.join(vchatPath, 'Agents', agentInfo.uuid, 'config.json');
    const config = JSON.parse(await fs.readFile(agentConfigPath, 'utf-8'));
    const topic = config.topics.find(t => t.id === topicId);
    
    if (!topic) {
        throw new Error(`话题 ${topicId} 不存在。`);
    }

    // 2. 检查创建者信息
    let creatorName = 'unknown';
    let isOwner = false;

    if (topic._creator && topic._creator.agentName) {
        creatorName = topic._creator.agentName;
        isOwner = creatorName === callerName;
    } else {
        // 如果没有 _creator 信息，尝试从 history.json 的第一条消息中读取
        try {
            const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topicId, 'history.json');
            const history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
            if (history.length > 0 && history[0]._metadata) {
                creatorName = history[0]._metadata.topicCreator || history[0].name || 'unknown';
                isOwner = creatorName === callerName;
            }
        } catch (e) {
            console.error(`Failed to read history for topic ${topicId}:`, e);
        }
    }

    return {
        status: 'success',
        is_owner: isOwner,
        creator_name: creatorName,
        topic_name: topic.name
    };
}

main();