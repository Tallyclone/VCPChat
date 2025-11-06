// modules/forum.js

// ========== Global State ==========
let apiAuthHeader = null;
let forumConfig = {
    username: '',
    password: '',
    replyUsername: '', // New: for default reply name
    rememberCredentials: false
};
let allPosts = [];
let serverBaseUrl = '';
let resizeTimeout = null;
let avatarCache = {}; // Cache for loaded avatars
let agentsList = []; // List of all agents with their names
let emoticonLibrary = []; // Emoticon library for URL fixing

// ========== DOM Elements ==========
const loginView = document.getElementById('login-view');
const forumView = document.getElementById('forum-view');
const masonryContainer = document.getElementById('masonry-container');
const activePostOverlay = document.getElementById('active-post-overlay');

// Inputs & Controls
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-button');
const loginError = document.getElementById('login-error');
const rememberMeCheckbox = document.getElementById('remember-me');
const searchInput = document.getElementById('search-posts');
const boardFilter = document.getElementById('board-filter');
const refreshBtn = document.getElementById('refresh-posts');

// Modals
const createPostModal = document.getElementById('create-post-modal');
const createPostBtn = document.getElementById('create-post-btn');
const submitPostBtn = document.getElementById('submit-post-btn');

// Settings Modal
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingsUsernameInput = document.getElementById('settings-username');
const settingsPasswordInput = document.getElementById('settings-password');
const settingsReplyNameInput = document.getElementById('settings-reply-name');
const settingsRememberMe = document.getElementById('settings-remember-me');
const settingsError = document.getElementById('settings-error');


// ========== Window Controls ==========
document.getElementById('minimize-forum-btn')?.addEventListener('click', () => window.electronAPI?.minimizeWindow());
document.getElementById('maximize-forum-btn')?.addEventListener('click', () => window.electronAPI?.maximizeWindow());
document.getElementById('close-forum-btn')?.addEventListener('click', () => window.close());

// ========== Initialization & Config ==========
// ========== Theme Management ==========
function applyTheme(theme) {
    document.body.classList.toggle('light-theme', theme === 'light');
}

document.addEventListener('DOMContentLoaded', async () => {
    window.addEventListener('resize', handleResize);

    await loadForumConfig();
    await loadAgentsList(); // Load agents list for avatar matching
    await loadEmoticonLibrary(); // Load emoticon library for URL fixing
    try {
        const settings = await window.electronAPI?.loadSettings();
        if (settings?.currentThemeMode) applyTheme(settings.currentThemeMode);
        window.electronAPI?.onThemeUpdated(applyTheme); // Listen for live theme changes
    } catch (e) { /* ignore */ }
});

function handleResize() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(applyFilters, 200);
}

async function loadForumConfig() {
    try {
        const config = await window.electronAPI?.loadForumConfig();
        if (config && !config.error) {
            forumConfig = { ...forumConfig, ...config };
            if (forumConfig.username) usernameInput.value = forumConfig.username;
            if (forumConfig.password) passwordInput.value = forumConfig.password;
            if (forumConfig.rememberCredentials) rememberMeCheckbox.checked = true;
            if (forumConfig.rememberCredentials && forumConfig.username && forumConfig.password) {
                handleLogin();
            } else {
                switchView('login');
            }
        } else {
            switchView('login');
        }
    } catch (error) {
        console.error('Config load error:', error);
        switchView('login');
    }
}

function switchView(viewName) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    if (viewName === 'login') loginView.classList.add('active');
    if (viewName === 'forum') {
        forumView.classList.add('active');
        // Recalculate masonry when view becomes visible as width might have changed
        // The grid layout adjusts automatically, just need to ensure posts are rendered.
        setTimeout(applyFilters, 50);
    }
}

// ========== API & Auth ==========
async function getServerUrl() {
    try {
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpServerUrl) throw new Error('VCP Server URL not configured');
        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';
        return serverBaseUrl;
    } catch (error) {
        throw error;
    }
}

async function apiFetch(endpoint, options = {}) {
    if (!apiAuthHeader) throw new Error('Not logged in');
    if (!serverBaseUrl) await getServerUrl();

    const response = await fetch(`${serverBaseUrl}admin_api/forum${endpoint}`, {
        ...options,
        headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        if (response.status === 401) throw new Error('Authentication failed');
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `API Error: ${response.status}`);
    }
    return response.json();
}

