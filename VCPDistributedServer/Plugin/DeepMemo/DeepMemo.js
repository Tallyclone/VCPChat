const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const Fuse = require('fuse.js');
const cheerio = require('cheerio');

// --- 主逻辑 ---
async function main() {
    try {
        const input = await readStdin();
        const args = parseToolArgs(input);

        // 1. 加载配置
        const config = await loadConfig();
        const { VchatDataURL, MaxMemoTokens } = config;

        // 2. 获取请求信息
        const maidName = args.maid;
        if (!maidName) {
            throw new Error("请求中缺少 'maid' 参数。");
        }
        const keywords = (args.keyword || '').split(/[,，\s]+/).filter(Boolean);
        if (keywords.length === 0) {
            throw new Error("请求中缺少 'keyword' 参数。");
        }
        let windowSize = parseInt(args.window_size || '10', 10);
        if (windowSize < 1) {
            windowSize = 1;
        }

        // 3. 查找Agent信息
        const agentInfo = await findAgentInfo(VchatDataURL, maidName);
        if (!agentInfo) {
            throw new Error(`未找到名为 "${maidName}" 的Agent。`);
        }
        
        const userName = await findUserName(VchatDataURL);

        // 4. 搜索聊天记录
        const memories = await searchHistories(VchatDataURL, agentInfo.uuid, keywords, windowSize, userName, agentInfo.name);

        // 5. 格式化并输出结果
        let output = memories.join('\n\n');
        if (output.length > MaxMemoTokens) {
            output = output.substring(0, MaxMemoTokens) + "\n... [内容过长，已被截断]";
        }
        
        if (!output.trim()) {
             output = `[DeepMemo] 未找到与关键词“${keywords.join(', ')}”相关的回忆。`;
        }

        // 成功时，直接将结果字符串输出到 stdout
        // 成功时，输出包含状态和结果的JSON对象
        console.log(JSON.stringify({ status: "success", result: output }));

    } catch (error) {
        // 失败时，将JSON错误信息输出到 stderr，并以非零状态码退出
        console.error(JSON.stringify({ status: "error", error: `[DeepMemo] ${error.message}` }));
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
        // VCP服务器通过stdin传递的是一个JSON字符串
        args = JSON.parse(input);
    } catch (e) {
        // 将错误输出到 stderr
        console.error(JSON.stringify({ status: "error", error: `[DeepMemo] 无效的输入格式，无法解析JSON: ${input}` }));
        process.exit(1);
    }

    // 兼容 keyword, key_word, KeyWord
    if (args.key_word) {
        args.keyword = args.key_word;
        delete args.key_word;
    }
    if (args.KeyWord) {
        args.keyword = args.KeyWord;
        delete args.KeyWord;
    }

    // 兼容 window_size, windowsize
    if (args.windowsize) {
        args.window_size = args.windowsize;
        delete args.windowsize;
    }
    
    return args;
}

async function loadConfig() {
    // 动态计算 VchatDataURL 路径，它应该是插件目录向上三层，然后进入 AppData
    const VchatDataURL = path.join(__dirname, '..', '..', '..', 'AppData');

    const configPath = path.join(__dirname, 'config.env');
    try {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = dotenv.parse(configContent);
        if (!config.MaxMemoTokens) {
            throw new Error("config.env 文件不完整，缺少 MaxMemoTokens。");
        }
        return {
            VchatDataURL: VchatDataURL,
            MaxMemoTokens: parseInt(config.MaxMemoTokens, 10)
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`配置文件 config.env 未找到。`);
        }
        throw new Error(`无法加载或解析 config.env 文件: ${error.message}`);
    }
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
                    return { name: config.name, uuid: folder };
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

async function findUserName(vchatPath) {
    const settingsPath = path.join(vchatPath, 'settings.json');
    try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        return settings.userName || '主人';
    } catch (error) {
        return '主人'; // Fallback
    }
}

async function searchHistories(vchatPath, agentUuid, keywords, windowSize, userName, agentName) {
    const topicsDir = path.join(vchatPath, 'UserData', agentUuid, 'topics');
    let allMemories = [];
    let memoryIndex = 1; // 为回忆片段添加索引

    try {
        const topicFolders = await fs.readdir(topicsDir);

        // 1. 获取所有 history.json 的路径及其最后修改时间
        let historyFiles = [];
        for (const topic of topicFolders) {
            const historyPath = path.join(topicsDir, topic, 'history.json');
            try {
                const stats = await fs.stat(historyPath);
                historyFiles.push({ path: historyPath, mtime: stats.mtime });
            } catch (e) {
                // 忽略无法获取状态的文件
            }
        }

        // 2. 按修改时间降序排序
        historyFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        // 3. 排除最新的一个文件进行搜索
        const filesToSearch = historyFiles.slice(1);

        // 4. 遍历剩余的文件进行模糊搜索和去重
        for (const fileInfo of filesToSearch) {
            try {
                const content = await fs.readFile(fileInfo.path, 'utf-8');
                const history = JSON.parse(content).filter(entry => entry.content && typeof entry.content === 'string');

                if (history.length === 0) continue;

                // A. 使用 Fuse.js 进行模糊搜索
                const fuseOptions = {
                    keys: ['content'],
                    includeScore: true,
                    minMatchCharLength: 2, // 避免无意义的单字符匹配
                    threshold: 0.3, // 收紧阈值，确保搜索结果高度相关
                    distance: 10,   // 严格限制多关键词之间的距离
                    ignoreLocation: true,
                };
                const fuse = new Fuse(history, fuseOptions);

                let matchedIndices = new Set();
                keywords.forEach(kw => {
                    const results = fuse.search(kw);
                    results.forEach(result => matchedIndices.add(result.refIndex));
                });

                const sortedIndices = Array.from(matchedIndices).sort((a, b) => a - b);

                // B. 基于排序后的索引构建不重叠的回忆片段
                for (let i = 0; i < sortedIndices.length; i++) {
                    const matchIndex = sortedIndices[i];
                    
                    const start = Math.max(0, matchIndex - windowSize);
                    const end = Math.min(history.length, matchIndex + windowSize + 1);
                    
                    const contextSlice = history.slice(start, end);
                    const formattedMemory = formatMemory(contextSlice, userName, agentName, memoryIndex);
                    
                    if (formattedMemory) {
                        allMemories.push(formattedMemory);
                        memoryIndex++;
                    }

                    // C. 跳过已经被当前回忆片段覆盖的索引，实现去重
                    while (i + 1 < sortedIndices.length && sortedIndices[i + 1] < end) {
                        i++;
                    }
                }
            } catch (e) {
                // 忽略无法读取或解析的单个history.json
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error("读取用户聊天记录时出错。");
        }
        // 如果topics目录不存在，则返回空数组
    }
    return allMemories;
}

function formatMemory(slice, userName, agentName, memoryIndex) {
    let memoryString = "";
    slice.forEach(entry => {
        if (entry.role === 'user' || entry.role === 'assistant') {
            const name = entry.role === 'user' ? userName : agentName;
            // 使用 cheerio 精准提取纯文本
            const $ = cheerio.load(entry.content);
            const cleanContent = $.text().trim();
            
            if (cleanContent) {
                memoryString += `${name}: ${cleanContent}\n`;
            }
        }
    });
    return memoryString.trim() ? `[回忆片段${memoryIndex}]:\n${memoryString.trim()}` : null;
}

main();