// modules/notificationRenderer.js

/**
 * @typedef {Object} VCPLogStatus
 * @property {'open'|'closed'|'error'|'connecting'} status
 * @property {string} message
 */

/**
 * @typedef {Object} VCPLogData
 * @property {string} type - e.g., 'vcp_log', 'daily_note_created', 'connection_ack'
 * @property {Object|string} data - The actual log data or message content
 * @property {string} [message] - A general message if data is not the primary content
 */

/**
 * Updates the VCPLog connection status display.
 * @param {VCPLogStatus} statusUpdate - The status object.
 * @param {HTMLElement} vcpLogConnectionStatusDiv - The DOM element for status display.
 */
function updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv) {
    if (!vcpLogConnectionStatusDiv) return;
    vcpLogConnectionStatusDiv.textContent = `VCPLog: ${statusUpdate.message}`;
    vcpLogConnectionStatusDiv.className = `notifications-status status-${statusUpdate.status}`;
}

/**
 * Renders a VCPLog notification in the notifications list.
 * @param {VCPLogData|string} logData - The parsed JSON log data or a raw string message.
 * @param {string|null} originalRawMessage - The original raw string message from WebSocket, if available.
 * @param {HTMLElement} notificationsListUl - The UL element for notifications.
 * @param {Object} themeColors - An object containing theme colors like --notification-bg, --accent-bg, --highlight-text, --border-color, --primary-text, --secondary-text
 */
function renderVCPLogNotification(logData, originalRawMessage = null, notificationsListUl, themeColors = {}) {
    if (!notificationsListUl) return;

    const bubble = document.createElement('li');
    bubble.classList.add('notification-item');

    const textToCopy = originalRawMessage !== null ? originalRawMessage :
                       (typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData));

    let titleText = 'VCP 通知:';
    let mainContent = '';
    let contentIsPreformatted = false;

    // --- Content Parsing Logic (adapted from original renderer.js) ---
    if (logData && typeof logData === 'object' && logData.type === 'vcp_log' && logData.data && typeof logData.data === 'object') {
        const vcpData = logData.data;
        if (vcpData.tool_name && vcpData.status) {
            titleText = `${vcpData.tool_name} ${vcpData.status}`;
            if (typeof vcpData.content !== 'undefined') {
                let rawContentString = String(vcpData.content);
                mainContent = rawContentString;
                contentIsPreformatted = true;
                try {
                    const parsedInnerContent = JSON.parse(rawContentString);
                    let titleSuffix = '';
                    if (parsedInnerContent.MaidName) {
                        titleSuffix += ` by ${parsedInnerContent.MaidName}`;
                    }
                    if (parsedInnerContent.timestamp && typeof parsedInnerContent.timestamp === 'string' && parsedInnerContent.timestamp.length >= 16) {
                        const timePart = parsedInnerContent.timestamp.substring(11, 16);
                        titleSuffix += `${parsedInnerContent.MaidName ? ' ' : ''}@ ${timePart}`;
                    }
                    if (titleSuffix) {
                        titleText += ` (${titleSuffix.trim()})`;
                    }
                    if (typeof parsedInnerContent.original_plugin_output !== 'undefined') {
                        mainContent = String(parsedInnerContent.original_plugin_output);
                    }
                } catch (e) {
                    // console.warn('VCP Notifier: Could not parse vcpData.content as JSON:', e, rawContentString);
                }
            } else {
                mainContent = '(无内容)';
            }
        } else {
            titleText = 'VCP 日志条目:';
            mainContent = JSON.stringify(vcpData, null, 2);
            contentIsPreformatted = true;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'daily_note_created' && logData.data && typeof logData.data === 'object') {
        const noteData = logData.data;
        titleText = `日记: ${noteData.maidName || 'N/A'} (${noteData.dateString || 'N/A'})`;
        if (noteData.status === 'success') {
            mainContent = noteData.message || '日记已成功创建。';
        } else {
            mainContent = noteData.message || `日记处理状态: ${noteData.status || '未知'}`;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'connection_ack' && logData.message) {
        titleText = 'VCP 连接:';
        mainContent = String(logData.message);
    } else if (logData && typeof logData === 'object' && logData.type && logData.message) { // Generic type + message
        titleText = `类型: ${logData.type}`;
        mainContent = String(logData.message);
        if (logData.data) {
            mainContent += `\n数据: ${JSON.stringify(logData.data, null, 2)}`;
            contentIsPreformatted = true;
        }
    } else { // Fallback for other structures or plain string
        titleText = 'VCP 消息:';
        mainContent = typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData);
        contentIsPreformatted = typeof logData === 'object';
    }
    // --- End Content Parsing ---

    const strongTitle = document.createElement('strong');
    strongTitle.textContent = titleText;
    // 移除直接设置颜色，让CSS变量控制
    // if (themeColors.highlightText) strongTitle.style.color = themeColors.highlightText;
    bubble.appendChild(strongTitle);

    const notificationContentDiv = document.createElement('div');
    notificationContentDiv.classList.add('notification-content');

    if (mainContent) {
        if (contentIsPreformatted) {
            const pre = document.createElement('pre');
            pre.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
            notificationContentDiv.appendChild(pre);
        } else {
            const p = document.createElement('p');
            p.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
            notificationContentDiv.appendChild(p);
        }
    }
    bubble.appendChild(notificationContentDiv);

    const copyButton = document.createElement('button');
    copyButton.className = 'notification-copy-btn';
    copyButton.textContent = '📋';
    copyButton.title = '复制消息到剪贴板';
    copyButton.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(textToCopy).then(() => {
            const originalText = copyButton.textContent;
            copyButton.textContent = '已复制!';
            copyButton.disabled = true;
            setTimeout(() => {
                copyButton.textContent = originalText;
                copyButton.disabled = false;
            }, 1500);
        }).catch(err => {
            console.error('通知复制失败: ', err);
            const originalText = copyButton.textContent;
            copyButton.textContent = '错误!';
            setTimeout(() => {
                copyButton.textContent = originalText;
            }, 1500);
        });
    };
    bubble.appendChild(copyButton);

    const timestampSpan = document.createElement('span');
    timestampSpan.classList.add('notification-timestamp');
    timestampSpan.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 移除直接设置颜色，让CSS变量控制
    // if (themeColors.secondaryText) timestampSpan.style.color = themeColors.secondaryText;
    bubble.appendChild(timestampSpan);

    bubble.onclick = () => {
        bubble.style.opacity = '0';
        bubble.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (bubble.parentNode) {
                bubble.parentNode.removeChild(bubble);
            }
        }, 500); // Match CSS transition
    };

    // Apply theme colors to bubble itself
    if (themeColors.notificationBg) bubble.style.backgroundColor = themeColors.notificationBg;
    // 移除直接设置颜色，让CSS变量控制
    // if (themeColors.primaryText) bubble.style.color = themeColors.primaryText;
    // 移除直接设置边框颜色，让CSS变量控制
    // if (themeColors.borderColor) bubble.style.borderBottomColor = themeColors.borderColor;


    notificationsListUl.prepend(bubble);
    setTimeout(() => bubble.classList.add('visible'), 50);
}

// Expose functions to be used by renderer.js
window.notificationRenderer = {
    updateVCPLogStatus,
    renderVCPLogNotification
};