async function handleLogin() {
    const user = usernameInput.value.trim();
    const pass = passwordInput.value.trim();
    if (!user || !pass) return showError(loginError, 'Please enter username and password');

    loginButton.textContent = 'Verifying...';
    loginButton.disabled = true;
    loginError.textContent = '';

    try {
        await getServerUrl();
        apiAuthHeader = `Basic ${btoa(`${user}:${pass}`)}`;
        await apiFetch('/posts'); // Test auth

        // Save config by updating the existing config object, preserving all fields
        forumConfig.username = user;
        forumConfig.password = pass;
        forumConfig.rememberCredentials = rememberMeCheckbox.checked;
        window.electronAPI?.saveForumConfig(forumConfig);

        switchView('forum');
        loadPosts();
    } catch (error) {
        apiAuthHeader = null;
        showError(loginError, error.message);
    } finally {
        loginButton.textContent = 'Enter Forum';
        loginButton.disabled = false;
    }
}

loginButton.addEventListener('click', handleLogin);
passwordInput.addEventListener('keydown', e => e.key === 'Enter' && handleLogin());

function showError(element, message) {
    element.textContent = message;
    element.style.animation = 'none';
    element.offsetHeight; /* trigger reflow */
    element.style.animation = null;
}

// ========== Avatar Loading Functions ==========
async function loadAgentsList() {
    try {
        const agentsData = await window.electronAPI?.loadAgentsList();
        if (agentsData && Array.isArray(agentsData)) {
            agentsList = agentsData;
            console.log('[Forum] Loaded', agentsList.length, 'agents for avatar matching');
        }
    } catch (error) {
        console.error('[Forum] Failed to load agents list:', error);
    }
}

// ========== Emoticon URL Fixer ==========
async function loadEmoticonLibrary() {
    try {
        const library = await window.electronAPI?.getEmoticonLibrary();
        if (library && Array.isArray(library)) {
            emoticonLibrary = library;
            console.log('[Forum] Loaded', emoticonLibrary.length, 'emoticons for URL fixing');
        }
    } catch (error) {
        console.error('[Forum] Failed to load emoticon library:', error);
    }
}

function getSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function extractEmoticonInfo(url) {
    let filename = null;
    let packageName = null;
    if (!url) return { filename, packageName };

    try {
        const decodedPath = decodeURIComponent(new URL(url).pathname);
        const parts = decodedPath.split('/').filter(Boolean);
        if (parts.length > 0) filename = parts[parts.length - 1];
        if (parts.length > 1) packageName = parts[parts.length - 2];
    } catch (e) {
        try {
            const decodedUrl = decodeURIComponent(url);
            const parts = decodedUrl.split('/').filter(Boolean);
            if (parts.length > 0) filename = parts[parts.length - 1];
            if (parts.length > 1) packageName = parts[parts.length - 2];
        } catch (e2) {
            const parts = url.split('/').filter(Boolean);
            if (parts.length > 0) filename = parts[parts.length - 1];
            if (parts.length > 1) packageName = parts[parts.length - 2];
        }
    }
    return { filename, packageName };
}

function fixEmoticonUrl(originalSrc) {
    if (emoticonLibrary.length === 0) return originalSrc;

    // Quick check: if URL is already perfect
    try {
        const decodedOriginalSrc = decodeURIComponent(originalSrc);
        if (emoticonLibrary.some(item => decodeURIComponent(item.url) === decodedOriginalSrc)) {
            return originalSrc;
        }
    } catch (e) { /* ignore */ }

    // Check if it's likely an emoticon URL
    try {
        if (!decodeURIComponent(originalSrc).includes('表情包')) {
            return originalSrc;
        }
    } catch (e) {
        return originalSrc;
    }

    // Extract info and find best match
    const searchInfo = extractEmoticonInfo(originalSrc);
    if (!searchInfo.filename) return originalSrc;

    let bestMatch = null;
    let highestScore = -1;

    for (const item of emoticonLibrary) {
        const itemPackageInfo = extractEmoticonInfo(item.url);
        
        let packageScore = 0.5;
        if (searchInfo.packageName && itemPackageInfo.packageName) {
            packageScore = getSimilarity(searchInfo.packageName, itemPackageInfo.packageName);
        } else if (!searchInfo.packageName && !itemPackageInfo.packageName) {
            packageScore = 1.0;
        } else {
            packageScore = 0.0;
        }

        const filenameScore = getSimilarity(searchInfo.filename, item.filename);
        const score = (0.7 * packageScore) + (0.3 * filenameScore);

        if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
        }
    }

    if (bestMatch && highestScore > 0.6) {
        console.log('[Forum] Fixed emoticon URL:', originalSrc, '->', bestMatch.url);
        return bestMatch.url;
    }

    return originalSrc;
}

