// modules/topicSummarizer.js

/**
 * 根据消息列表尝试用AI总结一个话题标题。
 * @param {Array<Object>} messages - 聊天消息对象数组。
 * @param {string} agentName - 当前Agent的名称，可用于提示。
 * @returns {Promise<string|null>} 返回总结的标题，如果无法总结则返回null。
 */
async function summarizeTopicFromMessages(messages, agentName) {
    if (!messages || messages.length < 4) { // 至少需要两轮对话 (user, assistant, user, assistant)
        return null;
    }

    // 提取最近的几条消息内容用于总结
    // 例如，提取最近4条消息
    const recentMessagesContent = messages.slice(-4).map(msg => {
        return `${msg.role === 'user' ? (globalSettings.userName || '用户') : agentName}: ${msg.content}`;
    }).join('\n');

    console.log('[TopicSummarizer] 准备总结的内容:', recentMessagesContent);

    // --- Placeholder for AI summarization logic ---
    // 在实际应用中，这里会调用VCP或其他AI服务进行总结
    // 例如:
    // const summaryPrompt = `根据以下对话内容，为这个话题生成一个简洁的标题（10个字以内）：\n${recentMessagesContent}`;
    // const vcpSummaryResponse = await window.electronAPI.sendToVCP(
    //     globalSettings.vcpServerUrl,
    //     globalSettings.vcpApiKey,
    //     [{ role: 'user', content: summaryPrompt }],
    //     { model: 'gpt-3.5-turbo', temperature: 0.3, max_tokens: 20 } // 使用一个快速、便宜的模型
    // );
    // if (vcpSummaryResponse && vcpSummaryResponse.choices && vcpSummaryResponse.choices.length > 0) {
    //     let title = vcpSummaryResponse.choices[0].message.content.trim();
    //     // 清理标题，移除可能的引号等
    //     title = title.replace(/^["']|["']$/g, '');
    //     return title;
    // }
    // ---------------------------------------------

    // 临时的占位符逻辑：简单地从用户最新消息中提取一些关键词
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content;
    if (lastUserMessage) {
        const tempTitle = `关于 "${lastUserMessage.substring(0, 15)}${lastUserMessage.length > 15 ? '...' : ''}"`;
        console.log('[TopicSummarizer] 临时生成的标题:', tempTitle);
        return tempTitle;
    }

    return null;
}

// 如果是在Node.js环境中直接运行此文件进行测试，可以取消下面的注释
// if (typeof module !== 'undefined' && module.exports) {
//     module.exports = { summarizeTopicFromMessages };
// }
// 在Electron的Renderer进程中，我们通常会通过 <script src="..."> 引入
// 或者，如果preload.js可以访问这个文件，也可以通过IPC暴露
// 但最简单的方式是在renderer.js中直接通过相对路径的script标签引入