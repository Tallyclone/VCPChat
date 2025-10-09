// 测试新功能的脚本
// 这个脚本可以用来验证新建话题时提前写入初始消息的功能是否正常工作

async function testInitialMessageFeatures() {
    console.log('开始测试新建话题时提前写入初始消息的功能...');

    try {
        // 1. 测试获取全局设置
        const globalSettings = await window.electronAPI.loadSettings();
        console.log('全局设置:', globalSettings);

        // 2. 测试获取Agent配置
        const agents = await window.electronAPI.getAgents();
        if (agents && agents.length > 0) {
            const firstAgent = agents[0];
            const agentConfig = await window.electronAPI.getAgentConfig(firstAgent.id);
            console.log('Agent配置:', agentConfig);

            // 3. 测试创建带初始消息的话题
            const initialMessages = [
                {
                    role: 'user',
                    name: '自定义用户',
                    content: '这是第一条初始用户消息'
                },
                {
                    role: 'assistant',
                    name: '自定义助手',
                    content: '这是第一条初始助手消息'
                },
                {
                    role: 'system',
                    name: '自定义系统',
                    content: '这是第一条初始系统消息'
                },
                {
                    role: 'user',
                    content: '这是第二条初始用户消息（使用默认名字）'
                }
            ];

            if (window.chatManager && window.chatManager.createNewTopicWithMessages) {
                const result = await window.chatManager.createNewTopicWithMessages(
                    firstAgent.id,
                    '测试话题',
                    initialMessages,
                    { autoSwitch: false }
                );

                console.log('创建话题结果:', result);

                if (result.success) {
                    console.log('✅ 新建话题时提前写入初始消息功能测试成功！');
                    console.log(`创建了话题: ${result.topicId}`);
                    console.log(`包含 ${result.messageCount} 条初始消息`);

                    // 验证这些消息和普通消息完全一致
                    console.log('验证初始消息是否已保存到文件...');
                    const history = await window.electronAPI.getChatHistory(firstAgent.id, result.topicId);
                    if (history && !history.error) {
                        console.log(`✅ 验证成功: 话题文件包含 ${history.length} 条消息，与普通消息完全一致`);
                        console.log('📁 保存的初始消息详情:');
                        history.forEach((msg, index) => {
                            console.log(`  ${index + 1}. [${msg.role}] ${msg.name}: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? '...' : ''}`);
                        });

                        // 额外验证：检查刷新后消息是否仍然存在
                        console.log('测试刷新后消息持久性...');
                        setTimeout(async () => {
                            const refreshedHistory = await window.electronAPI.getChatHistory(firstAgent.id, result.topicId);
                            if (refreshedHistory && !refreshedHistory.error && refreshedHistory.length === history.length) {
                                console.log('✅ 刷新后消息仍然存在，持久性验证通过');
                            } else {
                                console.error('❌ 刷新后消息丢失，持久性验证失败');
                            }
                        }, 2000);

                    } else {
                        console.error(`❌ 文件验证失败: ${history?.error || '无法读取历史文件'}`);
                    }
                } else {
                    console.error('❌ 新建话题时提前写入初始消息功能测试失败:', result.error);
                }
            } else {
                console.error('❌ chatManager 或 createNewTopicWithMessages 方法不存在');
            }
        } else {
            console.error('❌ 没有可用的Agent进行测试');
        }

    } catch (error) {
        console.error('❌ 测试过程中出错:', error);
    }
}

// 如果有 mailboxManager，也测试它的功能
function testMailboxManagerFeatures() {
    console.log('开始测试MailboxManager新功能...');

    if (window.mailboxManager) {
        // 测试显示测试面板
        window.mailboxManager.showTestPanel();
        console.log('✅ 测试面板已显示');
    } else {
        console.error('❌ mailboxManager 不存在');
    }
}

// 导出测试函数供控制台使用
window.testInitialMessageFeatures = testInitialMessageFeatures;
window.testMailboxManagerFeatures = testMailboxManagerFeatures;

console.log('测试函数已加载，可以在控制台中调用:');
console.log('- testInitialMessageFeatures() - 测试新建话题时提前写入初始消息的功能');
console.log('- testMailboxManagerFeatures() - 测试MailboxManager的界面功能');