// Setup image error handling for emoticon fixing
function setupEmoticonFixer(container) {
    const images = container.querySelectorAll('img');
    images.forEach(img => {
        // First, clean up any malformed URLs (e.g., extra backslashes from AI output)
        if (img.src) {
            // Remove escaped quotes and backslashes that might appear in URLs
            let cleanedSrc = img.src.replace(/\\"/g, '"').replace(/\\\\/g, '/').replace(/\\/g, '');
            
            // If the URL was cleaned, update it immediately
            if (cleanedSrc !== img.src) {
                console.log('[Forum] Cleaned malformed URL:', img.src, '->', cleanedSrc);
                img.src = cleanedSrc;
            }
        }
        
        // Then set up error handling for emoticon fixing
        img.addEventListener('error', function() {
            const originalSrc = this.src;
            if (originalSrc && originalSrc.includes('表情包')) {
                const fixedSrc = fixEmoticonUrl(originalSrc);
                if (fixedSrc !== originalSrc) {
                    console.log('[Forum] Attempting to fix broken emoticon:', originalSrc);
                    this.src = fixedSrc;
                }
            }
        }, { once: true }); // Only try once per image
    });
}
async function getAvatarForUser(username) {
    if (!username) return null;
    
    // Check cache first
    if (avatarCache.hasOwnProperty(username)) {
        return avatarCache[username];
    }

    try {
        // Check if it's the current user (check both replyUsername and username)
        const isCurrentUser = (forumConfig.replyUsername && username === forumConfig.replyUsername) ||
                             (forumConfig.username && username === forumConfig.username);
        
        if (isCurrentUser) {
            const userAvatar = await window.electronAPI?.loadUserAvatar();
            if (userAvatar) {
                avatarCache[username] = userAvatar;
                return userAvatar;
            }
        }

        // Check if it matches any agent (case-insensitive partial matching)
        for (const agent of agentsList) {
            const agentNameLower = agent.name.toLowerCase();
            const usernameLower = username.toLowerCase();
            
            if (agentNameLower.includes(usernameLower) || usernameLower.includes(agentNameLower)) {
                const agentAvatar = await window.electronAPI?.loadAgentAvatar(agent.folder);
                if (agentAvatar) {
                    avatarCache[username] = agentAvatar;
                    return agentAvatar;
                }
            }
        }

        // No avatar found, cache null to avoid repeated lookups
        avatarCache[username] = null;
        return null;
    } catch (error) {
        console.error('[Forum] Error loading avatar for', username, error);
        return null;
    }
}

// ========== Settings Modal Logic ==========
function openSettingsModal() {
    settingsUsernameInput.value = forumConfig.username || '';
    settingsPasswordInput.value = forumConfig.password || '';
    settingsReplyNameInput.value = forumConfig.replyUsername || '';
    settingsRememberMe.checked = forumConfig.rememberCredentials || false;
    settingsError.textContent = '';
    settingsModal.style.display = 'flex';
}

async function saveSettings() {
    const newConfig = {
        username: settingsUsernameInput.value.trim(),
        password: settingsPasswordInput.value, // Don't trim password
        replyUsername: settingsReplyNameInput.value.trim(),
        rememberCredentials: settingsRememberMe.checked
    };

    if (!newConfig.username) {
        return showError(settingsError, '登录用户名不能为空');
    }

    // If not remembering, clear password from saved config
    if (!newConfig.rememberCredentials) {
        newConfig.password = '';
    }
    
    saveSettingsBtn.textContent = '保存中...';
    saveSettingsBtn.disabled = true;
    try {
        await window.electronAPI?.saveForumConfig(newConfig);
        forumConfig = newConfig;
        // Update login form fields as well, in case user logs out
        usernameInput.value = forumConfig.username;
        passwordInput.value = forumConfig.password;
        rememberMeCheckbox.checked = forumConfig.rememberCredentials;
        settingsModal.style.display = 'none';
    } catch (error) {
        showError(settingsError, '保存失败: ' + error.message);
    } finally {
        saveSettingsBtn.textContent = '💾 保存';
        saveSettingsBtn.disabled = false;
    }
}

settingsBtn.addEventListener('click', openSettingsModal);
saveSettingsBtn.addEventListener('click', saveSettings);
settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal || e.target.classList.contains('modal-close-btn')) {
        settingsModal.style.display = 'none';
    }
});


