// modules/contextSanitizer.js
// 上下文HTML标签转MD净化器模块

const cheerio = require('cheerio');
const TurndownService = require('turndown');

/**
 * LRU缓存类，支持过期时间
 */
class LRUCache {
    constructor(maxSize = 100, ttl = 3600000) { // 默认最大100条，过期时间1小时
        this.maxSize = maxSize;
        this.ttl = ttl; // Time to live in milliseconds
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            return null;
        }

        const item = this.cache.get(key);
        const now = Date.now();

        // 检查是否过期
        if (now - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        // LRU: 将访问的项移到最后（最新）
        this.cache.delete(key);
        this.cache.set(key, item);

        return item.value;
    }

    set(key, value) {
        // 如果已存在，先删除旧的
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 如果缓存已满，删除最旧的（第一个）
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        // 添加新项
        this.cache.set(key, {
            value: value,
            timestamp: Date.now()
        });
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

/**
 * 上下文净化器类
 */
class ContextSanitizer {
    constructor() {
        // 初始化 LRU 缓存，最大100条，1小时过期
        this.cache = new LRUCache(100, 3600000);

        // 初始化 Turndown 服务
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
        });

        // 自定义规则：保留 img 标签的 src
        this.turndownService.addRule('preserveImages', {
            filter: 'img',
            replacement: (content, node) => {
                const src = node.getAttribute('src');
                const alt = node.getAttribute('alt') || '';
                if (src) {
                    // 保持原始的 img 标签，但简化属性
                    return `<img src="${src}" alt="${alt}">`;
                }
                return '';
            }
        });

        // 自定义规则：保留其他多媒体元素（audio, video）
        this.turndownService.addRule('preserveMedia', {
            filter: ['audio', 'video'],
            replacement: (content, node) => {
                const tagName = node.nodeName.toLowerCase();
                const src = node.getAttribute('src');
                if (src) {
                    return `<${tagName} src="${src}"></${tagName}>`;
                }
                // 如果有 source 子元素
                const sources = node.querySelectorAll('source');
                if (sources.length > 0) {
                    const firstSrc = sources[0].getAttribute('src');
                    if (firstSrc) {
                        return `<${tagName} src="${firstSrc}"></${tagName}>`;
                    }
                }
                return '';
            }
        });
    }

    /**
     * 生成缓存键
     * @param {string} content - 原始内容
     * @returns {string} - 缓存键（使用简单的哈希）
     */
    generateCacheKey(content) {
        // 使用简单的字符串哈希作为缓存键
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return `sanitized_${hash}_${content.length}`;
    }

    /**
     * 检查内容是否包含 HTML 标签
     * @param {string} content - 要检查的内容
     * @returns {boolean} - 是否包含 HTML
     */
    containsHTML(content) {
        if (typeof content !== 'string') return false;
        
        // 简单检查：是否包含 HTML 标签
        const htmlRegex = /<[^>]+>/;
        return htmlRegex.test(content);
    }

    /**
     * 净化单条消息内容：HTML -> Markdown
     * @param {string} content - 原始内容
     * @returns {string} - 净化后的内容
     */
    sanitizeContent(content) {
        if (typeof content !== 'string' || !content.trim()) {
            return content;
        }

        // 如果不包含 HTML，直接返回
        if (!this.containsHTML(content)) {
            return content;
        }

        // 尝试从缓存获取
        const cacheKey = this.generateCacheKey(content);
        const cached = this.cache.get(cacheKey);
        if (cached !== null) {
            console.log('[ContextSanitizer] Cache hit for content');
            return cached;
        }

        try {
            // 使用 cheerio 解析 HTML
            const $ = cheerio.load(content, {
                decodeEntities: false, // 不解码实体，保持原样
                xmlMode: false
            });

            // 提取所有多媒体元素的信息（在转换前）
            const mediaElements = [];
            $('img, audio, video').each((i, elem) => {
                const $elem = $(elem);
                const tagName = elem.name;
                const src = $elem.attr('src');
                if (src) {
                    mediaElements.push({
                        tag: tagName,
                        src: src,
                        alt: $elem.attr('alt') || ''
                    });
                }
            });

            // 获取 HTML 字符串
            const htmlString = $.html();

            // 使用 turndown 转换为 Markdown
            let markdown = this.turndownService.turndown(htmlString);

            // 清理多余的空行（保留最多2个连续空行）
            markdown = markdown.replace(/\n{3,}/g, '\n\n');

            // 存入缓存
            this.cache.set(cacheKey, markdown);

            console.log('[ContextSanitizer] Sanitized content, cached result');
            return markdown;

        } catch (error) {
            console.error('[ContextSanitizer] Error sanitizing content:', error);
            // 出错时返回原始内容
            return content;
        }
    }

    /**
     * 处理消息历史，根据深度设置净化 AI 消息
     * @param {Array} messages - 消息数组
     * @param {number} startDepth - 净化初始深度（0 = 处理所有，1 = 跳过最后1条AI消息）
     * @returns {Array} - 处理后的消息数组
     */
    sanitizeMessages(messages, startDepth = 2) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return messages;
        }

        // 找出所有 AI 消息的索引
        const aiMessageIndices = [];
        messages.forEach((msg, index) => {
            if (msg.role === 'assistant') {
                aiMessageIndices.push(index);
            }
        });

        if (aiMessageIndices.length === 0) {
            return messages; // 没有 AI 消息，直接返回
        }

        // 计算需要净化的 AI 消息索引
        // startDepth = 0: 处理所有 AI 消息
        // startDepth = 1: 跳过最后 1 条 AI 消息
        // startDepth = 2: 跳过最后 2 条 AI 消息（即从倒数第3条开始）
        const indicesToSanitize = new Set();
        
        if (startDepth === 0) {
            // 处理所有 AI 消息
            aiMessageIndices.forEach(idx => indicesToSanitize.add(idx));
        } else {
            // 只处理较早的 AI 消息
            const skipCount = Math.min(startDepth, aiMessageIndices.length);
            const processCount = aiMessageIndices.length - skipCount;
            
            for (let i = 0; i < processCount; i++) {
                indicesToSanitize.add(aiMessageIndices[i]);
            }
        }

        // 创建新的消息数组，对需要净化的消息进行处理
        const sanitizedMessages = messages.map((msg, index) => {
            if (!indicesToSanitize.has(index)) {
                return msg; // 不需要处理，直接返回
            }

            // 需要净化的消息
            const sanitizedMsg = { ...msg };

            // 处理 content 字段
            if (typeof sanitizedMsg.content === 'string') {
                sanitizedMsg.content = this.sanitizeContent(sanitizedMsg.content);
            } else if (Array.isArray(sanitizedMsg.content)) {
                // 处理多模态内容（content 是数组的情况）
                sanitizedMsg.content = sanitizedMsg.content.map(part => {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        return {
                            ...part,
                            text: this.sanitizeContent(part.text)
                        };
                    }
                    return part; // 其他类型（如 image_url）保持不变
                });
            }

            return sanitizedMsg;
        });

        console.log(`[ContextSanitizer] Processed ${indicesToSanitize.size} AI messages out of ${messages.length} total messages`);
        return sanitizedMessages;
    }

    /**
     * 清空缓存
     */
    clearCache() {
        this.cache.clear();
        console.log('[ContextSanitizer] Cache cleared');
    }

    /**
     * 获取缓存统计信息
     */
    getCacheStats() {
        return {
            size: this.cache.size(),
            maxSize: this.cache.maxSize,
            ttl: this.cache.ttl
        };
    }
}

// 创建单例实例
const contextSanitizer = new ContextSanitizer();

module.exports = contextSanitizer;