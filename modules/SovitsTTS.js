const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

const SOVITS_API_BASE_URL = "http://127.0.0.1:8000";
const MODELS_CACHE_PATH = path.join(app.getPath('userData'), 'sovits_models.json');
const TTS_CACHE_DIR = path.join(app.getPath('userData'), 'tts_cache');

class SovitsTTS {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.isSpeaking = false;
        this.speechQueue = [];
        this.currentSpeechItemId = null; // 用于跟踪当前朗读的气泡ID
        this.initCacheDir();
    }

    async initCacheDir() {
        try {
            await fs.mkdir(TTS_CACHE_DIR, { recursive: true });
        } catch (error) {
            console.error("无法创建TTS缓存目录:", error);
        }
    }

    /**
     * 获取模型列表，优先从缓存读取
     * @param {boolean} forceRefresh 是否强制刷新缓存
     * @returns {Promise<Object>} 模型列表
     */
    async getModels(forceRefresh = false) {
        if (!forceRefresh) {
            try {
                const cachedModels = await fs.readFile(MODELS_CACHE_PATH, 'utf-8');
                console.log('从缓存加载Sovits模型列表。');
                return JSON.parse(cachedModels);
            } catch (error) {
                console.log('Sovits模型缓存不存在或读取失败，将从API获取。');
            }
        }

        try {
            console.log(`正在从 ${SOVITS_API_BASE_URL}/models 获取模型列表...`);
            const response = await axios.post(`${SOVITS_API_BASE_URL}/models`, { version: "v4" });

            if (response.data && response.data.msg === "获取成功" && response.data.models) {
                await fs.writeFile(MODELS_CACHE_PATH, JSON.stringify(response.data.models, null, 2));
                console.log('Sovits模型列表已获取并缓存。');
                return response.data.models;
            } else {
                console.error("获取Sovits模型列表失败: ", response.data);
                return null;
            }
        } catch (error) {
            console.error("请求Sovits模型列表API时出错: ", error.message);
            try {
                const cachedModels = await fs.readFile(MODELS_CACHE_PATH, 'utf-8');
                return JSON.parse(cachedModels);
            } catch (e) {
                return null;
            }
        }
    }

    /**
     * 将文本转换为语音并返回音频数据
     * @param {string} text 要转换的文本
     * @param {string} voice 使用的模型名称
     * @param {number} speed 语速
     * @returns {Promise<Buffer|null>} 音频数据的Buffer
     */
    async textToSpeech(text, voice, speed) {
        const cacheKey = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const cacheFilePath = path.join(TTS_CACHE_DIR, `${cacheKey}.wav`);

        // 1. 检查缓存
        try {
            const cachedAudio = await fs.readFile(cacheFilePath);
            console.log(`从缓存加载TTS音频: ${cacheKey}`);
            return cachedAudio;
        } catch (error) {
            // 缓存不存在或读取失败，继续执行
        }

        // 2. 如果没有缓存，请求API
        const payload = {
            model: "tts-v4",
            input: text,
            voice: voice,
            response_format: "wav",
            speed: speed,
            other_params: {
                text_lang: "中英混合",
                prompt_lang: "中文",
                emotion: "默认",
                text_split_method: "按标点符号切",
            }
        };

        try {
            const response = await axios.post(`${SOVITS_API_BASE_URL}/v1/audio/speech`, payload, {
                responseType: 'arraybuffer'
            });

            if (response.headers['content-type'] === 'audio/wav') {
                const audioBuffer = Buffer.from(response.data);
                // 3. 保存到缓存
                try {
                    await fs.writeFile(cacheFilePath, audioBuffer);
                    console.log(`TTS音频已缓存: ${cacheKey}`);
                } catch (cacheError) {
                    console.error("保存TTS音频缓存失败:", cacheError);
                }
                return audioBuffer;
            } else {
                console.error("Sovits API没有返回音频文件。");
                return null;
            }
        } catch (error) {
            console.error("请求Sovits语音合成API时出错: ", error.message);
            return null;
        }
    }

    /**
     * 将长文本分割成句子队列
     * @param {string} text 
     * @returns {string[]}
     */
    splitText(text) {
        // 根据用户建议，仅按换行符分割
        return text.split('\n').filter(line => line.trim() !== '');
    }

    /**
     * 开始朗读或将朗读任务加入队列
     * @param {string} text 要朗读的完整文本
     * @param {string} voice 模型
     * @param {number} speed 语速
     * @param {string} msgId 消息ID
     */
    speak(text, voice, speed, msgId) {
        const textQueue = this.splitText(text);
        this.speechQueue.push(...textQueue.map(chunk => ({ text: chunk, voice, speed, msgId })));
        
        if (!this.isSpeaking) {
            this.processQueue();
        }
    }

    /**
     * 处理语音队列
     */
    async processQueue() {
        if (this.speechQueue.length === 0) {
            this.isSpeaking = false;
            if (this.currentSpeechItemId) {
                this.mainWindow.webContents.send('tts-status-changed', { msgId: this.currentSpeechItemId, isSpeaking: false });
                this.currentSpeechItemId = null;
            }
            return;
        }

        this.isSpeaking = true;
        const currentTask = this.speechQueue.shift();
        
        // 如果这是一个新的朗读序列，更新UI
        if (this.currentSpeechItemId !== currentTask.msgId) {
            // 如果上一个还在亮，先关掉
            if(this.currentSpeechItemId) {
                 this.mainWindow.webContents.send('tts-status-changed', { msgId: this.currentSpeechItemId, isSpeaking: false });
            }
            this.currentSpeechItemId = currentTask.msgId;
            this.mainWindow.webContents.send('tts-status-changed', { msgId: currentTask.msgId, isSpeaking: true });
        }

        // **优化：开始预合成下一个片段**
        if (this.speechQueue.length > 0) {
            const nextTask = this.speechQueue[0];
            // 异步执行，不阻塞当前任务
            this.textToSpeech(nextTask.text, nextTask.voice, nextTask.speed).then(buffer => {
                if (buffer) {
                    // 将合成好的音频缓存到任务对象中
                    nextTask.audioBuffer = buffer;
                    console.log('预合成下一个音频片段成功。');
                }
            });
        }

        // 检查当前任务是否已经预合成了音频
        const audioBuffer = currentTask.audioBuffer || await this.textToSpeech(currentTask.text, currentTask.voice, currentTask.speed);

        if (audioBuffer) {
            const audioBase64 = audioBuffer.toString('base64');
            this.mainWindow.webContents.send('play-tts-audio', { audioData: audioBase64 });
            // 等待渲染器发送 'sovits-audio-playback-finished' 事件
        } else {
            // 如果合成失败，直接处理下一个
            console.error(`合成失败: "${currentTask.text.substring(0, 20)}..."`);
            this.processQueue();
        }
    }
    
    /**
     * 当渲染进程通知音频播放完成时调用
     */
    audioPlaybackFinished() {
        if (this.isSpeaking) {
            this.processQueue();
        }
    }

    /**
     * 停止当前所有朗读
     */
    stop() {
        this.speechQueue = [];
        this.isSpeaking = false;
        if (this.currentSpeechItemId) {
            this.mainWindow.webContents.send('tts-status-changed', { msgId: this.currentSpeechItemId, isSpeaking: false });
            this.mainWindow.webContents.send('stop-tts-audio'); // 通知渲染器停止当前播放
            this.currentSpeechItemId = null;
        }
        console.log('TTS朗读已停止。');
    }
}

module.exports = SovitsTTS;