// ========== Masonry Posts Logic ==========
async function loadPosts() {
    refreshBtn.style.animation = 'spin 1s infinite linear';
    try {
        const data = await apiFetch('/posts');
        allPosts = data.posts || [];
        updateBoardFilter(allPosts);
        renderWaterfall(allPosts);
    } catch (error) {
        console.error('Load posts failed:', error);
    } finally {
        refreshBtn.style.animation = '';
    }
}

function updateBoardFilter(posts) {
    const currentVal = boardFilter.value;
    const boards = [...new Set(posts.map(p => p.board).filter(Boolean))].sort();
    boardFilter.innerHTML = '<option value="all">✨ 全部板块</option>';
    boards.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = `📂 ${b}`;
        boardFilter.appendChild(opt);
    });
    boardFilter.value = currentVal;
    if (boardFilter.value === '') boardFilter.value = 'all';
}

function renderWaterfall(postsToRender) {
    masonryContainer.innerHTML = ''; // Clear the grid

    if (!postsToRender || postsToRender.length === 0) return;

    const sorted = [...postsToRender].sort((a, b) => {
        if (a.title.includes('[置顶]') && !b.title.includes('[置顶]')) return -1;
        if (!a.title.includes('[置顶]') && b.title.includes('[置顶]')) return 1;
        return new Date(b.lastReplyAt || b.timestamp) - new Date(a.lastReplyAt || a.timestamp);
    });

    sorted.forEach((post, index) => {
        const card = createPostCard(post, index);
        masonryContainer.appendChild(card); // Append directly to the grid container
    });
}

function createPostCard(post, index) {
    const el = document.createElement('div');
    el.className = 'post-card glass glass-hover';
    // Limit staggered animation to first 20 items to avoid massive delays on large lists
    const delay = index < 20 ? index * 0.05 : 0;
    el.style.animationDelay = `${delay}s`;
    
    const hue = post.author.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
    const avatarColor = `hsl(${hue}, 70%, 60%)`;

    el.innerHTML = `
        <div class="post-card-header">
            <h3 class="post-title">${escapeHtml(post.title)}</h3>
            ${post.board ? `<span class="post-badge">${escapeHtml(post.board)}</span>` : ''}
        </div>
        <div class="post-preview" style="font-style: italic; opacity: 0.6;">
            点击展开查看详情...
        </div>
        <div class="post-meta">
            <div class="meta-left">
                <div class="author-avatar loading-avatar" style="background: ${avatarColor}" data-author="${escapeHtml(post.author)}">${post.author.slice(0,1).toUpperCase()}</div>
                <span>${escapeHtml(post.author)}</span>
            </div>
            <span>${formatDate(post.lastReplyAt || post.timestamp)}</span>
        </div>
    `;

    el.addEventListener('click', (e) => expandPost(post, el));
    
    // Async load avatar
    loadAvatarForElement(el.querySelector('.author-avatar'), post.author);
    
    return el;
}

async function loadAvatarForElement(avatarEl, username) {
    if (!avatarEl) return;
    
    const avatarPath = await getAvatarForUser(username);
    if (avatarPath) {
        avatarEl.style.backgroundImage = `url("${avatarPath}")`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.style.backgroundPosition = 'center';
        avatarEl.textContent = ''; // Remove initial letter
        avatarEl.classList.remove('loading-avatar');
        avatarEl.classList.add('has-avatar');
    }
}

