// V-Chat Search Manager
// This module handles the global search functionality.

import { scopeCss } from './renderer/contentProcessor.js';

const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CODE_FENCE_REGEX = /```\w*([\s\S]*?)```/g;

const searchManager = {
    // --- Properties ---
    electronAPI: null,
    uiHelper: null,
    chatManager: null,
    currentSelectedItemRef: null,

    elements: {},
    state: {
        allAgents: {},
        allGroups: {},
        searchResults: [],
        currentPage: 1,
        resultsPerPage: 20,
        isFetching: false,
        currentQuery: '',
    },

    // --- Initialization ---
    init(dependencies) {
        console.log('[SearchManager] Initializing...');
        this.electronAPI = dependencies.electronAPI;
        this.uiHelper = dependencies.uiHelper;
        this.chatManager = dependencies.modules.chatManager;
        this.currentSelectedItemRef = dependencies.refs.currentSelectedItemRef;

        this.cacheDOMElements();
        this.setupEventListeners();
    },

    cacheDOMElements() {
        this.elements.modal = document.getElementById('global-search-modal');
        this.elements.closeButton = document.getElementById('global-search-close-button');
        this.elements.input = document.getElementById('global-search-input');
        this.elements.resultsContainer = document.getElementById('global-search-results');
        this.elements.paginationContainer = document.getElementById('global-search-pagination');
    },

    setupEventListeners() {
        // Global key listener for opening (Ctrl+F or Command+F) and closing (Esc) the modal
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                this.openModal();
            }
            if (e.key === 'Escape' && this.elements.modal.style.display !== 'none') {
                e.preventDefault();
                this.closeModal();
            }
        });

        // Close button
        this.elements.closeButton.addEventListener('click', () => this.closeModal());

        // Perform search on Ctrl+Enter or Enter (if not multiline)
        this.elements.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                // Ctrl+Enter 或 Shift+Enter 触发搜索
                if (e.ctrlKey || e.shiftKey) {
                    e.preventDefault();
                    const query = this.elements.input.value.trim();
                    if (query && query !== this.state.currentQuery) {
                        this.performSearch(query);
                    }
                }
                // 单独的 Enter 键允许换行，不触发搜索
            }
        });

        // 也保留原来的 keyup 事件，但只在单行内容时触发
        this.elements.input.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
                const query = this.elements.input.value.trim();
                // 只有当内容不包含换行符时才自动搜索
                if (query && !query.includes('\n') && query !== this.state.currentQuery) {
                    this.performSearch(query);
                }
            }
        });
    },

    openModal() {
        this.elements.modal.style.display = 'flex';
        this.elements.input.focus();
        this.elements.input.select();
    },

    closeModal() {
        this.elements.modal.style.display = 'none';
        this.clearScopedStyles();
    },

    clearScopedStyles() {
        document.querySelectorAll('style[data-vcp-search-scope-id]').forEach(el => el.remove());
    },

    generateUniqueId() {
        const timestampPart = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 9);
        return `vcp-search-bubble-${timestampPart}${randomPart}`;
    },

    processAndInjectScopedCss(content, scopeId) {
        let cssContent = '';
        const processedContent = content.replace(STYLE_REGEX, (match, css) => {
            cssContent += css.trim() + '\n';
            return ''; // 移除 style 标签
        });

        if (cssContent.length > 0) {
            try {
                const scopedCss = scopeCss(cssContent, scopeId);
                const styleElement = document.createElement('style');
                styleElement.setAttribute('data-vcp-search-scope-id', scopeId);
                styleElement.textContent = scopedCss;
                document.head.appendChild(styleElement);
            } catch (error) {
                console.error(`[SearchManager] Failed to scope CSS for ${scopeId}:`, error);
            }
        }
        return processedContent;
    },

    async performSearch(query) {
        if (this.state.isFetching) {
            console.log('[SearchManager] Search already in progress.');
            return;
        }
        if (!query || query.length < 2) {
            this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">请输入至少2个字符进行搜索。</p>';
            this.state.searchResults = [];
            this.renderSearchResults();
            return;
        }

        this.state.isFetching = true;
        this.state.currentQuery = query;
        this.clearScopedStyles();
        this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">正在努力搜索中...</p>';
        this.elements.paginationContainer.innerHTML = '';

        try {
            const [agents, groups] = await Promise.all([
                this.electronAPI.getAgents(),
                this.electronAPI.getAgentGroups()
            ]);

            if ((!agents || agents.error) || (!groups || groups.error)) {
                throw new Error(`Failed to fetch data. AgentError: ${agents?.error}, GroupError: ${groups?.error}`);
            }
            
            this.state.allAgents = agents.reduce((acc, agent) => { acc[agent.id] = agent; return acc; }, {});
            this.state.allGroups = groups.reduce((acc, group) => { acc[group.id] = group; return acc; }, {});

            const lowerCaseQuery = query.toLowerCase();
            let allFoundMessages = [];
            const topicsToFetch = [];

            const processItem = (item, type) => {
                if (item.topics && item.topics.length > 0) {
                    item.topics.forEach(topic => {
                        topicsToFetch.push({
                            context: {
                                itemId: item.id,
                                itemName: item.name,
                                itemType: type,
                                itemAvatar: item.avatarUrl,
                                topicId: topic.id,
                                topicName: topic.name
                            }
                        });
                    });
                }
            };

            agents.forEach(agent => processItem(agent, 'agent'));
            groups.forEach(group => processItem(group, 'group'));

            const historyReadPromises = topicsToFetch.map(info => {
                const { itemType, itemId, topicId } = info.context;
                const promise = itemType === 'agent'
                    ? this.electronAPI.getChatHistory(itemId, topicId)
                    : this.electronAPI.getGroupChatHistory(itemId, topicId);

                return promise.then(history => {
                    if (history && !history.error) {
                        return { history, context: info.context };
                    }
                    if (history && history.error) {
                         console.warn(`[SearchManager] Error fetching history for ${itemType} ${itemId}/${topicId}:`, history.error);
                    }
                    return null;
                }).catch(err => {
                    console.error(`[SearchManager] Critical error fetching history for ${itemType} ${itemId}/${topicId}:`, err);
                    return null;
                });
            });

            const results = await Promise.all(historyReadPromises);

            results.filter(r => r !== null).forEach(result => {
                result.history.forEach(message => {
                    const content = (typeof message.content === 'object' && message.content !== null && message.content.text)
                        ? message.content.text
                        : String(message.content || '');

                    // 支持多行搜索：将搜索查询和内容都标准化处理
                    const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();
                    const normalizedQuery = lowerCaseQuery.replace(/\s+/g, ' ').trim();
                    
                    // 如果查询包含换行符，进行精确的多行匹配
                    let isMatch = false;
                    if (lowerCaseQuery.includes('\n')) {
                        // 多行查询：保持原始格式进行匹配
                        isMatch = content.toLowerCase().includes(lowerCaseQuery);
                    } else {
                        // 单行查询：使用标准化匹配（忽略多余空白）
                        isMatch = normalizedContent.includes(normalizedQuery);
                    }

                    if (isMatch) {
                        allFoundMessages.push({
                            ...message,
                            context: result.context
                        });
                    }
                });
            });

            this.state.searchResults = allFoundMessages.sort((a, b) => b.timestamp - a.timestamp);
            this.state.currentPage = 1;
            this.renderSearchResults();

        } catch (error) {
            console.error('[SearchManager] Error during search:', error);
            this.elements.resultsContainer.innerHTML = `<p style="text-align: center; padding: 20px; color: var(--danger-text);">搜索时发生错误: ${error.message}</p>`;
        } finally {
            this.state.isFetching = false;
        }
    },

    renderSearchResults() {
        this.elements.resultsContainer.innerHTML = '';
        this.elements.paginationContainer.innerHTML = '';

        if (this.state.searchResults.length === 0) {
            this.elements.resultsContainer.innerHTML = '<p style="text-align: center; padding: 20px;">未找到匹配的结果。</p>';
            return;
        }

        const startIndex = (this.state.currentPage - 1) * this.state.resultsPerPage;
        const endIndex = startIndex + this.state.resultsPerPage;
        const paginatedResults = this.state.searchResults.slice(startIndex, endIndex);

        paginatedResults.forEach(message => {
            const itemEl = document.createElement('div');
            itemEl.classList.add('search-result-item');
            
            // 为每个搜索结果生成唯一作用域 ID
            const scopeId = this.generateUniqueId();
            itemEl.id = scopeId;
            
            itemEl.addEventListener('click', () => this.navigateToMessage(message));

            const contentText = (typeof message.content === 'object' && message.content !== null && message.content.text)
                ? message.content.text
                : String(message.content || '');

            // --- Scoped CSS 处理 ---
            let textToProcess = contentText;
            const codeBlocksForStyleProtection = [];
            // 保护代码块
            textToProcess = textToProcess.replace(CODE_FENCE_REGEX, (match) => {
                const placeholder = `__VCP_STYLE_PROTECT_${codeBlocksForStyleProtection.length}__`;
                codeBlocksForStyleProtection.push(match);
                return placeholder;
            });

            // 提取并注入 Scoped CSS
            const contentWithoutStyles = this.processAndInjectScopedCss(textToProcess, scopeId);
            
            // 恢复代码块
            let finalContent = contentWithoutStyles;
            codeBlocksForStyleProtection.forEach((block, i) => {
                const placeholder = `__VCP_STYLE_PROTECT_${i}__`;
                finalContent = finalContent.replace(placeholder, block);
            });
            // --- 处理结束 ---

            const contextEl = document.createElement('div');
            contextEl.classList.add('context');
            contextEl.textContent = `${message.context.itemName} > ${message.context.topicName}`;

            const contentWrapperEl = document.createElement('div');
            contentWrapperEl.classList.add('content');

            const query = this.state.currentQuery;
            
            // 🔴 修复：转义 HTML，防止在搜索预览中执行原始 HTML
            const safeContent = this.escapeHtml(finalContent);
            
            // 然后再高亮搜索词（在转义后的安全内容上）
            let highlightedContent = safeContent;
            if (query) {
                // 同时也需要转义查询词，以匹配转义后的内容
                const escapedQuery = this.escapeRegExp(this.escapeHtml(query));
                highlightedContent = safeContent.replace(
                    new RegExp(escapedQuery, 'gi'),
                    (match) => `<strong>${match}</strong>`
                );
            }

            contentWrapperEl.innerHTML = `<span class="name">${this.escapeHtml(message.name || message.role)}: </span>${highlightedContent}`;

            itemEl.appendChild(contextEl);
            itemEl.appendChild(contentWrapperEl);
            this.elements.resultsContainer.appendChild(itemEl);
        });

        this.renderPagination();
    },

    renderPagination() {
        const totalPages = Math.ceil(this.state.searchResults.length / this.state.resultsPerPage);
        if (totalPages <= 1) return;

        const prevButton = document.createElement('button');
        prevButton.textContent = '上一页';
        prevButton.classList.add('pagination-button');
        prevButton.disabled = this.state.currentPage === 1;
        prevButton.addEventListener('click', () => {
            if (this.state.currentPage > 1) {
                this.state.currentPage--;
                this.renderSearchResults();
            }
        });

        const nextButton = document.createElement('button');
        nextButton.textContent = '下一页';
        nextButton.classList.add('pagination-button');
        nextButton.disabled = this.state.currentPage === totalPages;
        nextButton.addEventListener('click', () => {
            if (this.state.currentPage < totalPages) {
                this.state.currentPage++;
                this.renderSearchResults();
            }
        });

        const pageInfo = document.createElement('span');
        pageInfo.textContent = `第 ${this.state.currentPage} / ${totalPages} 页 (共 ${this.state.searchResults.length} 条结果)`;
        pageInfo.style.margin = '0 15px';

        this.elements.paginationContainer.appendChild(prevButton);
        this.elements.paginationContainer.appendChild(pageInfo);
        this.elements.paginationContainer.appendChild(nextButton);
    },

    async navigateToMessage(message) {
        this.closeModal();

        const { itemId, itemType, topicId, itemName, itemAvatar } = message.context;
        
        const itemConfig = (itemType === 'agent') 
            ? this.state.allAgents[itemId] 
            : this.state.allGroups[itemId];
            
        if (!itemConfig) {
            console.error(`[SearchManager] Could not find config for ${itemType} with ID ${itemId}`);
            this.uiHelper.showToastNotification('无法导航：找不到对应的项目配置。', 'error');
            return;
        }

        // 核心修复：确保 selectItem 的异步操作完成后再继续
        await this.chatManager.selectItem(itemId, itemType, itemName, itemAvatar, itemConfig);
        // 核心修改：移除了 setTimeout，直接 await selectTopic，确保历史记录加载完毕
        await this.chatManager.selectTopic(topicId);

        // 核心修复：在 requestAnimationFrame 之后给浏览器一个渲染的喘息时间
        await new Promise(resolve => setTimeout(resolve, 100));

        const messageEl = document.querySelector(`.message-item[data-message-id='${message.id}']`);
        if (messageEl) {
            messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            messageEl.classList.add('message-highlight');
            setTimeout(() => {
                messageEl.classList.remove('message-highlight');
            }, 2500); // 保留高亮效果的延时
        } else {
            console.warn(`[SearchManager] Could not find message element with ID: ${message.id} after loading history.`);
            this.uiHelper.showToastNotification('成功定位到话题，但无法高亮显示具体消息。', 'info');
        }
    },

    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },

    /**
     * 转义HTML特殊字符，防止HTML注入
     * @param {string} text 要转义的文本
     * @returns {string} 转义后的文本
     */
    escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};

export default searchManager;