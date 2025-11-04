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

        // 2. 获取请求信息
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

        // 3. 查找Agent信息
        const agentInfo = await findAgentInfo(VchatDataURL, maidName);
        if (!agentInfo) {
            throw new Error(`未找到名为 "${maidName}" 的Agent。`);
        }

        // 4. 创建新话题
        await createTopic(VchatDataURL, agentInfo, topicName, initialMessage);

        // 5. 成功时，将结果字符串输出到 stdout
        console.log(`[AgentTopicCreator] 成功创建了新的话题：${topicName}`);

    } catch (error) {
        // 失败时，将JSON错误信息输出到 stderr，并以非零状态码退出
        console.error(JSON.stringify({ status: "error", error: `[AgentTopicCreator] ${error.message}` }));
        process.exit(1);
    }
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
                "finishReason": "completed"
            }
        ];
        await fs.writeFile(historyFilePath, JSON.stringify(initialHistory, null, 2), 'utf-8');

        // 3. 更新 Agent config.json 中的 topics 列表
        if (!agentConfig.topics) {
            agentConfig.topics = [];
        }
        agentConfig.topics.unshift({
            id: newTopicId,
            name: topicName,
            createdAt: timestamp
        });
        
        // 4. 设置新话题为当前话题
        agentConfig.current_topic_id = newTopicId;

        // 5. 将更新后的配置写回到 Agents 目录
        await fs.writeFile(agentConfigPath, JSON.stringify(agentConfig, null, 2), 'utf-8');

    } catch (error) {
        throw new Error(`创建新话题时发生错误: ${error.message}`);
    }
}

main();