// ========== Jelly Expansion ==========
async function expandPost(post, originalCard) {
    document.body.style.overflow = 'hidden';
    activePostOverlay.classList.add('active');
    activePostOverlay.scrollTop = 0; // Reset scroll position

    const rect = originalCard.getBoundingClientRect();
    const expanded = originalCard.cloneNode(true);
    expanded.className = 'post-card glass expanded-card';
    expanded.style.position = 'fixed';
    expanded.style.top = `${rect.top}px`;
    expanded.style.left = `${rect.left}px`;
    expanded.style.width = `${rect.width}px`;
    expanded.style.height = `${rect.height}px`;
    expanded.style.margin = '0';
    expanded.style.zIndex = '2001';
    expanded.style.transition = 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';

    activePostOverlay.innerHTML = '';
    activePostOverlay.appendChild(expanded);

    expanded.offsetHeight; // Force reflow
    
    // Animate to center with auto height
    expanded.style.position = 'relative';
    expanded.style.top = 'auto';
    expanded.style.left = 'auto';
    expanded.style.width = '90%';
    expanded.style.maxWidth = '1000px';
    expanded.style.height = 'auto';
    expanded.style.margin = '0 auto';
    expanded.style.borderRadius = '30px';
    expanded.style.cursor = 'default';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'expanded-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = closeExpandedPost;
    expanded.appendChild(closeBtn);

    try {
        const previewEl = expanded.querySelector('.post-preview');
        previewEl.innerHTML = '<div style="text-align:center; padding: 20px;">Loading content...</div>';
        previewEl.style.maskImage = 'none';
        previewEl.style.maxHeight = 'none';

        const data = await apiFetch(`/post/${post.uid}`);
        renderFullContent(expanded, data.content, post.uid);
    } catch (error) {
        expanded.querySelector('.post-preview').innerHTML = `<div style="color: var(--danger-color)">Failed to load: ${error.message}</div>`;
    }
}

function closeExpandedPost() {
    const expanded = activePostOverlay.querySelector('.expanded-card');
    if (expanded) {
        activePostOverlay.classList.remove('active');
        expanded.style.opacity = '0';
        expanded.style.transform = 'scale(0.9)';
    }
    setTimeout(() => {
        activePostOverlay.innerHTML = '';
        document.body.style.overflow = '';
    }, 300);
}

activePostOverlay.addEventListener('click', (e) => {
    if (e.target === activePostOverlay) closeExpandedPost();
});

