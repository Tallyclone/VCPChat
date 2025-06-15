const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // 只加载插件目录下的.env

// --- 配置 ---
// 从环境变量中读取Everything可执行文件的路径
const EVERYTHING_ES_PATH = process.env.EVERYTHING_ES_PATH || 'C:\\Program Files (x86)\\Everything\\es.exe';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// --- 工具函数 ---
function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        const timestamp = new Date().toISOString();
        // 使用 stderr 输出调试信息，避免污染 stdout
        console.error(`[DEBUG ${timestamp}] ${message}`);
        if (data) {
            console.error(JSON.stringify(data, null, 2));
        }
    }
}

// --- 核心功能 ---
/**
 * 使用 Everything 的 es.exe 命令行工具执行搜索。
 * @param {string} query - 搜索查询字符串。
 * @param {number} maxResults - 返回的最大结果数量。
 * @returns {Promise<string[]>} - 返回一个包含文件绝对路径的数组。
 */
function searchWithEverything(query, maxResults = 100) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(EVERYTHING_ES_PATH)) {
            return reject(new Error(`Everything command line tool (es.exe) not found at: ${EVERYTHING_ES_PATH}. Please check the path in the .env file.`));
        }

        // 构建命令行指令
        // -n <count> : 限制输出数量
        // -full-path-and-name : 输出完整路径和文件名
        const command = `"${EVERYTHING_ES_PATH}" -n ${maxResults} "${query}"`;
        debugLog('Executing Everything command', { command });

        exec(command, { encoding: 'buffer' }, (error, stdout, stderr) => {
            if (error) {
                const errorMessage = iconv.decode(stderr, 'gbk');
                debugLog('Everything command execution error', { code: error.code, message: errorMessage });
                return reject(new Error(`Everything search failed: ${errorMessage}`));
            }

            // Everything 的输出通常是 GBK 编码
            const decodedStdout = iconv.decode(stdout, 'gbk');
            const results = decodedStdout.trim().split('\r\n').filter(line => line.trim() !== '');
            debugLog('Search successful', { resultCount: results.length });
            resolve(results);
        });
    });
}

/**
 * 主处理函数
 * @param {object} request - 从 VCP PluginManager 传入的已解析的 JSON 对象
 */
async function processRequest(request) {
    const { query, maxResults } = request;

    if (!query) {
        return {
            status: 'error',
            error: 'Missing required parameter: query',
        };
    }

    try {
        const searchResults = await searchWithEverything(query, maxResults);
        return {
            status: 'success',
            result: JSON.stringify({
                searchQuery: query,
                resultCount: searchResults.length,
                results: searchResults,
            }),
        };
    } catch (error) {
        return {
            status: 'error',
            error: error.message,
        };
    }
}


// --- stdio 通信 ---
let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;
    // 假设一次只接收一个完整的JSON对象
});

process.stdin.on('end', async () => {
    if (!inputBuffer.trim()) {
        console.log(JSON.stringify({ status: 'error', error: 'No input received.' }));
        return;
    }
    debugLog('Received raw input', inputBuffer);
    try {
        const request = JSON.parse(inputBuffer);
        const response = await processRequest(request);
        console.log(JSON.stringify(response));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: `Invalid JSON input: ${error.message}` }));
    }
});

debugLog('LocalSearchController plugin started and listening for requests via stdin.');
