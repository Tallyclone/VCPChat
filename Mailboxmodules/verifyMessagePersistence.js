// 验证消息持久性的测试脚本
// 这个脚本专门用于验证预制消息是否真正保存到了文件中，并且在刷新后仍然存在

async function verifyMessagePersistence() {
    console.log('🔍 开始验证消息持久性测试...');

    try {
        // 1. 获取Agent列表
        const agents = await window.electronAPI.getAgents();
        if (!agents || agents.length === 0) {
            console.error('❌ 没有可用的Agent进行测试');
            return;
        }

        const testAgent = agents[0];
        console.log(`使用Agent进行测试: ${testAgent.name} (${testAgent.id})`);

        // 2. 创建带预制消息的话题
        const testMessages = [
            {
                role: 'user',
                name: '持久性测试用户',
                content: '这是一条用于测试消息持久性的用户消息'
            },
            {
                role: 'assistant',
                name: '持久性测试助手',
                content: '这是一条用于测试消息持久性的助手消息'
            },
            {
                role: 'system',
                content: '这是一条用于测试消息持久性的系统消息'
            }
        ];

        console.log(`准备创建话题，包含 ${testMessages.length} 条测试消息...`);

        if (window.chatManager && window.chatManager.createNewTopicWithMessages) {
            const result = await window.chatManager.createNewTopicWithMessages(
                testAgent.id,
                '消息持久性测试话题',
                testMessages,
                { autoSwitch: false }
            );

            if (result.success) {
                console.log(`✅ 话题创建成功: ${result.topicId}`);

                // 3. 立即验证消息是否已保存到文件
                console.log('立即验证消息是否已保存到文件...');
                const immediateHistory = await window.electronAPI.getChatHistory(testAgent.id, result.topicId);

                if (immediateHistory && !immediateHistory.error) {
                    console.log(`✅ 立即验证成功: 文件中包含 ${immediateHistory.length} 条消息`);

                    if (immediateHistory.length >= testMessages.length) {
                        console.log('📁 初始保存的消息:');
                        immediateHistory.forEach((msg, index) => {
                            console.log(`  ${index + 1}. [${msg.role}] ${msg.name || '未命名'}: ${msg.content}`);
                        });

                        // 4. 等待一段时间后再次验证（模拟刷新）
                        console.log('等待2秒后再次验证（模拟页面刷新）...');
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        const refreshedHistory = await window.electronAPI.getChatHistory(testAgent.id, result.topicId);

                        if (refreshedHistory && !refreshedHistory.error) {
                            console.log(`✅ 刷新后验证成功: 文件中仍包含 ${refreshedHistory.length} 条消息`);

                            if (refreshedHistory.length === immediateHistory.length) {
                                console.log('🎉 持久性验证通过！消息已永久保存，不会因刷新而丢失');
                                console.log('📋 刷新后的消息详情:');
                                refreshedHistory.forEach((msg, index) => {
                                    console.log(`  ${index + 1}. [${msg.role}] ${msg.name || '未命名'}: ${msg.content}`);
                                });

                                // 5. 验证消息内容一致性
                                let allMatch = true;
                                for (let i = 0; i < Math.min(immediateHistory.length, refreshedHistory.length); i++) {
                                    if (immediateHistory[i].content !== refreshedHistory[i].content ||
                                        immediateHistory[i].role !== refreshedHistory[i].role) {
                                        allMatch = false;
                                        break;
                                    }
                                }

                                if (allMatch) {
                                    console.log('✅ 消息内容一致性验证通过');
                                } else {
                                    console.error('❌ 消息内容一致性验证失败');
                                }

                            } else {
                                console.error(`❌ 持久性验证失败: 刷新前后消息数量不一致 (${immediateHistory.length} -> ${refreshedHistory.length})`);
                            }
                        } else {
                            console.error(`❌ 刷新后验证失败: ${refreshedHistory?.error || '无法读取文件'}`);
                        }

                    } else {
                        console.error(`❌ 初始保存验证失败: 预期 ${testMessages.length} 条消息，实际保存 ${immediateHistory.length} 条`);
                    }

                } else {
                    console.error(`❌ 初始验证失败: ${immediateHistory?.error || '无法读取历史文件'}`);
                }

            } else {
                console.error('❌ 话题创建失败:', result.error);
            }
        } else {
            console.error('❌ chatManager 或 createNewTopicWithMessages 方法不存在');
        }

    } catch (error) {
        console.error('❌ 持久性验证测试过程中出错:', error);
    }
}

// 导出测试函数
window.verifyMessagePersistence = verifyMessagePersistence;

console.log('消息持久性验证函数已加载');
console.log('使用方法: verifyMessagePersistence()');
console.log('此函数将：');
console.log('1. 创建一个带预制消息的话题');
console.log('2. 立即验证消息是否已保存到文件');
console.log('3. 等待2秒后再次验证（模拟刷新）');
console.log('4. 验证消息内容的一致性和持久性');