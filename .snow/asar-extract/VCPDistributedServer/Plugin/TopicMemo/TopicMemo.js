const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');

// --- 主逻辑 ---
async function main() {
    try {
        const input = await readStdin();
        const args = parseToolArgs(input);

        // 1. 获取 AppData 路径
        const VchatDataURL = path.join(__dirname, '..', '..', '..', 'AppData');

        // 2. 获取 maid 参数
        const maidName = args.maid;
        if (!maidName) {
            throw new Error("请求中缺少 'maid' 参数。");
        }

        // 3. 查找 Agent 信息
        const agentInfo = await findAgentInfo(VchatDataURL, maidName);
        if (!agentInfo) {
            throw new Error(`未找到名为 "${maidName}" 的Agent。`);
        }

        // 4. 获取用户名
        const userName = await findUserName(VchatDataURL);

        // 5. 根据 command 执行不同操作
        const command = args.command || 'ListTopics';
        let result;

        if (command === 'ListTopics') {
            result = await listTopics(agentInfo);
        } else if (command === 'GetTopicContent') {
            const topicId = args.topic_id;
            if (!topicId) {
                throw new Error("请求中缺少 'topic_id' 参数。");
            }
            result = await getTopicContent(VchatDataURL, agentInfo, topicId, userName);
        } else {
            throw new Error(`未知的指令: ${command}，支持的指令: ListTopics, GetTopicContent`);
        }

        console.log(JSON.stringify({ status: "success", result: result }));

    } catch (error) {
        console.error(JSON.stringify({ status: "error", error: `[TopicMemo] ${error.message}` }));
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
        console.error(JSON.stringify({ status: "error", error: `[TopicMemo] 无效的输入格式，无法解析JSON: ${input}` }));
        process.exit(1);
    }

    // 兼容 topic_id 的不同写法
    if (args.topicId) {
        args.topic_id = args.topicId;
        delete args.topicId;
    }
    if (args.TopicId) {
        args.topic_id = args.TopicId;
        delete args.TopicId;
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
                if (config.name && config.name.includes(maidName)) {
                    return {
                        name: config.name,
                        uuid: folder,
                        topics: config.topics || []
                    };
                }
            } catch (e) {
                // 忽略无效的 config.json 文件
            }
        }
        return null;
    } catch (error) {
        throw new Error("无法读取 Agents 目录。");
    }
}

async function findUserName(vchatPath) {
    const settingsPath = path.join(vchatPath, 'settings.json');
    try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        return settings.userName || '主人';
    } catch (error) {
        return '主人';
    }
}

// --- 指令1: 列出所有话题 ---
async function listTopics(agentInfo) {
    const topics = agentInfo.topics;

    if (!topics || topics.length === 0) {
        return `[TopicMemo] ${agentInfo.name} 暂无任何话题记录。`;
    }

    let result = `## ${agentInfo.name} 的话题列表\n\n`;
    result += `共 ${topics.length} 个话题：\n\n`;

    topics.forEach((topic, index) => {
        const createdDate = new Date(topic.createdAt).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
        const lockedTag = topic.locked ? ' 🔒' : '';
        result += `${index + 1}. **${topic.name}**${lockedTag}\n`;
        result += `   - ID: \`${topic.id}\`\n`;
        result += `   - 创建时间: ${createdDate}\n\n`;
    });

    return result;
}

// --- 指令2: 获取话题完整内容 ---
async function getTopicContent(vchatPath, agentInfo, topicId, userName) {
    // 查找话题信息
    const topicInfo = agentInfo.topics.find(t => t.id === topicId);
    if (!topicInfo) {
        throw new Error(`未找到 ID 为 "${topicId}" 的话题。可用的话题ID请先使用 ListTopics 指令查询。`);
    }

    // 读取 history.json
    const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topicId, 'history.json');

    let history;
    try {
        const content = await fs.readFile(historyPath, 'utf-8');
        const rawData = JSON.parse(content);

        // 兼容新版（直接是数组）和旧版（对象内含 messages 数组）
        if (Array.isArray(rawData)) {
            history = rawData;
        } else if (rawData && Array.isArray(rawData.messages)) {
            history = rawData.messages;
        } else {
            history = [];
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`话题 "${topicInfo.name}" 的聊天记录文件不存在。`);
        }
        throw new Error(`无法读取话题 "${topicInfo.name}" 的聊天记录: ${error.message}`);
    }

    if (history.length === 0) {
        return `## 话题：${topicInfo.name}\n\n该话题暂无聊天记录。`;
    }

    // 格式化聊天记录
    const createdDate = new Date(topicInfo.createdAt).toLocaleString('zh-CN');
    let result = `## 话题：${topicInfo.name}\n`;
    result += `创建时间：${createdDate}\n`;
    result += `消息数量：${history.length} 条\n\n`;
    result += `---\n\n`;

    history.forEach((entry, index) => {
        if (entry.role && entry.content) {
            const speakerName = entry.role === 'user' ? userName : agentInfo.name;
            const cleanContent = cleanHtmlContent(entry.content);

            if (cleanContent) {
                result += `**${speakerName}**: ${cleanContent}\n\n`;
            }
        }
    });

    return result;
}

// --- HTML 内容清理 ---
function cleanHtmlContent(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return '';
    }

    // 如果内容不包含 HTML 标签，直接返回
    if (!/<[^>]+>/.test(htmlContent)) {
        return htmlContent.trim();
    }

    try {
        // 使用 cheerio 解析 HTML
        const $ = cheerio.load(htmlContent, {
            decodeEntities: true,
            xmlMode: false
        });

        // 移除 style 标签（包括内联 @keyframes、CSS 动画等）
        $('style').remove();

        // 移除 script 标签
        $('script').remove();

        // 移除所有元素的 style 属性
        $('[style]').removeAttr('style');

        // 移除所有元素的 class 属性
        $('[class]').removeAttr('class');

        // 提取纯文本
        let text = $.text();

        // 清理多余空白：多个空格/换行合并为单个
        text = text
            .replace(/[\r\n]+/g, '\n')      // 多个换行合并
            .replace(/[ \t]+/g, ' ')         // 多个空格/制表符合并
            .replace(/\n /g, '\n')           // 换行后的空格移除
            .replace(/ \n/g, '\n')           // 换行前的空格移除
            .replace(/\n{3,}/g, '\n\n')      // 超过2个换行合并为2个
            .trim();

        return text;
    } catch (e) {
        // 如果 cheerio 解析失败，尝试简单的正则清理
        return htmlContent
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // 移除 style 标签
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除 script 标签
            .replace(/<[^>]+>/g, '')                          // 移除所有 HTML 标签
            .replace(/\s+/g, ' ')                             // 合并空白
            .trim();
    }
}

main();