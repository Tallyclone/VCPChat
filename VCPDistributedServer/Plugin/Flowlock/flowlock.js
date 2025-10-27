// VCPDistributedServer/Plugin/Flowlock/flowlock.js
// 心流锁插件 - 同步类型插件，用于控制前端的自动续写行为

const fs = require('fs');
const path = require('path');

// 状态文件路径
const STATE_FILE = path.join(__dirname, '../../appdata/flowlock-state.json');

// 确保appdata目录存在
const appdataDir = path.dirname(STATE_FILE);
if (!fs.existsSync(appdataDir)) {
    fs.mkdirSync(appdataDir, { recursive: true });
}

/**
 * 读取心流锁状态
 */
function readState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('[Flowlock Plugin] Error reading state:', error.message);
    }
    return {
        isActive: false,
        agentId: null,
        topicId: null,
        customPrompt: null,
        prompterSource: null,
        lastUpdated: null
    };
}

/**
 * 保存心流锁状态
 */
function saveState(state) {
    try {
        state.lastUpdated = new Date().toISOString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('[Flowlock Plugin] Error saving state:', error.message);
    }
}

/**
 * 处理启动命令
 */
function handleStart(args) {
    const { agentId, topicId, immediate } = args;
    
    if (!agentId || !topicId) {
        throw new Error('agentId and topicId are required for start command');
    }

    const state = readState();
    state.isActive = true;
    state.agentId = agentId;
    state.topicId = topicId;
    saveState(state);

    const message = immediate ? '心流锁已启动，正在立即开始续写...' : '心流锁已启动';
    
    return {
        status: 'success',
        result: {
            message: message,
            state: {
                isActive: state.isActive,
                agentId: state.agentId,
                topicId: state.topicId
            },
            // 特殊标记：通知前端执行启动操作
            _frontendAction: 'flowlock_start',
            _frontendPayload: {
                agentId: agentId,
                topicId: topicId,
                immediate: immediate || false
            }
        }
    };
}

/**
 * 处理停止命令
 */
function handleStop(args) {
    const state = readState();
    
    if (!state.isActive) {
        return {
            status: 'success',
            result: {
                message: '心流锁未在运行中',
                state: state
            }
        };
    }

    state.isActive = false;
    const previousAgentId = state.agentId;
    const previousTopicId = state.topicId;
    state.agentId = null;
    state.topicId = null;
    state.customPrompt = null;
    state.prompterSource = null;
    saveState(state);

    return {
        status: 'success',
        result: {
            message: '心流锁已停止',
            state: state,
            // 特殊标记：通知前端执行停止操作
            _frontendAction: 'flowlock_stop',
            _frontendPayload: {
                previousAgentId: previousAgentId,
                previousTopicId: previousTopicId
            }
        }
    };
}

/**
 * 处理设置提示词命令
 */
function handlePromptee(args) {
    const { prompt } = args;
    
    if (!prompt || typeof prompt !== 'string') {
        throw new Error('prompt parameter is required and must be a string');
    }

    const state = readState();
    state.customPrompt = prompt;
    saveState(state);

    return {
        status: 'success',
        result: {
            message: `已设置自定义提示词: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
            state: state,
            // 特殊标记：通知前端更新提示词
            _frontendAction: 'flowlock_set_prompt',
            _frontendPayload: {
                prompt: prompt
            }
        }
    };
}

/**
 * 处理设置提示词来源命令
 */
function handlePrompter(args) {
    const { source, params } = args;
    
    if (!source || typeof source !== 'string') {
        throw new Error('source parameter is required and must be a string');
    }

    const state = readState();
    state.prompterSource = {
        source: source,
        params: params || {},
        setAt: new Date().toISOString()
    };
    saveState(state);

    return {
        status: 'success',
        result: {
            message: `已设置提示词来源: ${source}`,
            state: state,
            // 特殊标记：通知前端更新提示词来源
            _frontendAction: 'flowlock_set_prompter',
            _frontendPayload: {
                source: source,
                params: params
            }
        }
    };
}

/**
 * 主处理函数
 */
function processCommand(args) {
    try {
        const command = args.command || 'start'; // 默认为start命令

        switch (command.toLowerCase()) {
            case 'start':
                return handleStart(args);
            
            case 'stop':
                return handleStop(args);
            
            case 'promptee':
                return handlePromptee(args);
            
            case 'prompter':
                return handlePrompter(args);
            
            default:
                throw new Error(`Unknown command: ${command}`);
        }
    } catch (error) {
        return {
            status: 'error',
            error: error.message
        };
    }
}

// ===== 标准stdio接口 =====
let inputBuffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', () => {
    try {
        if (!inputBuffer.trim()) {
            throw new Error('No input received.');
        }
        
        // 解析输入参数
        const args = JSON.parse(inputBuffer);
        
        // 处理命令
        const result = processCommand(args);
        
        // 输出结果
        console.log(JSON.stringify(result));
        
    } catch (error) {
        // 输出错误
        const errorResult = {
            status: 'error',
            error: error.message
        };
        console.log(JSON.stringify(errorResult));
        process.exit(1);
    }
});

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
    const errorResult = {
        status: 'error',
        error: `Uncaught exception: ${error.message}`
    };
    console.log(JSON.stringify(errorResult));
    process.exit(1);
});