function renderFullContent(container, markdown, uid) {
    const previewEl = container.querySelector('.post-preview');
    const replyDelimiter = '\n\n---\n\n## 评论区\n---';
    const parts = markdown.split(replyDelimiter);
    const mainMd = parts[0];
    const repliesMd = parts[1] || '';

    previewEl.innerHTML = window.marked ? marked.parse(mainMd) : `<pre>${escapeHtml(mainMd)}</pre>`;
    
    // Setup emoticon fixer for main content
    setupEmoticonFixer(previewEl);

    // Add delete post button after main content
    const deletePostBtn = document.createElement('button');
    deletePostBtn.className = 'jelly-btn';
    deletePostBtn.style.cssText = 'width: auto; padding: 10px 25px; background: var(--danger-color); margin-top: 20px;';
    deletePostBtn.innerHTML = '🗑️ 删除整个帖子';
    deletePostBtn.addEventListener('click', () => handleDeletePost(uid));
    previewEl.appendChild(deletePostBtn);

    if (repliesMd.trim()) {
        const replyList = document.createElement('div');
        replyList.className = 'reply-list';
        replyList.innerHTML = '<h3>💬 评论</h3>';
        repliesMd.split('\n\n---\n').forEach((replyMd, i) => {
            if (!replyMd.trim()) return;
            const floor = i + 1;
            
            // Extract username from reply markdown
            // Format: "**回复者:** 小吉" (bold text followed by username)
            let replyUsername = '';
            
            // Try to match "**回复者:** username" format
            const replyerMatch = replyMd.match(/\*\*回复者[：:]\*\*\s*([^\s\n*]+)/);
            if (replyerMatch) {
                replyUsername = replyerMatch[1];
            } else {
                // Fallback: try to match any bold text that might be a username
                const boldMatch = replyMd.match(/\*\*([^*]+)\*\*/);
                if (boldMatch && !boldMatch[1].includes('回复者') && !boldMatch[1].includes('时间')) {
                    replyUsername = boldMatch[1];
                }
            }
            
            const hue = replyUsername.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
            const avatarColor = `hsl(${hue}, 70%, 60%)`;
            
            const replyItem = document.createElement('div');
            replyItem.className = 'reply-item glass';
            replyItem.style.animationDelay = `${i * 0.1}s`;
            replyItem.innerHTML = `
                <div class="reply-header">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="reply-avatar loading-avatar" style="background: ${avatarColor}" data-author="${escapeHtml(replyUsername)}">${replyUsername ? replyUsername.slice(0,1).toUpperCase() : '#'}</div>
                        <span>#${floor}</span>
                    </div>
                    <button class="delete-floor-btn" data-uid="${uid}" data-floor="${floor}">删除此楼层</button>
                </div>
                <div class="reply-content">${window.marked ? marked.parse(replyMd.trim()) : `<pre>${escapeHtml(replyMd.trim())}</pre>`}</div>
            `;
            replyList.appendChild(replyItem);
            
            // Load avatar for reply
            if (replyUsername) {
                const avatarEl = replyItem.querySelector('.reply-avatar');
                loadAvatarForElement(avatarEl, replyUsername);
            }
            
            // Setup emoticon fixer for reply content
            const replyContent = replyItem.querySelector('.reply-content');
            if (replyContent) {
                setupEmoticonFixer(replyContent);
            }
            
            // Add event listener for delete floor button
            const deleteBtn = replyItem.querySelector('.delete-floor-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteFloor(uid, floor, container);
            });
        });
        container.appendChild(replyList);
    }

    const replyBox = document.createElement('div');
    replyBox.className = 'reply-area-fixed';
    replyBox.innerHTML = `
        <input type="text" id="quick-reply-name" class="glass-input" placeholder="昵称" style="width: 120px; margin-bottom:0;">
        <input type="text" id="quick-reply-text" class="glass-input reply-input" placeholder="写下你的评论..." style="margin-bottom:0;">
        <button id="quick-reply-btn" class="jelly-btn" style="width: auto; padding: 0 25px;">发送</button>
    `;
    container.appendChild(replyBox);
    const nameInput = container.querySelector('#quick-reply-name');
    nameInput.value = forumConfig.replyUsername || forumConfig.username || '';
    if (!nameInput.value) nameInput.placeholder = "请先在设置中指定署名";
    
    container.querySelector('#quick-reply-btn').addEventListener('click', () => handleQuickReply(uid, container));
}

async function handleDeletePost(uid) {
    const confirmed = await customConfirm('您确定要删除整个帖子吗？此操作无法撤销！', '⚠️ 删除帖子');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/post/${uid}`, {
            method: 'DELETE',
            body: JSON.stringify({})
        });
        closeExpandedPost();
        loadPosts(); // Refresh the post list
        await customAlert('帖子已成功删除', '✅ 删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '❌ 删除失败');
    }
}

async function handleDeleteFloor(uid, floor, container) {
    const confirmed = await customConfirm(`您确定要删除第 ${floor} 楼吗？此操作无法撤销！`, '⚠️ 删除楼层');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/post/${uid}`, {
            method: 'DELETE',
            body: JSON.stringify({ floor })
        });
        // Reload the post content
        const data = await apiFetch(`/post/${uid}`);
        container.querySelectorAll('.reply-list, .reply-area-fixed').forEach(e => e.remove());
        renderFullContent(container, data.content, uid);
        await customAlert('楼层已成功删除', '✅ 删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '❌ 删除失败');
    }
}

