/**
 * Mailboxmodules 集成测试脚本
 * 用于验证所有功能是否正常工作
 */

window.testMailboxIntegration = async function() {
    console.log('[MailboxIntegrationTest] 开始集成测试...');

    const results = {
        total: 0,
        passed: 0,
        failed: 0,
        details: []
    };

    // 测试1: 检查模块是否正确加载
    results.total++;
    if (window.mailboxManager) {
        results.passed++;
        results.details.push('✅ MailboxManager 模块加载成功');
    } else {
        results.failed++;
        results.details.push('❌ MailboxManager 模块加载失败');
        return results;
    }

    // 测试2: 检查初始化状态
    results.total++;
    const state = window.mailboxManager.getCurrentState();
    if (state.isInitialized) {
        results.passed++;
        results.details.push('✅ MailboxManager 已正确初始化');
    } else {
        results.failed++;
        results.details.push('❌ MailboxManager 未初始化');
    }

    // 测试3: 检查是否可以获取Agent列表
    results.total++;
    try {
        const agents = await window.mailboxManager.getAvailableAgents();
        if (Array.isArray(agents)) {
            results.passed++;
            results.details.push(`✅ 成功获取 ${agents.length} 个Agent`);
        } else {
            results.failed++;
            results.details.push('❌ 获取Agent列表失败：返回格式错误');
        }
    } catch (error) {
        results.failed++;
        results.details.push(`❌ 获取Agent列表出错：${error.message}`);
    }

    // 测试4: 检查聊天管理器扩展功能
    results.total++;
    if (window.chatManager && window.chatManager.createNewTopicWithMessages) {
        results.passed++;
        results.details.push('✅ 聊天管理器已扩展带预制消息的话题创建功能');
    } else {
        results.failed++;
        results.details.push('❌ 聊天管理器缺少预制消息功能');
    }

    // 测试5: 检查测试面板功能
    results.total++;
    try {
        // 创建测试面板（但不显示）
        const panelCreated = window.mailboxManager.createTestPanel();
        if (panelCreated) {
            results.passed++;
            results.details.push('✅ 测试面板创建成功');
        } else {
            results.failed++;
            results.details.push('❌ 测试面板创建失败');
        }
    } catch (error) {
        results.failed++;
        results.details.push(`❌ 测试面板创建出错：${error.message}`);
    }

    // 测试6: 检查FileWatcher集成
    results.total++;
    if (window.electronAPI && window.electronAPI.watcherStart && window.electronAPI.watcherStop) {
        results.passed++;
        results.details.push('✅ FileWatcher API可用');
    } else {
        results.failed++;
        results.details.push('❌ FileWatcher API不可用');
    }

    // 测试7: 检查预制消息保存功能（核心修复测试）
    results.total++;
    try {
        // 获取第一个可用的Agent进行测试
        const agents = await window.mailboxManager.getAvailableAgents();
        if (agents && agents.length > 0) {
            const testAgent = agents[0];
            const testMessages = [
                { role: 'system', content: '测试系统消息' },
                { role: 'user', content: '测试用户消息' }
            ];

            // 创建测试话题
            const createResult = await window.mailboxManager.createTopicWithPresetMessages(
                testAgent.id,
                '测试话题_' + Date.now(),
                testMessages,
                { autoSwitch: false } // 不自动跳转，避免UI干扰
            );

            if (createResult.success) {
                // 验证预制消息是否正确保存
                const verifyHistory = await window.electronAPI.getChatHistory(testAgent.id, createResult.topicId);
                if (verifyHistory && !verifyHistory.error && verifyHistory.length >= testMessages.length) {
                    results.passed++;
                    results.details.push(`✅ 预制消息保存功能正常: 创建话题 ${createResult.topicId}，保存 ${verifyHistory.length} 条消息`);
                } else {
                    results.failed++;
                    results.details.push(`❌ 预制消息保存功能异常: 预期至少 ${testMessages.length} 条消息，实际 ${verifyHistory?.length || 0} 条`);
                }
            } else {
                results.failed++;
                results.details.push(`❌ 预制消息保存功能异常: 创建话题失败 - ${createResult.error}`);
            }
        } else {
            results.failed++;
            results.details.push('❌ 预制消息保存功能测试跳过: 无可用Agent');
        }
    } catch (error) {
        results.failed++;
        results.details.push(`❌ 预制消息保存功能测试出错: ${error.message}`);
    }

    // 输出测试结果
    console.log('[MailboxIntegrationTest] 测试完成');
    console.log(`[MailboxIntegrationTest] 通过: ${results.passed}/${results.total}`);
    console.log(`[MailboxIntegrationTest] 失败: ${results.failed}/${results.total}`);

    results.details.forEach(detail => console.log(detail));

    return results;
};

// 自动运行测试（仅在开发环境）
if (typeof window !== 'undefined' && window.location && window.location.hostname === 'localhost') {
    window.addEventListener('load', () => {
        setTimeout(() => {
            window.testMailboxIntegration().then(results => {
                if (results.failed > 0) {
                    console.warn('[MailboxIntegrationTest] 发现问题，请检查上述错误');
                } else {
                    console.log('[MailboxIntegrationTest] 所有测试通过！');
                }
            });
        }, 2000); // 等待2秒确保所有模块加载完成
    });
}