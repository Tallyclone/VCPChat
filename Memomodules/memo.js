/**
 * Memomodules/memo.js
 * VCP Agent 记忆管理中心逻辑
 */

// ========== 全局状态 ==========
let apiAuthHeader = null;
let serverBaseUrl = '';
let forumConfig = null;
let currentFolder = '';
let allMemos = [];
let currentMemo = null; // 当前正在编辑的日记 { folder, file, content }
let searchScope = 'folder'; // 'folder' or 'global'
let isBatchMode = false;
let selectedMemos = new Set(); // Set of memo names

// ========== DOM 元素 ==========
const folderListEl = document.getElementById('folder-list');
const memoGridEl = document.getElementById('memo-grid');
const currentFolderNameEl = document.getElementById('current-folder-name');
const searchInput = document.getElementById('search-memos');

// 编辑器相关
const editorOverlay = document.getElementById('editor-overlay');
const editorTitleInput = document.getElementById('editor-title');
const editorTextarea = document.getElementById('editor-textarea');
const editorPreview = document.getElementById('editor-preview');
const editorStatus = document.getElementById('editor-status');

// 弹窗相关
const createModal = document.getElementById('create-modal');
const newMemoDateInput = document.getElementById('new-memo-date');
const newMemoMaidInput = document.getElementById('new-memo-maid');
const newMemoContentInput = document.getElementById('new-memo-content');

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    // 窗口控制
    document.getElementById('minimize-memo-btn').onclick = () => window.electronAPI.minimizeWindow();
    document.getElementById('maximize-memo-btn').onclick = () => window.electronAPI.maximizeWindow();
    document.getElementById('close-memo-btn').onclick = () => window.electronAPI.closeWindow();

    // 初始主题
    if (window.electronAPI && window.electronAPI.getCurrentTheme) {
        const theme = await window.electronAPI.getCurrentTheme();
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    // 监听主题更新
    window.electronAPI?.onThemeUpdated((theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
    });

    // 加载配置并初始化数据
    await initApp();

    // 绑定事件
    setupEventListeners();
});

async function initApp() {
    try {
        // 1. 获取服务器地址
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpServerUrl) {
            alert('请先在主设置中配置 VCP 服务器 URL');
            return;
        }
        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

        // 2. 读取论坛配置获取 Auth
        forumConfig = await window.electronAPI.loadForumConfig();
        if (forumConfig && forumConfig.username && forumConfig.password) {
            apiAuthHeader = `Basic ${btoa(`${forumConfig.username}:${forumConfig.password}`)}`;
        } else {
            alert('未找到论坛模块的登录配置，请先在论坛模块登录。');
            return;
        }

        // 3. 加载文件夹列表
        await loadFolders();

    } catch (error) {
        console.error('初始化失败:', error);
    }
}