async function handleQuickReply(uid, container) {
    const nameInput = container.querySelector('#quick-reply-name');
    const textInput = container.querySelector('#quick-reply-text');
    const btn = container.querySelector('#quick-reply-btn');

    if (!nameInput.value.trim() || !textInput.value.trim()) {
        textInput.placeholder = '昵称和内容都不能为空！';
        return;
    }
    btn.disabled = true;
    btn.textContent = '...';
    try {
        await apiFetch(`/reply/${uid}`, {
            method: 'POST',
            body: JSON.stringify({ maid: nameInput.value.trim(), content: textInput.value.trim() })
        });
        const data = await apiFetch(`/post/${uid}`);
        container.querySelectorAll('.reply-list, .reply-area-fixed').forEach(e => e.remove());
        renderFullContent(container, data.content, uid);
    } catch (error) {
        alert('Reply failed: ' + error.message);
        btn.disabled = false;
        btn.textContent = '发送';
    }
}

function applyFilters() {
    const term = searchInput.value.toLowerCase().trim();
    const board = boardFilter.value;
    const filtered = allPosts.filter(p => {
        const matchSearch = !term || p.title.toLowerCase().includes(term) || p.author.toLowerCase().includes(term);
        const matchBoard = board === 'all' || p.board === board;
        return matchSearch && matchBoard;
    });
    renderWaterfall(filtered);
}

searchInput.addEventListener('input', applyFilters);
boardFilter.addEventListener('change', applyFilters);
refreshBtn.addEventListener('click', loadPosts);

createPostBtn.addEventListener('click', () => createPostModal.style.display = 'flex');
document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.target.closest('.modal').style.display = 'none';
    });
});
createPostModal.addEventListener('click', e => { if (e.target === createPostModal) createPostModal.style.display = 'none'; });

submitPostBtn.addEventListener('click', async () => {
    const title = document.getElementById('post-title-input').value.trim();
    const board = document.getElementById('post-board-input').value.trim();
    const author = document.getElementById('post-author-input').value.trim();
    const content = document.getElementById('post-content-input').value.trim();
    const errEl = document.getElementById('create-post-error');

    if (!title || !board || !author || !content) return showError(errEl, '请填写所有字段');
    submitPostBtn.disabled = true;
    submitPostBtn.textContent = '发布中...';
    try {
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key missing');
        const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPForum「末」,
command:「始」CreatePost「末」,
maid:「始」${author}「末」,
board:「始」${board}「末」,
title:「始」${title}「末」,
content:「始」${content}「末」
<<<[END_TOOL_REQUEST]>>>`;
        const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': `Bearer ${settings.vcpApiKey}` },
            body: toolRequest
        });
        if (!res.ok) throw new Error(await res.text());
        createPostModal.style.display = 'none';
        loadPosts();
        ['post-title-input', 'post-board-input', 'post-content-input'].forEach(id => document.getElementById(id).value = '');
    } catch (error) {
        showError(errEl, error.message || '发布失败');
    } finally {
        submitPostBtn.disabled = false;
        submitPostBtn.textContent = '🚀 发布';
    }
});

function escapeHtml(str) {
    return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ========== Custom Dialog Functions ==========
function customConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleCancel();
        };

        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleModalClick);
    });
}

function customAlert(message, title = '提示') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-alert-modal');
        const titleEl = document.getElementById('alert-title');
        const messageEl = document.getElementById('alert-message');
        const okBtn = document.getElementById('alert-ok-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve();
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleOk();
        };

        okBtn.addEventListener('click', handleOk);
        modal.addEventListener('click', handleModalClick);
    });
}

function formatDate(ts) {
    if (!ts) return '';
    try {
        // Handle various date formats
        let d;
        if (typeof ts === 'string') {
            // Try parsing ISO format first
            d = new Date(ts);
            // If invalid, try replacing hyphens with slashes for better compatibility
            if (isNaN(d.getTime())) {
                d = new Date(ts.replace(/-/g, '/'));
            }
        } else {
            d = new Date(ts);
        }
        
        // Check if date is valid
        if (isNaN(d.getTime())) {
            console.warn('Invalid date:', ts);
            return String(ts);
        }
        
        const now = new Date();
        const diff = (now - d) / 1000;
        
        if (diff < 60) return '刚刚';
        if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
        if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
        
        // Format as date with time
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const hours = d.getHours().toString().padStart(2, '0');
        const minutes = d.getMinutes().toString().padStart(2, '0');
        return `${month}月${day}日 ${hours}:${minutes}`;
    } catch (e) {
        console.error('Date formatting error:', e, ts);
        return String(ts);
    }
}