function setupEventListeners() {
    // 刷新文件夹
    const refreshBtn = document.getElementById('refresh-folders-btn');
    refreshBtn.onclick = async () => {
        refreshBtn.classList.add('spinning');
        try {
            await loadFolders();
            if (currentFolder) await loadMemos(currentFolder);
            // 确保动画至少持续一秒，增加交互感
            await new Promise(resolve => setTimeout(resolve, 800));
        } finally {
            refreshBtn.classList.remove('spinning');
        }
    };

    // 搜索范围切换
    const searchScopeBtn = document.getElementById('search-scope-btn');
    searchScopeBtn.onclick = () => {
        searchScope = searchScope === 'folder' ? 'global' : 'folder';
        
        // 更新按钮 UI
        searchScopeBtn.classList.toggle('active', searchScope === 'global');
        searchScopeBtn.title = searchScope === 'folder' ? '当前范围：文件夹内' : '当前范围：全局搜索';
        
        // 切换图标
        if (searchScope === 'global') {
            searchScopeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
        } else {
            searchScopeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
        }
        
        // 如果搜索框有内容，立即重新搜索
        const term = searchInput.value.trim();
        if (term) searchMemos(term);
    };

    // 搜索
    searchInput.oninput = debounce(() => {
        const term = searchInput.value.trim();
        if (term) {
            searchMemos(term);
        } else if (currentFolder) {
            loadMemos(currentFolder);
        }
    }, 500);

    // 批量管理
    const batchEditBtn = document.getElementById('batch-edit-btn');
    const batchActions = document.getElementById('batch-actions');
    const cancelBatchBtn = document.getElementById('cancel-batch-btn');

    batchEditBtn.onclick = () => {
        isBatchMode = true;
        batchEditBtn.style.display = 'none';
        batchActions.style.display = 'flex';
        selectedMemos.clear();
        updateBatchUI();
        renderMemos(allMemos); // 重新渲染以显示选择状态
    };

    cancelBatchBtn.onclick = () => {
        isBatchMode = false;
        batchEditBtn.style.display = 'flex';
        batchActions.style.display = 'none';
        selectedMemos.clear();
        renderMemos(allMemos);
    };

    document.getElementById('batch-delete-btn').onclick = handleBatchDelete;
    document.getElementById('batch-move-select').onchange = handleBatchMove;

    // 新建日记弹窗
    document.getElementById('create-memo-btn').onclick = () => {
        const now = new Date();
        newMemoDateInput.value = now.toISOString().split('T')[0];
        newMemoMaidInput.value = forumConfig.replyUsername || forumConfig.username || '';
        createModal.style.display = 'flex';
    };

    document.getElementById('close-create-modal-btn').onclick = () => {
        createModal.style.display = 'none';
    };

    document.getElementById('submit-new-memo-btn').onclick = handleCreateMemo;

    // 编辑器控制
    document.getElementById('close-editor-btn').onclick = () => {
        editorOverlay.classList.remove('active');
    };

    editorTextarea.oninput = () => {
        renderPreview(editorTextarea.value);
    };

    document.getElementById('save-memo-btn').onclick = handleSaveMemo;
    document.getElementById('delete-memo-btn').onclick = handleDeleteMemo;

    // 全局 Esc 键监听
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // 优先级：确认弹窗 > 编辑器 > 新建弹窗
            const confirmModal = document.getElementById('custom-confirm-modal');
            const alertModal = document.getElementById('custom-alert-modal');
            
            if (confirmModal && confirmModal.style.display === 'flex') {
                document.getElementById('confirm-cancel-btn').click();
            } else if (alertModal && alertModal.style.display === 'flex') {
                document.getElementById('alert-ok-btn').click();
            } else if (editorOverlay.classList.contains('active')) {
                document.getElementById('close-editor-btn').click();
            } else if (createModal.style.display === 'flex') {
                document.getElementById('close-create-modal-btn').click();
            } else if (isBatchMode) {
                document.getElementById('cancel-batch-btn').click();
            }
        }
    });
}

// ========== API 调用 ==========
async function apiFetch(endpoint, options = {}) {
    if (!apiAuthHeader) throw new Error('未认证');
    
    const response = await fetch(`${serverBaseUrl}admin_api/dailynotes${endpoint}`, {
        ...options,
        headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `API 错误: ${response.status}`);
    }
    return response.json();
}

// ========== 业务逻辑 ==========

async function loadFolders() {
    try {
        const data = await apiFetch('/folders');
        renderFolders(data.folders);
        if (data.folders.length > 0 && !currentFolder) {
            selectFolder(data.folders[0]);
        }
    } catch (error) {
        console.error('加载文件夹失败:', error);
    }
}

function renderFolders(folders) {
    folderListEl.innerHTML = '';
    const moveSelect = document.getElementById('batch-move-select');
    moveSelect.innerHTML = '<option value="">-- 移动到文件夹 --</option>';

    folders.forEach(folder => {
        // 屏蔽 MusicDiary 文件夹
        if (folder === 'MusicDiary') return;

        // 侧边栏列表
        const item = document.createElement('div');
        item.className = `folder-item ${folder === currentFolder ? 'active' : ''}`;
        item.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>${folder}</span>
        `;
        item.onclick = () => selectFolder(folder);
        folderListEl.appendChild(item);

        // 批量移动下拉框
        if (folder !== currentFolder) {
            const opt = document.createElement('option');
            opt.value = folder;
            opt.textContent = folder;
            moveSelect.appendChild(opt);
        }
    });
}

async function selectFolder(folderName) {
    currentFolder = folderName;
    currentFolderNameEl.textContent = folderName;
    
    // 更新 UI 选中状态
    document.querySelectorAll('.folder-item').forEach(el => {
        el.classList.toggle('active', el.querySelector('span').textContent === folderName);
    });

    await loadMemos(folderName);
}

async function loadMemos(folderName) {
    try {
        memoGridEl.innerHTML = '<div style="padding: 20px;">加载中...</div>';
        const data = await apiFetch(`/folder/${encodeURIComponent(folderName)}`);
        allMemos = data.notes;
        renderMemos(data.notes);
    } catch (error) {
        memoGridEl.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">加载失败: ${error.message}</div>`;
    }
}

function renderMemos(memos) {
    memoGridEl.innerHTML = '';
    if (memos.length === 0) {
        memoGridEl.innerHTML = '<div style="padding: 20px; color: var(--text-secondary);">该文件夹下暂无日记</div>';
        return;
    }

    memos.forEach(memo => {
        const card = document.createElement('div');
        const isSelected = selectedMemos.has(memo.name);
        card.className = `memo-card glass glass-hover ${isBatchMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''}`;
        
        const dateStr = new Date(memo.lastModified).toLocaleString();
        
        card.innerHTML = `
            <div>
                <h3>${memo.name}</h3>
                <p class="preview">${memo.preview || '无预览内容'}</p>
            </div>
            <div class="meta">
                <span>📅 ${dateStr}</span>
            </div>
        `;
        
        card.onclick = () => {
            if (isBatchMode) {
                if (selectedMemos.has(memo.name)) {
                    selectedMemos.delete(memo.name);
                } else {
                    selectedMemos.add(memo.name);
                }
                updateBatchUI();
                card.classList.toggle('selected', selectedMemos.has(memo.name));
            } else {
                openMemo(memo);
            }
        };
        memoGridEl.appendChild(card);
    });
}

function updateBatchUI() {
    document.getElementById('selected-count').textContent = `已选 ${selectedMemos.size} 项`;
}

async function openMemo(memo) {
    try {
        editorStatus.textContent = '正在加载内容...';
        editorOverlay.classList.add('active');
        editorTitleInput.value = memo.name;
        editorTextarea.value = '';
        editorPreview.innerHTML = '';

        const data = await apiFetch(`/note/${encodeURIComponent(currentFolder)}/${encodeURIComponent(memo.name)}`);
        
        currentMemo = {
            folder: currentFolder,
            file: memo.name,
            content: data.content
        };

        editorTextarea.value = data.content;
        renderPreview(data.content);
        editorStatus.textContent = `最后修改: ${new Date(memo.lastModified).toLocaleString()}`;
    } catch (error) {
        alert('读取日记失败: ' + error.message);
        editorOverlay.classList.remove('active');
    }
}

function renderPreview(content) {
    if (window.marked) {
        editorPreview.innerHTML = marked.parse(content);
        // KaTeX 渲染
        if (window.renderMathInElement) {
            renderMathInElement(editorPreview, {
                delimiters: [
                    {left: "$$", right: "$$", display: true},
                    {left: "$", right: "$", display: false},
                    {left: "\\(", right: "\\)", display: false},
                    {left: "\\[", right: "\\]", display: true}
                ]
            });
        }
    } else {
        editorPreview.textContent = content;
    }
}

async function handleSaveMemo() {
    if (!currentMemo) return;

    const newContent = editorTextarea.value;
    const saveBtn = document.getElementById('save-memo-btn');
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '正在保存...';

        await apiFetch(`/note/${encodeURIComponent(currentMemo.folder)}/${encodeURIComponent(currentMemo.file)}`, {
            method: 'POST',
            body: JSON.stringify({ content: newContent })
        });

        currentMemo.content = newContent;
        editorStatus.textContent = '保存成功 ' + new Date().toLocaleTimeString();
        
        // 刷新列表预览
        loadMemos(currentFolder);
    } catch (error) {
        alert('保存失败: ' + error.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

async function handleDeleteMemo() {
    if (!currentMemo) return;
    const confirmed = await customConfirm(`确定要删除日记 "${currentMemo.file}" 吗？\n此操作不可撤销。`, '⚠️ 删除确认');
    if (!confirmed) return;

    try {
        await apiFetch('/delete-batch', {
            method: 'POST',
            body: JSON.stringify({
                notesToDelete: [{ folder: currentMemo.folder, file: currentMemo.file }]
            })
        });

        editorOverlay.classList.remove('active');
        loadMemos(currentFolder);
    } catch (error) {
        alert('删除失败: ' + error.message);
    }
}

async function handleCreateMemo() {
    const date = newMemoDateInput.value;
    const maid = newMemoMaidInput.value.trim();
    const content = newMemoContentInput.value.trim();

    if (!date || !maid || !content) {
        alert('请填写完整信息');
        return;
    }

    const submitBtn = document.getElementById('submit-new-memo-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在发布...';

    try {
        const settings = await window.electronAPI.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key 未配置');

        // 构造 TOOL_REQUEST
        const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」${maid}「末」, 
tool_name:「始」DailyNote「末」,
command:「始」create「末」,  
Date:「始」${date}「末」,
Content:「始」${content}「末」 
<<<[END_TOOL_REQUEST]>>>`;

        const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'text/plain;charset=UTF-8', 
                'Authorization': `Bearer ${settings.vcpApiKey}` 
            },
            body: toolRequest
        });

        if (!res.ok) throw new Error(await res.text());

        // 成功后处理
        createModal.style.display = 'none';
        newMemoContentInput.value = '';
        
        // 延迟刷新，给后端一点处理时间
        setTimeout(async () => {
            await loadFolders();
            if (currentFolder) await loadMemos(currentFolder);
        }, 1000);

    } catch (error) {
        alert('发布失败: ' + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 发布';
    }
}

async function searchMemos(term) {
    try {
        memoGridEl.innerHTML = '<div style="padding: 20px;">搜索中...</div>';
        let url = `/search?term=${encodeURIComponent(term)}`;
        
        // 根据搜索范围决定是否添加 folder 参数
        if (searchScope === 'folder' && currentFolder) {
            url += `&folder=${encodeURIComponent(currentFolder)}`;
        }

        const data = await apiFetch(url);
        
        // 过滤掉来自 MusicDiary 的搜索结果
        const filteredNotes = data.notes.filter(note => note.folderName !== 'MusicDiary');

        const scopeText = (searchScope === 'folder' && currentFolder) ? `${currentFolder} 内搜索` : `全局搜索`;
        currentFolderNameEl.textContent = `${scopeText}: ${term}`;
        renderMemos(filteredNotes);
    } catch (error) {
        memoGridEl.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">搜索失败: ${error.message}</div>`;
    }
}

async function handleBatchDelete() {
    if (selectedMemos.size === 0) return;
    const confirmed = await customConfirm(`确定要批量删除选中的 ${selectedMemos.size} 项日记吗？\n此操作不可撤销！`, '⚠️ 批量删除确认');
    if (!confirmed) return;

    try {
        const notesToDelete = Array.from(selectedMemos).map(name => ({
            folder: currentFolder,
            file: name
        }));

        await apiFetch('/delete-batch', {
            method: 'POST',
            body: JSON.stringify({ notesToDelete })
        });

        selectedMemos.clear();
        document.getElementById('cancel-batch-btn').click();
        loadMemos(currentFolder);
    } catch (error) {
        alert('批量删除失败: ' + error.message);
    }
}

async function handleBatchMove(e) {
    const targetFolder = e.target.value;
    if (!targetFolder || selectedMemos.size === 0) return;

    const confirmed = await customConfirm(`确定要将选中的 ${selectedMemos.size} 项日记移动到 "${targetFolder}" 吗？`, '📦 批量移动确认');
    if (!confirmed) {
        e.target.value = ''; // 重置下拉框
        return;
    }

    try {
        const sourceNotes = Array.from(selectedMemos).map(name => ({
            folder: currentFolder,
            file: name
        }));

        await apiFetch('/move', {
            method: 'POST',
            body: JSON.stringify({
                sourceNotes,
                targetFolder
            })
        });

        selectedMemos.clear();
        document.getElementById('cancel-batch-btn').click();
        loadMemos(currentFolder);
        loadFolders();
    } catch (error) {
        alert('批量移动失败: ' + error.message);
    } finally {
        e.target.value = ''; // 重置下拉框
    }
}

// ========== 自定义弹窗函数 ==========
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

// ========== 工具函数 ==========
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}