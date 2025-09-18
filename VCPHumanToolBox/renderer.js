// VCPHumanToolBox/renderer.js
const { ipcRenderer } = require('electron');
const { marked } = require('marked');

// 创建 electronAPI 对象以支持 ComfyUI 模块
window.electronAPI = {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, callback) => {
        // 为了安全，只允许特定的通道
        const validChannels = ['comfyui:config-changed', 'comfyui:workflows-changed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, callback);
        }
    },
    removeListener: (channel, callback) => {
        ipcRenderer.removeListener(channel, callback);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // --- 元素获取 ---
    const toolGrid = document.getElementById('tool-grid');
    const toolDetailView = document.getElementById('tool-detail-view');
    const backToGridBtn = document.getElementById('back-to-grid-btn');
    const toolTitle = document.getElementById('tool-title');
    const toolDescription = document.getElementById('tool-description');
    const toolForm = document.getElementById('tool-form');
    const resultContainer = document.getElementById('result-container');

    // --- 从主程序 settings.json 读取配置 ---
    const fs = require('fs');
    const fsPromises = require('fs').promises;
    const path = require('path');

    let VCP_SERVER_URL = '';
    let VCP_API_KEY = '';
    let USER_NAME = 'Human'; // Default value in case it's not found
    let settings = {}; // Make settings available in a wider scope
    let MAX_FILENAME_LENGTH = 400; // 默认最大文件名长度
    const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');

    function loadSettings() {
        try {
            const settingsData = fs.readFileSync(settingsPath, 'utf8');
            settings = JSON.parse(settingsData);
        } catch (error) {
            console.error('Failed to load settings.json:', error);
            settings = {}; // Reset to empty object on error
        }
    }

    // 修复：使用安全的异步文件写入方式
    async function saveSettings() {
        try {
            // 使用安全的原子性写入
            const tempFile = settingsPath + '.tmp';
            const settingsJson = JSON.stringify(settings, null, 4);
            
            // 写入临时文件
            await fsPromises.writeFile(tempFile, settingsJson, 'utf8');
            
            // 验证写入的文件是否正确
            const verifyContent = await fsPromises.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent); // 检查JSON格式是否正确
            
            // 如果验证成功，再重命名为正式文件
            await fsPromises.rename(tempFile, settingsPath);
            
            console.log('[VCPHumanToolBox] Settings saved successfully');
        } catch (error) {
            console.error('[VCPHumanToolBox] Failed to save settings.json:', error);
            
            // 清理可能存在的临时文件
            try {
                await fsPromises.unlink(settingsPath + '.tmp');
            } catch (cleanupError) {
                // 忽略清理错误
            }
            
            throw error; // 重新抛出错误以便调用者处理
        }
    }

    // 修复：确保只读取时使用同步操作，写入时使用异步操作
    function saveSettingsSync() {
        console.warn('[VCPHumanToolBox] saveSettingsSync is deprecated, use saveSettings() instead');
        // 如果必须同步保存，至少使用try-catch保护
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
        } catch (error) {
            console.error('[VCPHumanToolBox] Failed to save settings.json synchronously:', error);
        }
    }

    try {
        loadSettings(); // Initial load

        if (settings.vcpServerUrl) {
            const url = new URL(settings.vcpServerUrl);
            url.pathname = '/v1/human/tool';
            VCP_SERVER_URL = url.toString();
        }
        VCP_API_KEY = settings.vcpApiKey || '';
        USER_NAME = settings.userName || 'Human';
        MAX_FILENAME_LENGTH = settings.maxFilenameLength || 400;

        if (!VCP_SERVER_URL || !VCP_API_KEY) {
            throw new Error('未能从 settings.json 中找到 vcpServerUrl 或 vcpApiKey');
        }

    } catch (error) {
        console.error('加载配置文件失败:', error);
        // 在界面上显示错误，阻止后续操作
        toolGrid.innerHTML = `<div class="error">错误：无法加载配置文件 (settings.json)。请确保文件存在且格式正确。<br>${error.message}</div>`;
        return; // 停止执行
    }


    // --- 工具定义 (基于 supertool.txt) ---
    const tools = {
        // 多媒体生成类
        'FluxGen': {
            displayName: 'Flux 图片生成',
            description: '艺术风格多变，仅支持英文提示词。',
            params: [
                { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的英文提示词' },
                { name: 'resolution', type: 'select', required: true, options: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'] }
            ]
        },
        'DoubaoGen': {
            displayName: '豆包 AI 图片',
            description: '集成豆包模型的图片生成与编辑功能。',
            commands: {
                'DoubaoGenerateImage': {
                    description: '豆包生图',
                    params: [
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于图片生成的详细提示词。' },
                        { name: 'resolution', type: 'text', required: true, placeholder: '(必需) 图片分辨率，格式为“宽x高”。理论上支持2048以内内任意分辨率组合。', default: '1024x1024' }
                    ]
                },
                'DoubaoEditImage': {
                    description: '豆包修图',
                    params: [
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于指导图片修改的详细提示词。' },
                        { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(必需) 用于图生图的图片来源，可以是公网可访问的 https URL，或者是分布式服务器的本地文件路径 (格式为 file:///...)。也可以是直接的database64url' },
                        { name: 'resolution', type: 'text', required: true, placeholder: '(必需) 图片分辨率，格式为“宽x高”，可设为“adaptive”以自适应原图尺寸。', default: 'adaptive' },
                        { name: 'guidance_scale', type: 'number', required: false, placeholder: '范围0-10，控制与原图的相似度，值越小越相似。' }
                    ]
                }
            }
        },
        'SunoGen': {
            displayName: 'Suno 音乐生成',
            description: '强大的Suno音乐生成器。',
            commands: {
                'generate_song': {
                    description: '生成歌曲或纯音乐',
                    params: [
                        { name: 'mode', type: 'radio', options: ['lyrics', 'instrumental'], default: 'lyrics', description: '生成模式' },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '[Verse 1]\nSunlight on my face...', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'tags', type: 'text', required: false, placeholder: 'acoustic, pop, happy', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'title', type: 'text', required: false, placeholder: 'Sunny Days', dependsOn: { field: 'mode', value: 'lyrics' } },
                        { name: 'gpt_description_prompt', type: 'textarea', required: true, placeholder: '一首关于星空和梦想的安静钢琴曲', dependsOn: { field: 'mode', value: 'instrumental' } }
                    ]
                }
            }
        },
        'Wan2.1VideoGen': {
            displayName: 'Wan2.1 视频生成',
            description: '基于强大的Wan2.1模型生成视频。',
            commands: {
                'submit': {
                    description: '提交新视频任务',
                    params: [
                        { name: 'mode', type: 'radio', options: ['i2v', 't2v'], default: 't2v', description: '生成模式' },
                        { name: 'image_url', type: 'text', required: true, placeholder: 'http://example.com/cat.jpg', dependsOn: { field: 'mode', value: 'i2v' } },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '一只猫在太空漫步', dependsOn: { field: 'mode', value: 't2v' } },
                        { name: 'resolution', type: 'select', required: true, options: ['1280x720', '720x1280', '960x960'], dependsOn: { field: 'mode', value: 't2v' } }
                    ]
                },
                'query': {
                    description: '查询任务状态',
                    params: [{ name: 'request_id', type: 'text', required: true, placeholder: '任务提交后返回的ID' }]
                }
            }
        },
        // 工具类
        'SciCalculator': {
            displayName: '科学计算器',
            description: '支持基础运算、函数、统计和微积分。',
            params: [{ name: 'expression', type: 'textarea', required: true, placeholder: "例如: integral('x**2', 0, 1)" }]
        },
        'TavilySearch': {
            displayName: 'Tavily 联网搜索',
            description: '专业的联网搜索API。',
            params: [
                { name: 'query', type: 'text', required: true, placeholder: '搜索的关键词或问题' },
                { name: 'topic', type: 'text', required: false, placeholder: "general, news, finance..." },
                { name: 'max_results', type: 'number', required: false, placeholder: '10 (范围 5-100)' },
                { name: 'include_raw_content', type: 'select', required: false, options: ['', 'text', 'markdown'] },
                { name: 'start_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' },
                { name: 'end_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' }
            ]
        },
        'GoogleSearch': {
            displayName: 'Google 搜索',
            description: '进行一次标准的谷歌网页搜索。',
            params: [{ name: 'query', type: 'text', required: true, placeholder: '如何学习编程？' }]
        },
        'UrlFetch': {
            displayName: '网页超级爬虫',
            description: '获取网页的文本内容或快照。',
            params: [
                { name: 'url', type: 'text', required: true, placeholder: 'https://example.com' },
                { name: 'mode', type: 'select', required: false, options: ['text', 'snapshot'] }
            ]
        },
        'BilibiliFetch': {
            displayName: 'B站内容获取',
            description: '获取B站视频的TTS转化文本内容。',
            params: [{ name: 'url', type: 'text', required: true, placeholder: 'Bilibili 视频的 URL' }]
        },
        'FlashDeepSearch': {
            displayName: '深度信息研究',
            description: '进行深度主题搜索，返回研究论文。',
            params: [
                { name: 'SearchContent', type: 'textarea', required: true, placeholder: '希望研究的主题内容' },
                { name: 'SearchBroadness', type: 'number', required: false, placeholder: '7 (范围 5-20)' }
            ]
        },
        // VCP通讯插件
        'AgentAssistant': {
            displayName: '女仆通讯器',
            description: '用于联络别的女仆Agent。',
            params: [
                { name: 'agent_name', type: 'text', required: true, placeholder: '例如: 小娜, 小克...' },
                { name: 'prompt', type: 'textarea', required: true, placeholder: '我是[您的名字]，我想请你...' }
            ]
        },
        'AgentMessage': {
            displayName: '主人通讯器',
            description: '向莱恩主人的设备发送通知消息。',
            params: [{ name: 'message', type: 'textarea', required: true, placeholder: '要发送的消息内容' }]
        },
        'DeepMemo': {
            displayName: '深度回忆',
            description: '回忆过去的聊天历史。',
            params: [
                { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                { name: 'keyword', type: 'text', required: true, placeholder: '多个关键词用空格或逗号分隔' },
                { name: 'window_size', type: 'number', required: false, placeholder: '10 (范围 1-20)' }
            ]
        },
        // 物联网插件
        'TableLampRemote': {
            displayName: '桌面台灯控制器',
            description: '控制智能台灯的状态。',
            commands: {
                'GetLampStatus': {
                    description: '获取台灯当前信息',
                    params: []
                },
                'LampControl': {
                    description: '控制台灯',
                    params: [
                        { name: 'power', type: 'select', options: ['', 'True', 'False'], description: '电源' },
                        { name: 'brightness', type: 'number', min: 1, max: 100, placeholder: '1-100', description: '亮度' },
                        { name: 'color_temperature', type: 'number', min: 2500, max: 4800, placeholder: '2500-4800', description: '色温' }
                    ]
                }
            }
        },
        // ComfyUI 图像生成
        'ComfyUIGen': {
            displayName: 'ComfyUI 生成',
            description: '使用本地 ComfyUI 后端进行图像生成',
            params: [
                { name: 'prompt', type: 'textarea', required: true, placeholder: '图像生成的正面提示词，描述想要生成的图像内容、风格、细节等' },
                { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '额外的负面提示词，将与用户配置的负面提示词合并' },
                { name: 'workflow', type: 'text', required: false, placeholder: '例如: text2img_basic, text2img_advanced' },
                { name: 'width', type: 'number', required: false, placeholder: '默认使用用户配置的值' },
                { name: 'height', type: 'number', required: false, placeholder: '默认使用用户配置的值' }
            ]
        },
        // NanoBanana 图像生成
        'NanoBananaGenOR': {
            displayName: 'NanoBanana 图像生成',
            description: '使用 OpenRouter 接口调用 Google Gemini 2.5 Flash Image Preview 模型进行高级的图像生成和编辑。支持代理和多密钥随机选择。',
            commands: {
                'generate': {
                    description: '生成一张全新的图片',
                    params: [
                        { name: 'enable_translation', type: 'checkbox', description: '启用提示词翻译(中文→英文)', default: false },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的提示词，用于图片生成。例如：一个美丽的日落山景，色彩绒烂，云彩壮观' }
                    ]
                },
                'edit': {
                    description: '编辑一张现有的图片',
                    params: [
                        { name: 'enable_translation', type: 'checkbox', description: '启用提示词翻译(中文→英文)', default: false },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '描述如何编辑图片的详细指令。例如：在天空中添加一道彩虹，让颜色更加鲜艳' },
                        { name: 'image_url', type: 'dragdrop_image', required: true, placeholder: '要编辑的图片URL或拖拽图片文件到此处' }
                    ]
                },
                'compose': {
                    description: '合成多张图片',
                    params: [
                        { name: 'enable_translation', type: 'checkbox', description: '启用提示词翻译(中文→英文)', default: false },
                        { name: 'prompt', type: 'textarea', required: true, placeholder: '描述如何合成多张图片的详细指令。例如：使用第一张图的背景和第二张图的人物创建一个奇幻场景' },
                        { name: 'image_url_1', type: 'dragdrop_image', required: true, placeholder: '第一张图片' }
                    ],
                    dynamicImages: true
                }
            }
        }
    };

    // --- 函数定义 ---

    function renderToolGrid() {
        toolGrid.innerHTML = '';
        for (const toolName in tools) {
            const tool = tools[toolName];
            const card = document.createElement('div');
            card.className = 'tool-card';
            card.dataset.toolName = toolName;
            card.innerHTML = `
                <h3>${tool.displayName}</h3>
                <p>${tool.description}</p>
            `;
            card.addEventListener('click', () => showToolDetail(toolName));
            toolGrid.appendChild(card);
        }
    }

    function showToolDetail(toolName) {
        const tool = tools[toolName];
        toolTitle.textContent = tool.displayName;
        toolDescription.textContent = tool.description;
        
        buildToolForm(toolName);

        toolGrid.style.display = 'none';
        toolDetailView.style.display = 'block';
        resultContainer.innerHTML = '';
    }

    function buildToolForm(toolName) {
        const tool = tools[toolName];
        toolForm.innerHTML = '';
        const paramsContainer = document.createElement('div');
        paramsContainer.id = 'params-container';

        if (tool.commands) {
            const commandSelectGroup = document.createElement('div');
            commandSelectGroup.className = 'form-group';
            commandSelectGroup.innerHTML = `<label for="command-select">选择操作 (Command):</label>`;
            const commandSelect = document.createElement('select');
            commandSelect.id = 'command-select';
            commandSelect.name = 'command';
            
            for (const commandName in tool.commands) {
                const option = document.createElement('option');
                option.value = commandName;
                option.textContent = `${commandName} - ${tool.commands[commandName].description}`;
                commandSelect.appendChild(option);
            }
            commandSelectGroup.appendChild(commandSelect);
            toolForm.appendChild(commandSelectGroup);
            
            toolForm.appendChild(paramsContainer);

            commandSelect.addEventListener('change', (e) => {
                renderFormParams(tool.commands[e.target.value].params, paramsContainer, toolName, e.target.value);
            });
            renderFormParams(tool.commands[commandSelect.value].params, paramsContainer, toolName, commandSelect.value);

        } else {
            toolForm.appendChild(paramsContainer);
            renderFormParams(tool.params, paramsContainer, toolName);
        }

        // 添加按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap;';
        
        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = '执行';
        submitButton.style.cssText = `
            background-color: var(--success-color);
            color: var(--text-on-accent);
            border: none;
            padding: 12px 25px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            transition: background-color 0.2s;
        `;
        buttonContainer.appendChild(submitButton);
        
        // 添加全部清空按钮
        const clearAllButton = document.createElement('button');
        clearAllButton.type = 'button';
        clearAllButton.innerHTML = '🗑️ 全部清空';
        clearAllButton.style.cssText = `
            background-color: var(--warning-color, #f59e0b);
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        `;
        
        clearAllButton.addEventListener('click', () => {
            clearAllFormData(toolName);
        });
        
        buttonContainer.appendChild(clearAllButton);

        // 为 ComfyUI 工具添加设置按钮
        if (toolName === 'ComfyUIGen') {
            const settingsButton = document.createElement('button');
            settingsButton.type = 'button';
            settingsButton.textContent = '⚙️ 设置';
            settingsButton.className = 'back-btn';
            settingsButton.style.cssText = 'margin-left: auto;';
            settingsButton.addEventListener('click', () => openComfyUISettings());
            buttonContainer.appendChild(settingsButton);
        }
        
        // 为 NanoBananaGenOR 工具添加文件名设置按钮
        if (toolName === 'NanoBananaGenOR') {
            const filenameSettingsButton = document.createElement('button');
            filenameSettingsButton.type = 'button';
            filenameSettingsButton.innerHTML = '⚙️ 设置';
            filenameSettingsButton.style.cssText = `
                background-color: var(--secondary-color, #6b7280);
                color: white;
                border: none;
                padding: 12px 20px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
            `;
            
            filenameSettingsButton.addEventListener('click', () => {
                showFilenameSettings();
            });
            
            buttonContainer.appendChild(filenameSettingsButton);
        }

        toolForm.appendChild(buttonContainer);

        toolForm.onsubmit = (e) => {
            e.preventDefault();
            executeTool(toolName);
        };
    }

    function renderFormParams(params, container, toolName = '', commandName = '') {
        container.innerHTML = '';
        const dependencyListeners = [];

        // 检查是否为 NanoBananaGenOR 的 compose 命令
        const isNanoBananaCompose = toolName === 'NanoBananaGenOR' && commandName === 'compose';
        let imageUrlCounter = 1; // 用于动态图片输入框的计数器

        params.forEach(param => {
            const paramGroup = document.createElement('div');
            paramGroup.className = 'form-group';
            
            let labelText = param.description || param.name;
            const label = document.createElement('label');
            label.textContent = `${labelText}${param.required ? ' *' : ''}`;
            
            let input;
            if (param.type === 'textarea') {
                input = document.createElement('textarea');
            } else if (param.type === 'select') {
                input = document.createElement('select');
                param.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt || `(${param.name})`;
                    input.appendChild(option);
                });
            } else if (param.type === 'radio') {
                input = document.createElement('div');
                input.className = 'radio-group';
                param.options.forEach(opt => {
                    const radioLabel = document.createElement('label');
                    const radioInput = document.createElement('input');
                    radioInput.type = 'radio';
                    radioInput.name = param.name;
                    radioInput.value = opt;
                    if (opt === param.default) radioInput.checked = true;
                    
                    radioLabel.appendChild(radioInput);
                    radioLabel.append(` ${opt}`);
                    input.appendChild(radioLabel);

                    // Add listener for dependency changes
                    radioInput.addEventListener('change', () => {
                        dependencyListeners.forEach(listener => listener());
                    });
                });
            } else if (param.type === 'dragdrop_image') {
                // 创建拖拽上传图片输入框
                input = createDragDropImageInput(param);
            } else if (param.type === 'checkbox') {
                input = document.createElement('div');
                input.className = 'checkbox-group';
                
                const checkboxLabel = document.createElement('label');
                checkboxLabel.className = 'checkbox-label';
                checkboxLabel.style.cssText = `
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    margin-top: 5px;
                `;
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.name = param.name;
                checkbox.checked = param.default || false;
                
                const checkboxText = document.createElement('span');
                checkboxText.textContent = param.description || param.name;
                
                checkboxLabel.appendChild(checkbox);
                checkboxLabel.appendChild(checkboxText);
                input.appendChild(checkboxLabel);
                
                // 添加翻译相关的UI元素
                if (param.name === 'enable_translation') {
                    const translationContainer = createTranslationContainer(param.name);
                    input.appendChild(translationContainer);
                    
                    // 监听 checkbox 状态变化
                    checkbox.addEventListener('change', (e) => {
                        const container = input.querySelector('.translation-container');
                        if (container) {
                            container.style.display = e.target.checked ? 'block' : 'none';
                        }
                    });
                }
            } else {
                input = document.createElement('input');
                input.type = param.type || 'text';
            }
            
            if (input.tagName !== 'DIV' || param.type === 'dragdrop_image') {
                input.name = param.name;
                if (param.type !== 'dragdrop_image') {
                    input.placeholder = param.placeholder || '';
                    if (param.default) input.value = param.default;
                }
                if (param.required) input.required = true;
            } else {
                // For radio group, we need a hidden input to carry the name for FormData
                const hiddenInput = document.createElement('input');
                hiddenInput.type = 'hidden';
                hiddenInput.name = param.name;
                paramGroup.appendChild(hiddenInput);
            }

            paramGroup.appendChild(label);
            paramGroup.appendChild(input);
            container.appendChild(paramGroup);

            // Handle conditional visibility
            if (param.dependsOn) {
                const dependencyCheck = () => {
                    const dependencyField = toolForm.querySelector(`[name="${param.dependsOn.field}"]:checked`) || toolForm.querySelector(`[name="${param.dependsOn.field}"]`);
                    if (dependencyField && dependencyField.value === param.dependsOn.value) {
                        paramGroup.style.display = '';
                    } else {
                        paramGroup.style.display = 'none';
                    }
                };
                dependencyListeners.push(dependencyCheck);
            }
        });

        // 如果是 NanoBanana compose 模式，添加动态图片管理区域
        if (isNanoBananaCompose) {
            createDynamicImageContainer(container);
        }

        dependencyListeners.forEach(listener => listener());
    }

    // 创建翻译容器
    function createTranslationContainer(paramName) {
        const container = document.createElement('div');
        container.className = 'translation-container';
        container.style.cssText = `
            display: none;
            margin-top: 10px;
            padding: 15px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: rgba(59, 130, 246, 0.05);
        `;
        
        // 翻译设置区域
        const settingsArea = document.createElement('div');
        settingsArea.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            align-items: center;
            flex-wrap: wrap;
        `;
        
        const qualityLabel = document.createElement('label');
        qualityLabel.textContent = '质量：';
        qualityLabel.style.cssText = `
            font-weight: bold;
            color: var(--secondary-text);
            font-size: 14px;
        `;
        
        const qualitySelect = document.createElement('select');
        qualitySelect.className = 'translation-quality-select';
        qualitySelect.innerHTML = `
            <option value="gemini-2.5-flash-lite-preview-06-17">快速</option>
            <option value="gemini-2.5-flash" selected>均衡</option>
            <option value="gemini-2.5-pro">质量</option>
        `;
        qualitySelect.style.cssText = `
            padding: 6px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        const languageLabel = document.createElement('label');
        languageLabel.textContent = '目标语言：';
        languageLabel.style.cssText = `
            font-weight: bold;
            color: var(--secondary-text);
            font-size: 14px;
        `;
        
        const languageSelect = document.createElement('select');
        languageSelect.className = 'translation-language-select';
        languageSelect.innerHTML = `
            <option value="en" selected>英语</option>
            <option value="zh">中文</option>
            <option value="ja">日语</option>
            <option value="ko">韩语</option>
            <option value="fr">法语</option>
            <option value="de">德语</option>
            <option value="es">西班牙语</option>
        `;
        languageSelect.style.cssText = `
            padding: 6px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        settingsArea.appendChild(qualityLabel);
        settingsArea.appendChild(qualitySelect);
        settingsArea.appendChild(languageLabel);
        settingsArea.appendChild(languageSelect);
        
        const translatedPromptLabel = document.createElement('label');
        translatedPromptLabel.textContent = '翻译后的提示词：';
        translatedPromptLabel.style.cssText = `
            display: block;
            margin-bottom: 8px;
            font-weight: bold;
            color: var(--secondary-text);
        `;
        
        const translatedPromptArea = document.createElement('textarea');
        translatedPromptArea.className = 'translated-prompt';
        translatedPromptArea.placeholder = '翻译结果将显示在这里…';
        translatedPromptArea.readOnly = false; // 允许用户编辑
        translatedPromptArea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 10px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
            font-family: inherit;
            resize: vertical;
            box-sizing: border-box;
        `;
        
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = `
            display: flex;
            gap: 10px;
            margin-top: 10px;
        `;
        
        const translateButton = document.createElement('button');
        translateButton.type = 'button';
        translateButton.innerHTML = '🌍 翻译';
        translateButton.style.cssText = `
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        
        const useOriginalButton = document.createElement('button');
        useOriginalButton.type = 'button';
        useOriginalButton.innerHTML = '⬅️ 使用原文';
        useOriginalButton.style.cssText = `
            background: var(--warning-color, #f59e0b);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        
        // 翻译功能
        translateButton.addEventListener('click', async () => {
            const promptTextarea = toolForm.querySelector('textarea[name="prompt"]');
            if (promptTextarea && promptTextarea.value.trim()) {
                const quality = qualitySelect.value;
                const targetLang = languageSelect.value;
                await translatePrompt(promptTextarea.value, translatedPromptArea, translateButton, quality, targetLang);
            } else {
                alert('请先输入提示词');
            }
        });
        
        // 使用原文
        useOriginalButton.addEventListener('click', () => {
            const promptTextarea = toolForm.querySelector('textarea[name="prompt"]');
            if (promptTextarea) {
                translatedPromptArea.value = promptTextarea.value;
            }
        });
        
        buttonGroup.appendChild(translateButton);
        buttonGroup.appendChild(useOriginalButton);
        
        container.appendChild(settingsArea);
        container.appendChild(translatedPromptLabel);
        container.appendChild(translatedPromptArea);
        container.appendChild(buttonGroup);
        
        return container;
    }

    // 翻译提示词
    async function translatePrompt(text, outputTextarea, button, quality = 'gemini-2.5-flash', targetLang = 'en') {
        const originalText = button.innerHTML;
        button.innerHTML = '🔄 翻译中...';
        button.disabled = true;
        
        try {
            // 获取目标语言名称
            const languageMap = {
                'en': '英语',
                'zh': '中文', 
                'ja': '日语',
                'ko': '韩语',
                'fr': '法语',
                'de': '德语',
                'es': '西班牙语'
            };
            
            const targetLanguageText = languageMap[targetLang] || '英语';
            
            // 构建系统提示词（与 VCPChat 翻译模块保持一致）
            const systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguageText}。 仅返回翻译结果，不要包含任何解释或额外信息。`;
            
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ];
            
            // 使用 VCP 的 chat 接口进行翻译
            const chatUrl = VCP_SERVER_URL.replace('/v1/human/tool', '/v1/chat/completions');
            const response = await fetch(chatUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VCP_API_KEY}`
                },
                body: JSON.stringify({
                    messages: messages,
                    model: quality,
                    temperature: 0.7,
                    max_tokens: 50000,
                    stream: false
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`服务器错误: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            const result = await response.json();
            const translation = result.choices?.[0]?.message?.content;
            
            if (translation) {
                outputTextarea.value = translation.trim();
            } else {
                throw new Error('API 返回的响应中没有有效的翻译内容。');
            }
        } catch (error) {
            console.error('翻译失败:', error);
            outputTextarea.value = `翻译失败: ${error.message}\n\n原文: ${text}`;
        } finally {
            button.innerHTML = originalText;
            button.disabled = false;
        }
    }

    // 后备翻译方法（简单的关键词识别）
    async function fallbackTranslate(text) {
        // 这里可以实现一个简单的翻译逻辑或者调用其他翻译服务
        // 目前直接返回原文，用户可以手动修改
        return text;
    }

    // 全部清空功能
    function clearAllFormData(toolName) {
        const confirmed = confirm('确定要清空所有内容吗？包括提示词、翻译内容、图片和额外图片。');
        
        if (!confirmed) return;
        
        // 1. 清空所有输入框
        const inputs = toolForm.querySelectorAll('input, textarea, select');
        inputs.forEach(input => {
            if (input.type === 'checkbox' || input.type === 'radio') {
                input.checked = input.defaultChecked || false;
            } else if (input.tagName === 'SELECT') {
                input.selectedIndex = 0; // 重置为默认选项
            } else {
                input.value = '';
            }
        });
        
        // 2. 清空翻译容器
        const translationContainers = toolForm.querySelectorAll('.translation-container');
        translationContainers.forEach(container => {
            const translatedPrompt = container.querySelector('.translated-prompt');
            if (translatedPrompt) {
                translatedPrompt.value = '';
            }
            // 隐藏翻译容器
            container.style.display = 'none';
        });
        
        // 3. 清空图片预览区域
        const previewAreas = toolForm.querySelectorAll('.image-preview-area');
        previewAreas.forEach(preview => {
            preview.style.display = 'none';
            preview.innerHTML = '';
        });
        
        // 4. 显示所有拖拽区域，隐藏清空按钮
        const dropZones = toolForm.querySelectorAll('.drop-zone');
        const clearButtons = toolForm.querySelectorAll('.clear-image-btn');
        
        dropZones.forEach(dropZone => {
            dropZone.style.display = 'block';
            dropZone.innerHTML = `
                <div class="drop-icon">📁</div>
                <div class="drop-text">拖拽图片文件到此处或点击选择</div>
            `;
            dropZone.style.color = 'var(--secondary-text)';
        });
        
        clearButtons.forEach(btn => {
            btn.style.display = 'none';
        });
        
        // 5. 清空动态图片区域（仅限 NanoBananaGenOR compose 模式）
        if (toolName === 'NanoBananaGenOR') {
            const dynamicContainer = toolForm.querySelector('.dynamic-images-container');
            if (dynamicContainer) {
                const imagesList = dynamicContainer.querySelector('.sortable-images-list');
                if (imagesList) {
                    // 清空所有动态添加的图片
                    const dynamicItems = imagesList.querySelectorAll('.dynamic-image-item');
                    dynamicItems.forEach(item => {
                        item.remove();
                    });
                }
            }
        }
        
        // 6. 清空结果容器
        if (resultContainer) {
            resultContainer.innerHTML = '';
        }
        
        // 7. 显示成功提示
        const successMessage = document.createElement('div');
        successMessage.className = 'success-notification';
        successMessage.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--success-color);
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            z-index: 1000;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        `;
        successMessage.textContent = '✓ 已清空所有内容';
        document.body.appendChild(successMessage);
        
        // 3秒后移除提示
        setTimeout(() => {
            if (successMessage.parentNode) {
                successMessage.classList.add('removing');
                setTimeout(() => {
                    if (successMessage.parentNode) {
                        successMessage.parentNode.removeChild(successMessage);
                    }
                }, 300);
            }
        }, 2700);
    }

    // 显示文件名设置对话框
    function showFilenameSettings() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            justify-content: center;
            align-items: center;
        `;
        
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--card-bg);
            border-radius: 8px;
            padding: 30px;
            width: 90%;
            width: 90%;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
        `;
        
        dialog.innerHTML = `
            <h3 style="margin: 0 0 20px 0; color: var(--primary-text); text-align: center;">文件名显示设置</h3>
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 8px; color: var(--secondary-text); font-weight: bold;">
                    文件名最大长度（超过则省略）：
                </label>
                <input type="number" id="filename-length-input" 
                    value="${MAX_FILENAME_LENGTH}" 
                    min="50" 
                    max="1000" 
                    style="
                        width: 100%;
                        padding: 10px;
                        border: 1px solid var(--border-color);
                        border-radius: 4px;
                        background: var(--input-bg);
                        color: var(--primary-text);
                        font-size: 14px;
                        box-sizing: border-box;
                    "
                >
                <div style="font-size: 12px; color: var(--secondary-text); margin-top: 5px;">
                    建议范围：50-1000 字符，默认为 400
                </div>
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button id="cancel-btn" style="
                    background: var(--secondary-color, #6b7280);
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    cursor: pointer;
                ">取消</button>
                <button id="save-btn" style="
                    background: var(--primary-color);
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    cursor: pointer;
                ">保存</button>
            </div>
        `;
        
        const input = dialog.querySelector('#filename-length-input');
        const cancelBtn = dialog.querySelector('#cancel-btn');
        const saveBtn = dialog.querySelector('#save-btn');
        
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        
        saveBtn.addEventListener('click', async () => {
            const newLength = parseInt(input.value, 10);
            if (newLength >= 50 && newLength <= 1000) {
                MAX_FILENAME_LENGTH = newLength;
                settings.maxFilenameLength = newLength;
                
                try {
                    await saveSettings();
                    
                    // 显示成功提示
                    const successMsg = document.createElement('div');
                    successMsg.className = 'success-notification';
                    successMsg.style.cssText = `
                        position: fixed;
                        top: 20px;
                        right: 20px;
                        background: var(--success-color);
                        color: white;
                        padding: 12px 20px;
                        border-radius: 6px;
                        z-index: 10001;
                        font-size: 14px;
                        font-weight: 500;
                    `;
                    successMsg.textContent = '✓ 设置已保存';
                    document.body.appendChild(successMsg);
                    
                    setTimeout(() => {
                        if (successMsg.parentNode) {
                            successMsg.parentNode.removeChild(successMsg);
                        }
                    }, 2000);
                    
                    document.body.removeChild(overlay);
                } catch (saveError) {
                    console.error('[VCPHumanToolBox] Failed to save settings:', saveError);
                    alert('保存设置失败：' + saveError.message);
                }
            } else {
                alert('请输入 50-1000 之间的数值');
            }
        });
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        
        // 点击背景关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // 设置空区域拖拽上传功能
    function setupEmptyAreaDragDrop(container) {
        let dragCounter = 0;
        
        container.addEventListener('dragenter', (e) => {
            // 只处理文件拖拽，不处理元素拖拽
            if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                
                // 精确检测：只有当拖拽目标不在任何dragdrop-image-container内时才处理
                const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
                if (targetDragDropContainer) {
                    // 如果拖拽目标在已有的图片输入框内，完全不处理，让图片输入框自己处理
                    return;
                }
                
                dragCounter++;
                
                // 如果是空列表，显示拖拽提示
                if (container.children.length === 0) {
                    container.style.borderStyle = 'dashed';
                    container.style.borderColor = 'var(--primary-color)';
                    container.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
                    
                    if (!container.querySelector('.empty-drop-hint')) {
                        const hint = document.createElement('div');
                        hint.className = 'empty-drop-hint';
                        hint.style.cssText = `
                            text-align: center;
                            padding: 40px 20px;
                            color: var(--primary-color);
                            font-size: 16px;
                            font-weight: bold;
                            pointer-events: none;
                        `;
                        hint.innerHTML = `
                            📁 拖拽图片到此处添加<br>
                            <span style="font-size: 14px; font-weight: normal;">将自动作为额外图片添加</span>
                        `;
                        container.appendChild(hint);
                    }
                }
            }
        });
        
        container.addEventListener('dragleave', (e) => {
            if (e.dataTransfer.types.includes('Files')) {
                // 同样的精确检测
                const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
                if (targetDragDropContainer) {
                    return;
                }
                
                dragCounter--;
                
                if (dragCounter === 0) {
                    container.style.borderStyle = '';
                    container.style.borderColor = '';
                    container.style.backgroundColor = '';
                    
                    const hint = container.querySelector('.empty-drop-hint');
                    if (hint) {
                        hint.remove();
                    }
                }
            }
        });
        
        container.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('Files')) {
                // 精确检测：只有当拖拽目标不在任何dragdrop-image-container内时才处理
                const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
                if (targetDragDropContainer) {
                    // 如果在已有的图片输入框内，不阻止默认行为，让图片输入框处理
                    return;
                }
                
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });
        
        container.addEventListener('drop', (e) => {
            if (e.dataTransfer.types.includes('Files')) {
                // 关键修复：精确检测拖拽目标，只有真正拖拽到空白区域才创建新项目
                const targetDragDropContainer = e.target.closest('.dragdrop-image-container');
                if (targetDragDropContainer) {
                    // 如果拖拽目标在已有的图片输入框内，完全不处理，让图片输入框自己处理
                    console.log('[空区域拖拽] 检测到拖拽目标在已有图片输入框内，跳过处理');
                    return;
                }
                
                e.preventDefault();
                e.stopPropagation(); // 阻止事件冒泡，防止重复处理
                dragCounter = 0;
                
                console.log('[空区域拖拽] 在空白区域创建新图片项目');
                
                const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
                if (files.length > 0) {
                    // 清理拖拽状态
                    container.style.borderStyle = '';
                    container.style.borderColor = '';
                    container.style.backgroundColor = '';
                    
                    const hint = container.querySelector('.empty-drop-hint');
                    if (hint) {
                        hint.remove();
                    }
                    
                    // 为每个文件创建新的图片输入框
                    files.forEach((file, index) => {
                        const nextIndex = getNextAvailableImageIndex(container);
                        const newItem = addDynamicImageInput(container, nextIndex);
                        
                        // 等待元素添加到 DOM 后再处理文件
                        setTimeout(() => {
                            const textInput = newItem.querySelector('input[type="text"]');
                            const dropZone = newItem.querySelector('.drop-zone');
                            const previewArea = newItem.querySelector('.image-preview-area');
                            const clearButton = newItem.querySelector('.clear-image-btn');
                            
                            if (textInput && dropZone && previewArea && clearButton) {
                                const canvasButtonsContainer = newItem.querySelector('.canvas-buttons-container');
                                const editCanvasButton = canvasButtonsContainer?.querySelector('.edit-canvas-btn');
                                handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                            }
                        }, 100 + index * 50); // 为多个文件添加时间差
                    });
                }
            }
        });
    }

    // 创建拖拽上传图片输入框
    function createDragDropImageInput(param) {
        const container = document.createElement('div');
        container.className = 'dragdrop-image-container';
        container.style.cssText = `
            position: relative;
            border: 2px dashed var(--border-color);
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            background: var(--input-bg);
            transition: all 0.3s ease;
            min-height: 120px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        `;

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.name = param.name;
        textInput.placeholder = param.placeholder || '';
        textInput.style.cssText = `
            width: 100%;
            margin-bottom: 10px;
            padding: 8px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--text-color);
        `;
        if (param.required) textInput.required = true;

        const contentArea = document.createElement('div');
        contentArea.className = 'upload-content-area';
        contentArea.style.cssText = 'width: 100%; display: flex; flex-direction: column; align-items: center;';

        const dropZone = document.createElement('div');
        dropZone.className = 'drop-zone';
        dropZone.innerHTML = `
            <div class="drop-icon">📁</div>
            <div class="drop-text">拖拽图片文件到此处或点击选择</div>
        `;
        dropZone.style.cssText = `
            cursor: pointer;
            color: var(--secondary-text);
            font-size: 14px;
            padding: 20px;
            width: 100%;
            box-sizing: border-box;
        `;

        const previewArea = document.createElement('div');
        previewArea.className = 'image-preview-area';
        previewArea.style.cssText = `
            display: none;
            width: 100%;
            margin-top: 10px;
            text-align: center;
        `;

        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.innerHTML = '🗑️ 清空';
        clearButton.className = 'clear-image-btn';
        clearButton.style.cssText = `
            display: none;
            background: var(--danger-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            margin: 0 auto;
            transition: all 0.2s ease;
        `;
        
        // 画板编辑按钮容器
        const canvasButtonsContainer = document.createElement('div');
        canvasButtonsContainer.className = 'canvas-buttons-container';
        canvasButtonsContainer.style.cssText = `
            display: none;
            gap: 8px;
            margin-top: 10px;
            justify-content: center;
            flex-wrap: wrap;
        `;
        
        // 空白画板按钮
        const blankCanvasButton = document.createElement('button');
        blankCanvasButton.type = 'button';
        blankCanvasButton.innerHTML = '🎨 空白画板';
        blankCanvasButton.className = 'blank-canvas-btn';
        blankCanvasButton.style.cssText = `
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
        `;
        
        // 幕布编辑按钮
        const editCanvasButton = document.createElement('button');
        editCanvasButton.type = 'button';
        editCanvasButton.innerHTML = '✏️ 幕布编辑';
        editCanvasButton.className = 'edit-canvas-btn';
        editCanvasButton.style.cssText = `
            display: none;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(240, 147, 251, 0.3);
        `;
        
        // 从剪切板粘贴按钮
        const pasteButton = document.createElement('button');
        pasteButton.type = 'button';
        pasteButton.innerHTML = '📋 从剪切板粘贴';
        pasteButton.className = 'paste-clipboard-btn';
        pasteButton.style.cssText = `
            background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(74, 222, 128, 0.3);
        `;
        
        // 还原按钮（仅对 NanoBananaGenOR 工具的 edit 和 compose 命令显示）
        const restoreButton = document.createElement('button');
        restoreButton.type = 'button';
        restoreButton.innerHTML = '🔄还原';
        restoreButton.className = 'restore-image-btn';
        restoreButton.title = '还原到最初粘贴的图片';
        restoreButton.style.cssText = `
            display: none;
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
        `;
        
        canvasButtonsContainer.appendChild(blankCanvasButton);
        canvasButtonsContainer.appendChild(editCanvasButton);
        canvasButtonsContainer.appendChild(pasteButton);
        canvasButtonsContainer.appendChild(restoreButton);

        // 文件选择输入
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        // 点击选择文件
        dropZone.addEventListener('click', () => {
            fileInput.click();
        });

        // 清空按钮事件
        clearButton.addEventListener('click', () => {
            clearImageInput(textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
        });
        
        // 空白画板按钮事件
        blankCanvasButton.addEventListener('click', () => {
            console.log('[空白画板] 点击事件触发');
            try {
                openCanvasEditor(null, (canvasDataUrl) => {
                    console.log('[空白画板] 画板完成回调');
                    // 画板完成后的回调
                    const blob = dataURLToBlob(canvasDataUrl);
                    const file = new File([blob], 'canvas-drawing.png', { type: 'image/png' });
                    handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                });
            } catch (error) {
                console.error('[空白画板] 错误:', error);
                showNotification('打开画板失败: ' + error.message, 'error');
            }
        });
        
        // 幕布编辑按钮事件
        editCanvasButton.addEventListener('click', () => {
            console.log('[幕布编辑] 点击事件触发');
            try {
                // 获取原图的完整数据而不是预览缩略图
                const fullImageData = textInput.dataset.fullValue; // 使用完整的Base64数据
                console.log('[幕布编辑] 原图数据:', fullImageData ? '存在' : '不存在');
                if (fullImageData) {
                    openCanvasEditor(fullImageData, (canvasDataUrl) => {
                        console.log('[幕布编辑] 编辑完成回调');
                        // 编辑完成后的回调
                        const blob = dataURLToBlob(canvasDataUrl);
                        const file = new File([blob], 'edited-image.png', { type: 'image/png' });
                        handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                    });
                } else {
                    showNotification('没有可编辑的图片', 'warning');
                }
            } catch (error) {
                console.error('[幕布编辑] 错误:', error);
                showNotification('打开幕布编辑失败: ' + error.message, 'error');
            }
        });

        // 从剪切板粘贴按钮事件
        pasteButton.addEventListener('click', async () => {
            try {
                await pasteImageFromClipboard(textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
            } catch (error) {
                console.error('从剪切板粘贴图片失败:', error);
                showNotification('📋 剪切板中没有图片或粘贴失败', 'warning');
            }
        });
        
        // 还原按钮事件（仅对 NanoBananaGenOR 的 edit 和 compose 命令）
        restoreButton.addEventListener('click', () => {
            const originalValue = textInput.dataset.originalValue;
            if (originalValue) {
                textInput.value = originalValue;
                textInput.dataset.fullValue = originalValue;
                
                // 创建临时文件对象用于重新初始化显示
                const blob = dataURLToBlob(originalValue);
                const fileName = `restored-image-${Date.now()}.png`;
                const file = new File([blob], fileName, { type: 'image/png' });
                
                // 重新初始化显示和功能，但不更改originalValue
                const originalValueBackup = textInput.dataset.originalValue;
                handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                // 恢复原始值（防止handleImageFile覆盖）
                setTimeout(() => {
                    textInput.dataset.originalValue = originalValueBackup;
                }, 100);
                
                showNotification('✅ 已还原到初始图片', 'success');
            } else {
                showNotification('❌ 没有可还原的初始图片', 'error');
            }
        });
        
        // 文件选择处理
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
            }
        });

        // 拖拽事件处理 - 增强事件管理，防止冲突
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止事件冒泡到父容器
            container.style.borderColor = 'var(--primary-color)';
            container.style.background = 'var(--primary-color-alpha)';
        });

        container.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止事件冒泡到父容器
            container.style.borderColor = 'var(--border-color)';
            container.style.background = 'var(--input-bg)';
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 关键：阻止事件冒泡，防止空区域处理器重复处理
            
            console.log('[单个图片输入框] 处理拖拽替换');
            
            container.style.borderColor = 'var(--border-color)';
            container.style.background = 'var(--input-bg)';
            
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            if (files.length > 0) {
                handleImageFile(files[0], textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
            }
        });

        contentArea.appendChild(dropZone);
        contentArea.appendChild(previewArea);
        contentArea.appendChild(clearButton);
        contentArea.appendChild(canvasButtonsContainer);
        
        container.appendChild(textInput);
        container.appendChild(contentArea);
        container.appendChild(fileInput);
        
        // 显示画板按钮（始终显示空白画板按钮）
        canvasButtonsContainer.style.display = 'flex';

        return container;
    }

    // 从剪切板粘贴图片功能
    async function pasteImageFromClipboard(textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton) {
        if (!navigator.clipboard || !navigator.clipboard.read) {
            throw new Error('浏览器不支持剪切板API');
        }
        
        try {
            const clipboardItems = await navigator.clipboard.read();
            
            for (const clipboardItem of clipboardItems) {
                for (const type of clipboardItem.types) {
                    if (type.startsWith('image/')) {
                        const blob = await clipboardItem.getType(type);
                        const file = new File([blob], `clipboard-image.${type.split('/')[1]}`, { type });
                        
                        // 显示成功通知
                        showNotification('✅ 已从剪切板粘贴图片', 'success');
                        
                        // 处理图片文件
                        handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                        return;
                    }
                }
            }
            
            throw new Error('剪切板中没有图片');
        } catch (error) {
            throw new Error(`剪切板读取失败: ${error.message}`);
        }
    }
    
    // 显示通知消息
    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `${type}-notification`;
        
        const bgColors = {
            success: 'var(--success-color)',
            warning: 'var(--warning-color, #f59e0b)',
            error: 'var(--danger-color)',
            info: 'var(--primary-color)'
        };
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${bgColors[type]};
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            z-index: 10001;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            max-width: 300px;
            word-wrap: break-word;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        // 动画效果
        setTimeout(() => {
            notification.classList.add('removing');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }

    // 处理图片文件 - 更新以支持画板编辑功能
    function handleImageFile(file, textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton) {
        if (!file) {
            console.error('没有提供文件对象。');
            return;
        }

        // 1. 显示加载状态
        dropZone.style.display = 'none';
        previewArea.style.display = 'block';
        clearButton.style.display = 'none';
        if (canvasButtonsContainer) canvasButtonsContainer.style.display = 'none';
        if (editCanvasButton) editCanvasButton.style.display = 'none';
        
        previewArea.innerHTML = `
            <div class="loading-spinner-container" style="display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--secondary-text); padding: 20px;">
                <div class="loading-spinner" style="border: 4px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: var(--primary-color); width: 30px; height: 30px; animation: spin 1s linear infinite; margin-bottom: 10px;"></div>
                <span>正在读取文件...</span>
            </div>
        `;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            const dataUrl = e.target.result;

            // 2. 存储完整 Data URL 到隐藏属性
            textInput.dataset.fullValue = dataUrl;
            
            // 保存原始图片数据（用于还原功能）
            // 为 NanoBananaGenOR 工具的 edit 和 compose 命令也保存原始数据
            const isNanoBananaEdit = textInput.name === 'image_url';
            const isNanoBananaCompose = textInput.name === 'image_url_1' || textInput.name.startsWith('image_url_');
            
            if (isNanoBananaEdit || isNanoBananaCompose) {
                // 直接在文本输入框上保存原始值
                if (!textInput.dataset.originalValue) {
                    textInput.dataset.originalValue = dataUrl;
                }
            } else {
                // 保持原有的额外图像逻辑
                const imageItem = textInput.closest('.dynamic-image-item');
                if (imageItem && !imageItem.dataset.originalValue) {
                    imageItem.dataset.originalValue = dataUrl;
                }
            }

            // 3. 创建用于 UI 显示的截断值
            const sizeInBytes = file.size;
            const sizeInKB = (sizeInBytes / 1024).toFixed(1);
            const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(2);
            const displaySize = sizeInBytes > 1024 * 512 ? `${sizeInMB} MB` : `${sizeInKB} KB`;
            const truncatedBase64 = dataUrl.substring(0, 40);
            const displayValue = `${truncatedBase64}... [${displaySize}]`;
            textInput.value = displayValue;
            
            // 4. 更新预览
            let displayName = file.name;
            if (file.name.length > MAX_FILENAME_LENGTH) {
                const extension = file.name.split('.').pop();
                const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.'));
                const truncatedName = nameWithoutExt.substring(0, MAX_FILENAME_LENGTH - extension.length - 4) + '...';
                displayName = truncatedName + '.' + extension;
            }
            previewArea.innerHTML = `
                <img src="${dataUrl}" style="max-width: 100%; max-height: 150px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 8px; display: block; margin-left: auto; margin-right: auto;" alt="Preview">
                <div class="file-name" style="font-size: 12px; color: var(--secondary-text); word-wrap: break-word; word-break: break-all; line-height: 1.4; max-width: 100%; text-align: center; padding: 0 10px; font-family: monospace;">${displayName}</div>
            `;
            clearButton.style.display = 'inline-block';
            
            // 5. 显示画板编辑功能
            if (canvasButtonsContainer) {
                canvasButtonsContainer.style.display = 'flex';
            }
            if (editCanvasButton) {
                editCanvasButton.style.display = 'inline-block';
            }
            
            // 显示还原按钮（仅对 NanoBananaGenOR 工具的 edit 和 compose 命令）
            const restoreButton = canvasButtonsContainer?.querySelector('.restore-image-btn');
            if (restoreButton && (isNanoBananaEdit || isNanoBananaCompose)) {
                restoreButton.style.display = 'inline-block';
            }
        };

        reader.onerror = function(error) {
            console.error('FileReader 读取文件失败:', error);
            previewArea.innerHTML = `<div class="error-message" style="color: var(--danger-color); padding: 20px;">错误: 无法读取文件。</div>`;
            setTimeout(() => {
                clearImageInput(textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
            }, 3000);
        };

        reader.readAsDataURL(file);
    }

    // 清空图片输入 - 更新以支持画板编辑功能
    function clearImageInput(textInput, dropZone, previewArea, clearButton, canvasButtonsContainer, editCanvasButton) {
        textInput.value = '';
        textInput.dataset.fullValue = '';
        
        // 清空时重置原始值，等待下一个图片设置为初始
        const imageItem = textInput.closest('.dynamic-image-item');
        if (imageItem) {
            delete imageItem.dataset.originalValue;
        }
        
        // 清空主图片输入框的原始值（NanoBananaGenOR工具用）
        if (textInput.dataset.originalValue) {
            delete textInput.dataset.originalValue;
        }
        
        dropZone.style.display = 'block';
        previewArea.style.display = 'none';
        clearButton.style.display = 'none';
        
        // 隐藏幕布编辑按钮，但保持空白画板按钮显示
        if (editCanvasButton) {
            editCanvasButton.style.display = 'none';
        }
        if (canvasButtonsContainer) {
            canvasButtonsContainer.style.display = 'flex';
        }
        
        // 重置拖拽区域内容
        dropZone.innerHTML = `
            <div class="drop-icon">📁</div>
            <div class="drop-text">拖拽图片文件到此处或点击选择</div>
        `;
        dropZone.style.color = 'var(--secondary-text)';
    }

    // 创建动态图片管理容器
    function createDynamicImageContainer(container) {
        const dynamicContainer = document.createElement('div');
        dynamicContainer.className = 'dynamic-images-container';
        dynamicContainer.innerHTML = `
            <div class="dynamic-images-header">
                <h4>额外图片</h4>
                <div class="header-buttons">
                    <button type="button" class="add-image-btn">➕ 添加图片</button>
                    <button type="button" class="clear-all-images-btn">🗑️ 一键清空</button>
                </div>
            </div>
            <div class="sortable-images-list" id="sortable-images-list"></div>
        `;
        
        dynamicContainer.style.cssText = `
            margin-top: 20px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
            background: var(--card-bg);
        `;
        
        // 设置header样式
        const header = dynamicContainer.querySelector('.dynamic-images-header');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        `;
        
        const headerButtons = dynamicContainer.querySelector('.header-buttons');
        headerButtons.style.cssText = `
            display: flex;
            gap: 10px;
        `;

        const addButton = dynamicContainer.querySelector('.add-image-btn');
        const clearAllButton = dynamicContainer.querySelector('.clear-all-images-btn');
        const imagesList = dynamicContainer.querySelector('.sortable-images-list');
        let imageCounter = 2; // 从 image_url_2 开始

        addButton.style.cssText = `
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        `;
        
        clearAllButton.style.cssText = `
            background: var(--danger-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        `;

        addButton.addEventListener('click', () => {
            const nextIndex = getNextAvailableImageIndex(imagesList);
            addDynamicImageInput(imagesList, nextIndex);
        });
        
        clearAllButton.addEventListener('click', () => {
            clearAllAdditionalImages(imagesList);
        });

        // 初始化拖拽排序
        makeSortable(imagesList);
        
        // 添加空区域拖拽上传功能
        setupEmptyAreaDragDrop(imagesList);
        
        container.appendChild(dynamicContainer);
    }

    // 一键清空所有额外图片
    function clearAllAdditionalImages(container) {
        const imageItems = container.querySelectorAll('.dynamic-image-item');
        
        if (imageItems.length === 0) {
            // 显示提示消息
            const infoMessage = document.createElement('div');
            infoMessage.className = 'info-notification';
            infoMessage.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: var(--warning-color, #f59e0b);
                color: white;
                padding: 12px 20px;
                border-radius: 6px;
                z-index: 1000;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
            `;
            infoMessage.textContent = 'ℹ️ 没有额外图片需要清空';
            document.body.appendChild(infoMessage);
            
            setTimeout(() => {
                if (infoMessage.parentNode) {
                    infoMessage.parentNode.removeChild(infoMessage);
                }
            }, 2000);
            return;
        }
        
        // 显示确认对话框
        const confirmed = confirm(`确定要清空所有 ${imageItems.length} 张额外图片吗？此操作不可撤销。`);
        
        if (!confirmed) {
            return;
        }
        
        // 清空所有动态图片项
        imageItems.forEach(item => {
            item.remove();
        });
        
        // 显示成功提示
        const successMessage = document.createElement('div');
        successMessage.className = 'success-notification';
        successMessage.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--success-color);
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            z-index: 1000;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        `;
        successMessage.textContent = `✓ 已清空 ${imageItems.length} 张额外图片`;
        document.body.appendChild(successMessage);
        
        // 3秒后移除提示
        setTimeout(() => {
            if (successMessage.parentNode) {
                successMessage.classList.add('removing');
                setTimeout(() => {
                    if (successMessage.parentNode) {
                        successMessage.parentNode.removeChild(successMessage);
                    }
                }, 300);
            }
        }, 2700);
    }

    // 获取下一个可用的图片索引
    function getNextAvailableImageIndex(container) {
        const existingItems = container.querySelectorAll('.dynamic-image-item');
        const usedIndices = Array.from(existingItems).map(item => {
            return parseInt(item.dataset.index, 10);
        }).filter(index => !isNaN(index));
        
        // 从 2 开始查找第一个未使用的索引
        for (let i = 2; i <= usedIndices.length + 2; i++) {
            if (!usedIndices.includes(i)) {
                return i;
            }
        }
        
        // 如果所有索引都被使用，返回下一个
        return Math.max(...usedIndices, 1) + 1;
    }

    // 添加动态图片输入框
    function addDynamicImageInput(container, index) {
        const imageItem = document.createElement('div');
        imageItem.className = 'dynamic-image-item';
        imageItem.dataset.index = index;
        imageItem.style.cssText = `
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin-bottom: 15px;
            padding: 10px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: var(--input-bg);
        `;

        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.innerHTML = '☰';
        dragHandle.draggable = false; // 手柄本身不可拖拽
        dragHandle.style.cssText = `
            cursor: move;
            color: var(--secondary-text);
            font-size: 18px;
            padding: 5px;
            user-select: none;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 30px;
        `;

        const inputContainer = document.createElement('div');
        inputContainer.style.cssText = 'flex: 1;';
        
        const label = document.createElement('label');
        label.textContent = `图片 ${index}`;
        label.style.cssText = `
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        `;

        const dragDropInput = createDragDropImageInput({
            name: `image_url_${index}`,
            placeholder: `第${index}张图片`,
            required: false
        });

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.innerHTML = '❌';
        removeButton.className = 'remove-image-btn';
        removeButton.style.cssText = `
            background: var(--danger-color);
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            align-self: flex-start;
            margin-top: 5px;
            transition: all 0.2s ease;
            margin-bottom: 5px;
        `;
        
        const restoreButton = document.createElement('button');
        restoreButton.type = 'button';
        restoreButton.innerHTML = '🔄还原';
        restoreButton.className = 'restore-image-btn';
        restoreButton.title = '还原到最初粘贴的图片';
        restoreButton.style.cssText = `
            display: none;
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            align-self: flex-start;
            transition: all 0.2s ease;
        `;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 5px;
            align-self: flex-start;
            margin-top: 5px;
        `;
        
        // 存储初始图片数据
        const textInput = dragDropInput.querySelector('input[type="text"]');
        
        removeButton.addEventListener('click', () => {
            imageItem.remove();
            // 删除后重新编排所有图片的编号
            updateImageIndicesAfterSort(container);
        });
        
        restoreButton.addEventListener('click', () => {
            const originalValue = imageItem.dataset.originalValue;
            if (originalValue) {
                textInput.value = originalValue;
                textInput.dataset.fullValue = originalValue;
                
                // 创建临时文件对象用于重新初始化显示
                const blob = dataURLToBlob(originalValue);
                const fileName = `restored-image-${Date.now()}.png`;
                const file = new File([blob], fileName, { type: 'image/png' });
                
                // 重新初始化显示和功能
                const dragDropInput = imageItem.querySelector('.dragdrop-image-container');
                const previewArea = dragDropInput.querySelector('.image-preview-area');
                const clearButton = dragDropInput.querySelector('.clear-image-btn');
                const canvasButtonsContainer = dragDropInput.querySelector('.canvas-buttons-container');
                const editCanvasButton = dragDropInput.querySelector('.edit-canvas-btn');
                
                // 重新处理文件显示，但不更改originalValue
                const originalValueBackup = imageItem.dataset.originalValue;
                handleImageFile(file, textInput, dragDropInput.querySelector('.drop-zone'), previewArea, clearButton, canvasButtonsContainer, editCanvasButton);
                // 恢复原始值（防止handleImageFile覆盖）
                setTimeout(() => {
                    imageItem.dataset.originalValue = originalValueBackup;
                }, 100);
                
                showCanvasNotification('✅ 已还原到初始图片', 'success');
            } else {
                showCanvasNotification('❌ 没有可还原的初始图片', 'error');
            }
        });

        inputContainer.appendChild(label);
        inputContainer.appendChild(dragDropInput);
        buttonContainer.appendChild(removeButton);
        // 不再添加多余的还原按钮 - buttonContainer.appendChild(restoreButton);
        imageItem.appendChild(dragHandle);
        imageItem.appendChild(inputContainer);
        imageItem.appendChild(buttonContainer);
        
        container.appendChild(imageItem);
        
        // 隐藏 dragDropInput 中 canvas buttons container 里的重复🔄按钮
        const canvasRestoreButton = dragDropInput.querySelector('.canvas-buttons-container .restore-image-btn');
        if (canvasRestoreButton) {
            canvasRestoreButton.style.display = 'none';
        }
        
        return imageItem; // 返回创建的元素，供外部使用
    }

    // 更新图片索引
    function updateImageIndices(container) {
        const items = container.querySelectorAll('.dynamic-image-item');
        items.forEach((item, index) => {
            const newIndex = index + 2; // 从 image_url_2 开始
            item.dataset.index = newIndex;
            
            const label = item.querySelector('label');
            label.textContent = `图片 ${newIndex}`;
            
            const input = item.querySelector('input[type="text"]');
            input.name = `image_url_${newIndex}`;
            
            const placeholder = `第${newIndex}张图片`;
            input.placeholder = placeholder;
        });
    }

    // --- 画板编辑器功能 ---
    
    // DataURL 转 Blob 工具函数
    function dataURLToBlob(dataURL) {
        const arr = dataURL.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    }
    
    // 打开画板编辑器
    function openCanvasEditor(backgroundImageSrc, onComplete) {
        console.log('[画板编辑器] 开始创建模态框');
        try {
            const modal = createCanvasEditorModal(backgroundImageSrc, onComplete);
            document.body.appendChild(modal);
            
            // 禁用背景滚动
            document.body.style.overflow = 'hidden';
            
            // 显示模态框
            setTimeout(() => {
                modal.classList.add('show');
                console.log('[画板编辑器] 模态框显示完成');
            }, 50);
        } catch (error) {
            console.error('[画板编辑器] 创建失败:', error);
            throw error;
        }
    }
    
    // 创建画板编辑器模态框
    function createCanvasEditorModal(backgroundImageSrc, onComplete) {
        console.log('[画板编辑器] 开始创建模态框元素');
        const modal = document.createElement('div');
        modal.className = 'canvas-editor-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        
        const editorContainer = document.createElement('div');
        editorContainer.className = 'canvas-editor-container';
        editorContainer.style.cssText = `
            background: var(--card-bg);
            border-radius: 12px;
            padding: 20px;
            max-width: 98vw;
            max-height: 98vh;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
        `;
        
        // 标题和关闭按钮
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--border-color);
        `;
        
        const title = document.createElement('h3');
        title.textContent = backgroundImageSrc ? '🖼️ 幕布编辑' : '🎨 空白画板';
        title.style.cssText = `
            margin: 0;
            color: var(--primary-text);
            font-size: 18px;
            font-weight: 600;
        `;
        
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '✕';
        closeButton.style.cssText = `
            background: none;
            border: none;
            font-size: 20px;
            color: var(--secondary-text);
            cursor: pointer;
            padding: 5px;
            border-radius: 4px;
            transition: all 0.2s ease;
        `;
        
        header.appendChild(title);
        header.appendChild(closeButton);
        
        // 工具栏
        const toolbar = createCanvasToolbar();
        
        // 画板区域容器
        const canvasContainer = document.createElement('div');
        canvasContainer.style.cssText = `
            display: flex;
            justify-content: flex-start;
            align-items: flex-start;
            margin: 20px 0;
            border: 2px dashed var(--border-color);
            border-radius: 8px;
            padding: 20px;
            background: #f8f9fa;
            overflow: auto;
            max-width: 100%;
            max-height: 70vh;
            position: relative;
            width: 100%;
        `;
        
        // 创建画布 - 根据模式决定尺寸和处理方式
        const canvas = document.createElement('canvas');
        
        if (backgroundImageSrc) {
            // 幕布编辑模式：使用图片原始大小，不进行缩放
            const tempImg = new Image();
            tempImg.onload = function() {
                // 直接使用原图尺寸，不进行任何缩放
                const originalWidth = tempImg.width;
                const originalHeight = tempImg.height;
                
                // 设置画布尺寸为原图尺寸
                canvas.width = originalWidth;
                canvas.height = originalHeight;
                canvas.style.cssText = `
                    border: 2px solid #3b82f6;
                    border-radius: 8px;
                    cursor: crosshair;
                    background: white;
                    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
                    display: block;
                    flex-shrink: 0;
                `;
                
                // 立即加载并绘制背景图片
                const ctx = canvas.getContext('2d');
                ctx.drawImage(tempImg, 0, 0, originalWidth, originalHeight);
                
                // 存储编辑相关信息
                canvas.dataset.isCanvasEditor = 'true';
                canvas.dataset.originalWidth = originalWidth;
                canvas.dataset.originalHeight = originalHeight;
                
                console.log(`[幕布编辑] 使用原始尺寸: ${originalWidth}x${originalHeight}`);
                
                // 初始化编辑器（延迟执行以确保画布已完全设置）
                setTimeout(() => {
                    if (modal.canvasEditor) {
                        modal.canvasEditor.initializeForImageEditing(tempImg, originalWidth, originalHeight);
                    }
                }, 50);
            };
            tempImg.src = backgroundImageSrc;
        } else {
            // 空白画板模式：显示分辨率选择器
            showCanvasSizeSelector(canvas, canvasContainer);
        }
        
        canvasContainer.appendChild(canvas);
        
        // 操作按钮
        const actionButtons = createCanvasActionButtons();
        
        editorContainer.appendChild(header);
        editorContainer.appendChild(toolbar);
        editorContainer.appendChild(canvasContainer);
        editorContainer.appendChild(actionButtons);
        modal.appendChild(editorContainer);
        
        // 初始化画板功能
        const canvasEditor = new CanvasEditor(canvas, toolbar, backgroundImageSrc);
        modal.canvasEditor = canvasEditor; // 将编辑器实例保存到模态框上
        
        // 事件绑定
        closeButton.addEventListener('click', () => {
            closeCanvasEditor(modal);
        });
        
        actionButtons.querySelector('.save-btn').addEventListener('click', () => {
            // 保持原图品质，避免过度压缩
            let quality = 1.0; // 使用最高质量
            let format = 'image/png'; // 默认使用PNG格式保持无损压缩
            
            // 只有在图像非常大时才考虑使用JPEG格式，并使用较高的质量
            const canvasArea = canvas.width * canvas.height;
            if (canvasArea > 4147200) { // 大于2048x2048时才使用JPEG
                format = 'image/jpeg';
                quality = 0.95; // 使用高质量JPEG
            }
            
            const dataUrl = canvas.toDataURL(format, quality);
            onComplete(dataUrl);
            closeCanvasEditor(modal);
        });
        
        actionButtons.querySelector('.copy-btn').addEventListener('click', async () => {
            try {
                await copyCanvasToClipboard(canvas);
                showCanvasNotification('✅ 已复制到剪切板', 'success');
            } catch (error) {
                console.error('复制到剪切板失败:', error);
                showCanvasNotification('❌ 复制失败，请检查浏览器支持', 'error');
            }
        });
        
        actionButtons.querySelector('.undo-btn').addEventListener('click', () => {
            canvasEditor.undo();
        });
        
        actionButtons.querySelector('.redo-btn').addEventListener('click', () => {
            canvasEditor.redo();
        });
        
        actionButtons.querySelector('.reset-btn').addEventListener('click', () => {
            if (confirm('确定要复原到最初始状态吗？这将清除所有编辑内容。')) {
                canvasEditor.resetToOriginal();
            }
        });
        
        // ESC 键关闭
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                closeCanvasEditor(modal);
            }
        };
        document.addEventListener('keydown', handleEsc);
        modal.dataset.escHandler = 'true';
        
        return modal;
    }
    
    // 关闭画板编辑器
    function closeCanvasEditor(modal) {
        // 清理画板编辑器
        const canvasEditor = modal.canvasEditor;
        if (canvasEditor) {
            canvasEditor.cleanup();
        }
        
        modal.classList.remove('show');
        document.body.style.overflow = '';
        
        setTimeout(() => {
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
            // 移除 ESC 事件监听
            if (modal.dataset.escHandler) {
                const handleEsc = (e) => {
                    if (e.key === 'Escape') {
                        closeCanvasEditor(modal);
                    }
                };
                document.removeEventListener('keydown', handleEsc);
            }
        }, 300);
    }
    
    // 创建工具栏
    function createCanvasToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'canvas-toolbar';
        toolbar.style.cssText = `
            display: flex;
            gap: 15px;
            padding: 15px;
            background: var(--input-bg);
            border-radius: 8px;
            border: 1px solid var(--border-color);
            flex-wrap: wrap;
            align-items: center;
        `;
        
        // 工具选择
        const toolsGroup = document.createElement('div');
        toolsGroup.innerHTML = `
            <label style="color: var(--secondary-text); font-weight: 500; margin-right: 10px;">工具：</label>
            <select class="tool-select" style="padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--card-bg); color: var(--primary-text);">
                <option value="brush">🖌 画笔</option>
                <option value="line">− 直线</option>
                <option value="arrow">→ 箭头</option>
                <option value="rectangle">□ 方框</option>
                <option value="text">🅰️ 文字</option>
            </select>
        `;
        
        // 颜色选择
        const colorGroup = document.createElement('div');
        colorGroup.innerHTML = `
            <label style="color: var(--secondary-text); font-weight: 500; margin-right: 10px;">颜色：</label>
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="color-presets" style="display: flex; gap: 4px; margin-right: 8px;">
                    <button class="color-preset" data-color="#ff0000" style="width: 24px; height: 24px; background: #ff0000; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="红色"></button>
                    <button class="color-preset" data-color="#00ff00" style="width: 24px; height: 24px; background: #00ff00; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="绿色"></button>
                    <button class="color-preset" data-color="#0000ff" style="width: 24px; height: 24px; background: #0000ff; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="蓝色"></button>
                    <button class="color-preset" data-color="#ffff00" style="width: 24px; height: 24px; background: #ffff00; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="黄色"></button>
                    <button class="color-preset" data-color="#ff00ff" style="width: 24px; height: 24px; background: #ff00ff; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="紫色"></button>
                    <button class="color-preset" data-color="#000000" style="width: 24px; height: 24px; background: #000000; border: 2px solid #fff; border-radius: 4px; cursor: pointer; box-shadow: 0 0 0 1px #ccc;" title="黑色"></button>
                </div>
                <input type="color" class="color-picker" value="#ff0000" style="width: 40px; height: 30px; border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">
                <input type="text" class="color-hex-input" value="#FF0000" placeholder="#FF0000" style="width: 80px; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: 4px; font-family: monospace; text-transform: uppercase;">
            </div>
        `;
        
        // 线条粗细
        const sizeGroup = document.createElement('div');
        sizeGroup.innerHTML = `
            <label style="color: var(--secondary-text); font-weight: 500; margin-right: 10px;">粗细：</label>
            <input type="range" class="size-slider" min="1" max="20" value="3" style="width: 100px;">
            <span class="size-display" style="color: var(--primary-text); margin-left: 8px; font-weight: 500;">3px</span>
        `;
        
        // 文字大小（仅文字工具可见）
        const textSizeGroup = document.createElement('div');
        textSizeGroup.className = 'text-size-group';
        textSizeGroup.style.display = 'none';
        textSizeGroup.innerHTML = `
            <label style="color: var(--secondary-text); font-weight: 500; margin-right: 10px;">字号：</label>
            <input type="range" class="text-size-slider" min="12" max="48" value="16" style="width: 100px;">
            <span class="text-size-display" style="color: var(--primary-text); margin-left: 8px; font-weight: 500;">16px</span>
        `;
        
        toolbar.appendChild(toolsGroup);
        toolbar.appendChild(colorGroup);
        toolbar.appendChild(sizeGroup);
        toolbar.appendChild(textSizeGroup);
        
        // 工具切换事件
        const toolSelect = toolbar.querySelector('.tool-select');
        const textSizeGroupElement = toolbar.querySelector('.text-size-group');
        
        toolSelect.addEventListener('change', (e) => {
            if (e.target.value === 'text') {
                textSizeGroupElement.style.display = 'flex';
                textSizeGroupElement.style.alignItems = 'center';
                textSizeGroupElement.style.gap = '8px';
            } else {
                textSizeGroupElement.style.display = 'none';
            }
        });
        
        // 粗细滑块事件
        const sizeSlider = toolbar.querySelector('.size-slider');
        const sizeDisplay = toolbar.querySelector('.size-display');
        sizeSlider.addEventListener('input', (e) => {
            sizeDisplay.textContent = e.target.value + 'px';
        });
        
        // 文字大小滑块事件
        const textSizeSlider = toolbar.querySelector('.text-size-slider');
        const textSizeDisplay = toolbar.querySelector('.text-size-display');
        textSizeSlider.addEventListener('input', (e) => {
            textSizeDisplay.textContent = e.target.value + 'px';
        });
        
        // 颜色相关事件监听
        const colorPicker = toolbar.querySelector('.color-picker');
        const colorHexInput = toolbar.querySelector('.color-hex-input');
        const colorPresets = toolbar.querySelectorAll('.color-preset');
        
        // 颜色选择器事件
        colorPicker.addEventListener('change', () => {
            colorHexInput.value = colorPicker.value.toUpperCase();
            updateColorPresetSelection(colorPicker.value, colorPresets);
        });
        
        // HEX 输入框事件
        colorHexInput.addEventListener('input', () => {
            let hex = colorHexInput.value.trim();
            if (hex.startsWith('#') && (hex.length === 4 || hex.length === 7)) {
                colorPicker.value = hex;
                updateColorPresetSelection(hex, colorPresets);
            }
        });
        
        colorHexInput.addEventListener('blur', () => {
            let hex = colorHexInput.value.trim();
            if (!hex.startsWith('#')) {
                hex = '#' + hex;
            }
            
            // 验证 HEX 格式
            const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
            if (hexRegex.test(hex)) {
                colorPicker.value = hex;
                colorHexInput.value = hex.toUpperCase();
                updateColorPresetSelection(hex, colorPresets);
            } else {
                // 恢复到当前颜色选择器的值
                colorHexInput.value = colorPicker.value.toUpperCase();
            }
        });
        
        // 颜色预设按钮事件
        colorPresets.forEach(preset => {
            preset.addEventListener('click', () => {
                const color = preset.dataset.color;
                colorPicker.value = color;
                colorHexInput.value = color.toUpperCase();
                updateColorPresetSelection(color, colorPresets);
            });
        });
        
        // 默认选中红色
        updateColorPresetSelection('#ff0000', colorPresets);
        
        // 颜色预设选中状态更新函数
        function updateColorPresetSelection(color, presets) {
            presets.forEach(p => p.style.boxShadow = '0 0 0 1px #ccc');
            const matchingPreset = Array.from(presets).find(p => p.dataset.color.toLowerCase() === color.toLowerCase());
            if (matchingPreset) {
                matchingPreset.style.boxShadow = '0 0 0 2px #3b82f6';
            }
        }
        
        return toolbar;
    }
    
    // 创建操作按钮
    function createCanvasActionButtons() {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 15px;
            justify-content: center;
            margin-top: 20px;
        `;
        
        const saveButton = document.createElement('button');
        saveButton.className = 'save-btn';
        saveButton.innerHTML = '✓ 保存';
        saveButton.style.cssText = `
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
        `;
        
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-btn';
        copyButton.innerHTML = '📋 复制到剪切板';
        copyButton.style.cssText = `
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
        `;
        
        const undoButton = document.createElement('button');
        undoButton.className = 'undo-btn';
        undoButton.innerHTML = '↶ 撤销';
        undoButton.style.cssText = `
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(139, 92, 246, 0.3);
        `;
        
        const redoButton = document.createElement('button');
        redoButton.className = 'redo-btn';
        redoButton.innerHTML = '↷ 重做';
        redoButton.style.cssText = `
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
        `;
        
        const resetButton = document.createElement('button');
        resetButton.className = 'reset-btn';
        resetButton.innerHTML = '🔄 复原';
        resetButton.style.cssText = `
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
        `;
        resetButton.title = '恢复到最初始状态，清除所有编辑';
        
        buttonContainer.appendChild(saveButton);
        buttonContainer.appendChild(copyButton);
        buttonContainer.appendChild(undoButton);
        buttonContainer.appendChild(redoButton);
        buttonContainer.appendChild(resetButton);
        
        return buttonContainer;
    }
    
    // 显示画布尺寸选择器
    function showCanvasSizeSelector(canvas, canvasContainer) {
        const sizeSelector = document.createElement('div');
        sizeSelector.className = 'canvas-size-selector';
        sizeSelector.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            padding: 20px;
            background: var(--card-bg);
            border: 2px dashed var(--border-color);
            border-radius: 8px;
            min-width: 400px;
        `;
        
        const title = document.createElement('h4');
        title.textContent = '🎨 选择画布尺寸';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: rgba(0, 0, 0, 0.9);
            font-size: 16px;
            font-weight: 600;
        `;
        
        // 预设尺寸选项
        const presetsContainer = document.createElement('div');
        presetsContainer.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 10px;
            width: 100%;
            margin-bottom: 15px;
        `;
        
        const presets = [
            { name: '默认', width: 600, height: 400, desc: '600×400' },
            { name: 'HD', width: 1280, height: 720, desc: '1280×720' },
            { name: 'Full HD', width: 1920, height: 1080, desc: '1920×1080' },
            { name: '4K', width: 3840, height: 2160, desc: '3840×2160' },
            { name: 'A4', width: 2480, height: 3508, desc: '2480×3508 (300dpi)' },
            { name: '正方形', width: 800, height: 800, desc: '800×800' },
            { name: '手机竖屏', width: 1080, height: 1920, desc: '1080×1920' },
            { name: '微信封面', width: 900, height: 500, desc: '900×500' }
        ];
        
        presets.forEach(preset => {
            const button = document.createElement('button');
            button.innerHTML = `<strong style="color: rgba(0, 0, 0, 0.85);">${preset.name}</strong><br><small style="color: rgba(0, 0, 0, 0.8);">${preset.desc}</small>`;
            button.style.cssText = `
                padding: 12px 8px;
                border: 2px solid var(--border-color);
                background: var(--card-bg);
                color: rgba(0, 0, 0, 0.8);
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                text-align: center;
                transition: all 0.2s ease;
                min-height: 60px;
            `;
            
            button.addEventListener('mouseenter', () => {
                button.style.borderColor = 'var(--primary-color)';
                button.style.background = 'var(--hover-bg, rgba(59, 130, 246, 0.1))';
            });
            
            button.addEventListener('mouseleave', () => {
                button.style.borderColor = 'var(--border-color)';
                button.style.background = 'var(--card-bg)';
            });
            
            button.addEventListener('click', () => {
                createCanvasWithSize(canvas, preset.width, preset.height, sizeSelector, canvasContainer);
            });
            
            presetsContainer.appendChild(button);
        });
        
        // 自定义尺寸输入
        const customContainer = document.createElement('div');
        customContainer.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
        `;
        
        const customLabel = document.createElement('label');
        customLabel.textContent = '自定义：';
        customLabel.style.cssText = `
            color: rgba(0, 0, 0, 0.85);
            font-weight: 600;
        `;
        
        const widthInput = document.createElement('input');
        widthInput.type = 'number';
        widthInput.placeholder = '宽度';
        widthInput.value = '800';
        widthInput.min = '100';
        widthInput.max = '10000';
        widthInput.style.cssText = `
            width: 80px;
            padding: 6px 8px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        const xLabel = document.createElement('span');
        xLabel.textContent = '×';
        xLabel.style.cssText = `
            color: rgba(0, 0, 0, 0.8);
            font-weight: 600;
            font-size: 16px;
        `;
        
        const heightInput = document.createElement('input');
        heightInput.type = 'number';
        heightInput.placeholder = '高度';
        heightInput.value = '600';
        heightInput.min = '100';
        heightInput.max = '10000';
        heightInput.style.cssText = widthInput.style.cssText;
        
        const dpiLabel = document.createElement('label');
        dpiLabel.textContent = 'DPI:';
        dpiLabel.style.cssText = `
            color: rgba(0, 0, 0, 0.85);
            font-weight: 600;
            margin-left: 10px;
        `;
        
        const dpiInput = document.createElement('input');
        dpiInput.type = 'number';
        dpiInput.value = '72';
        dpiInput.min = '72';
        dpiInput.max = '600';
        dpiInput.style.cssText = `
            width: 60px;
            padding: 6px 8px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--primary-text);
        `;
        
        const createButton = document.createElement('button');
        createButton.textContent = '创建画布';
        createButton.style.cssText = `
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            margin-left: 10px;
        `;
        
        createButton.addEventListener('click', () => {
            const width = parseInt(widthInput.value) || 800;
            const height = parseInt(heightInput.value) || 600;
            const dpi = parseInt(dpiInput.value) || 72;
            
            // DPI 转换（参考用，不影响实际像素尺寸）
            canvas.dataset.dpi = dpi;
            
            createCanvasWithSize(canvas, width, height, sizeSelector, canvasContainer);
        });
        
        customContainer.appendChild(customLabel);
        customContainer.appendChild(widthInput);
        customContainer.appendChild(xLabel);
        customContainer.appendChild(heightInput);
        customContainer.appendChild(dpiLabel);
        customContainer.appendChild(dpiInput);
        customContainer.appendChild(createButton);
        
        sizeSelector.appendChild(title);
        sizeSelector.appendChild(presetsContainer);
        sizeSelector.appendChild(customContainer);
        
        canvasContainer.appendChild(sizeSelector);
    }
    
    // 创建指定尺寸的画布
    function createCanvasWithSize(canvas, width, height, sizeSelector, canvasContainer) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.cssText = `
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: crosshair;
            background: white;
            display: block;
            flex-shrink: 0;
        `;
        canvas.dataset.isCanvasEditor = 'true';
        
        // 获取画布编辑器实例并更新预览画布尺寸
        const modal = canvas.closest('.canvas-editor-modal');
        if (modal && modal.canvasEditor) {
            modal.canvasEditor.updateCanvasSize(width, height);
        }
        
        // 移除选择器，显示画布
        sizeSelector.remove();
        canvasContainer.appendChild(canvas);
        
        console.log(`[空白画板] 创建画布: ${width}x${height}px`);
    }
    
    // 画板编辑器类
    class CanvasEditor {
        constructor(canvas, toolbar, backgroundImageSrc) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.toolbar = toolbar;
            this.isDrawing = false;
            this.startX = 0;
            this.startY = 0;
            this.currentPath = [];
            this.backgroundImageSrc = backgroundImageSrc;
            this.activeTextInput = null;
            this.isImageEditingMode = !!backgroundImageSrc; // 标记是否为幕布编辑模式
            
            // 初始化历史记录系统
            this.history = [];
            this.historyStep = -1;
            this.maxHistorySize = 50;
            
            // 创建预览画布
            this.previewCanvas = document.createElement('canvas');
            this.previewCanvas.width = canvas.width;
            this.previewCanvas.height = canvas.height;
            this.previewCtx = this.previewCanvas.getContext('2d');
            
            this.init();
            
            // 如果是空白画板模式，立即保存初始状态
            if (!backgroundImageSrc) {
                this.saveState();
            }
        }
        
        // 专门为幕布编辑模式初始化
        initializeForImageEditing(originalImage, displayWidth, displayHeight) {
            console.log('[幕布编辑] 初始化图片编辑模式（原始尺寸）');
            
            // 移除编辑范围限制，允许在整个画布上编辑
            
            // 更新预览画布尺寸为原始尺寸
            this.previewCanvas.width = displayWidth;
            this.previewCanvas.height = displayHeight;
            
            // 保存原始图片数据（用于“仅清除编辑痕迹”和“复原”功能）
            this.originalImageData = this.ctx.getImageData(0, 0, displayWidth, displayHeight);
            this.originalImage = originalImage;
            this.displayWidth = displayWidth;
            this.displayHeight = displayHeight;
            
            // 保存初始状态
            this.saveState();
            
            console.log(`[幕布编辑] 初始化完成 - 全画布可编辑: ${displayWidth}x${displayHeight} (原始尺寸)`);
        }
        
        init() {
            // 绑定事件
            this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
            this.canvas.addEventListener('mousemove', this.draw.bind(this));
            this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
            this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));
            this.canvas.addEventListener('click', this.handleCanvasClick.bind(this));
            
            // 禁止右键菜单
            this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            
            // 键盘事件监听（用于文字输入）
            document.addEventListener('keydown', this.handleKeyDown.bind(this));
        }
        
        // 更新画布尺寸（用于空白画布创建后的尺寸同步）
        updateCanvasSize(width, height) {
            // 更新预览画布尺寸
            this.previewCanvas.width = width;
            this.previewCanvas.height = height;
            
            // 清空历史记录并保存初始状态
            this.history = [];
            this.historyStep = -1;
            this.saveState();
            
            console.log(`[画布编辑器] 更新尺寸: ${width}x${height}px`);
        }
        
        saveState() {
            this.historyStep++;
            if (this.historyStep < this.history.length) {
                this.history.length = this.historyStep;
            }
            this.history.push(this.canvas.toDataURL());
            
            // 限制历史记录数量
            if (this.history.length > this.maxHistorySize) {
                this.history.shift();
                this.historyStep--;
            }
        }
        
        undo() {
            if (this.historyStep > 0) {
                this.historyStep--;
                this.restoreState(this.history[this.historyStep]);
            }
        }
        
        redo() {
            if (this.historyStep < this.history.length - 1) {
                this.historyStep++;
                this.restoreState(this.history[this.historyStep]);
            }
        }
        
        restoreState(dataURL) {
            const img = new Image();
            img.onload = () => {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(img, 0, 0);
            };
            img.src = dataURL;
        }
        
        loadBackgroundImage(imageSrc) {
            // 这个方法现在仅用于兼容性，实际的幕布编辑初始化由 initializeForImageEditing 处理
            if (!this.isImageEditingMode) {
                console.warn('[警告] loadBackgroundImage 被调用，但当前不是幕布编辑模式');
                return;
            }
            
            const img = new Image();
            img.onload = () => {
                // 清空画板
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                
                // 绘制背景图片
                this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
                
                // 保存原始图片数据
                this.originalImageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                this.backgroundImageSrc = imageSrc;
                
                // 移除编辑边界限制，允许在整个画布上编辑
                
                this.saveState();
                console.log(`[幕布编辑] 背景图片加载完成，编辑区域: ${this.canvas.width}x${this.canvas.height}`);
            };
            img.src = imageSrc;
        }
        
        getCurrentTool() {
            return this.toolbar.querySelector('.tool-select').value;
        }
        
        getCurrentColor() {
            return this.toolbar.querySelector('.color-picker').value;
        }
        
        getCurrentSize() {
            return parseInt(this.toolbar.querySelector('.size-slider').value);
        }
        
        getCurrentTextSize() {
            return parseInt(this.toolbar.querySelector('.text-size-slider').value);
        }
        
        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // 移除幕布编辑限制，允许在整个画布区域编辑
            return { x, y, outOfBounds: false };
        }
        
        startDrawing(e) {
            const tool = this.getCurrentTool();
            if (tool === 'text') return; // 文字工具使用点击事件
            
            const pos = this.getMousePos(e);
            
            // 移除边界检查，允许在整个画布上绘制
            
            this.isDrawing = true;
            this.startX = pos.x;
            this.startY = pos.y;
            
            // 保存当前状态作为预览基础
            // 确保预览画布尺寸与主画布一致
            if (this.previewCanvas.width !== this.canvas.width || this.previewCanvas.height !== this.canvas.height) {
                this.previewCanvas.width = this.canvas.width;
                this.previewCanvas.height = this.canvas.height;
            }
            this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
            this.previewCtx.drawImage(this.canvas, 0, 0);
            
            if (tool === 'brush') {
                this.ctx.beginPath();
                this.ctx.moveTo(pos.x, pos.y);
                this.currentPath = [{ x: pos.x, y: pos.y }];
            }
        }
        
        draw(e) {
            if (!this.isDrawing) return;
            
            const tool = this.getCurrentTool();
            const pos = this.getMousePos(e);
            
            // 移除边界限制，允许在整个画布上绘制
            
            this.ctx.lineWidth = this.getCurrentSize();
            this.ctx.strokeStyle = this.getCurrentColor();
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            
            if (tool === 'brush') {
                // 画笔直接绘制
                this.ctx.lineTo(pos.x, pos.y);
                this.ctx.stroke();
                this.currentPath.push({ x: pos.x, y: pos.y });
            } else {
                // 其他工具使用实时预览
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(this.previewCanvas, 0, 0);
                
                // 设置绘制参数
                this.ctx.lineWidth = this.getCurrentSize();
                this.ctx.strokeStyle = this.getCurrentColor();
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';
                
                switch (tool) {
                    case 'line':
                        this.drawLine(this.startX, this.startY, pos.x, pos.y);
                        break;
                    case 'arrow':
                        this.drawArrow(this.startX, this.startY, pos.x, pos.y);
                        break;
                    case 'rectangle':
                        this.drawRectangle(this.startX, this.startY, pos.x, pos.y);
                        break;
                }
            }
        }
        
        stopDrawing(e) {
            if (!this.isDrawing) return;
            this.isDrawing = false;
            
            const tool = this.getCurrentTool();
            
            // 非画笔工具需要保存状态
            if (tool !== 'brush') {
                this.saveState();
            } else {
                // 画笔工具在结束时保存状态
                this.saveState();
            }
        }
        
        drawLine(x1, y1, x2, y2) {
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
        }
        
        drawArrow(x1, y1, x2, y2) {
            const headlen = 15; // 箭头长度
            const angle = Math.atan2(y2 - y1, x2 - x1);
            
            // 绘制主线
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
            
            // 绘制箭头
            this.ctx.beginPath();
            this.ctx.moveTo(x2, y2);
            this.ctx.lineTo(
                x2 - headlen * Math.cos(angle - Math.PI / 6),
                y2 - headlen * Math.sin(angle - Math.PI / 6)
            );
            this.ctx.moveTo(x2, y2);
            this.ctx.lineTo(
                x2 - headlen * Math.cos(angle + Math.PI / 6),
                y2 - headlen * Math.sin(angle + Math.PI / 6)
            );
            this.ctx.stroke();
        }
        
        drawRectangle(x1, y1, x2, y2) {
            const width = x2 - x1;
            const height = y2 - y1;
            
            this.ctx.beginPath();
            this.ctx.rect(x1, y1, width, height);
            this.ctx.stroke();
        }
        
        handleCanvasClick(e) {
            const tool = this.getCurrentTool();
            if (tool !== 'text') return;
            
            // 先移除之前的文字输入框
            this.removeActiveTextInput();
            
            const pos = this.getMousePos(e);
            
            // 移除边界限制，允许在整个画布上创建文字输入
            
            this.createTextInput(pos.x, pos.y);
        }
        
        createTextInput(x, y) {
            const textInput = document.createElement('textarea');
            textInput.className = 'canvas-text-input';
            
            // 获取画布在父容器中的位置偏移
            const canvasContainer = this.canvas.parentElement;
            const canvasRect = this.canvas.getBoundingClientRect();
            const parentRect = canvasContainer.getBoundingClientRect();
            
            // 计算文本框在父容器中的绝对位置
            const absoluteX = (canvasRect.left - parentRect.left) + x;
            const absoluteY = (canvasRect.top - parentRect.top) + y;
            
            // 创建可拖动的容器
            const textContainer = document.createElement('div');
            textContainer.className = 'canvas-text-container';
            textContainer.style.cssText = `
                position: absolute;
                left: ${absoluteX}px;
                top: ${absoluteY}px;
                z-index: 1001;
                cursor: move;
                border: 2px solid var(--primary-color);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.9);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                min-width: 100px;
                min-height: 30px;
            `;
            
            // 获取当前文字大小并应用
            const currentTextSize = this.getCurrentTextSize();
            const currentColor = this.getCurrentColor();
            
            textInput.style.cssText = `
                width: 100%;
                height: 100%;
                min-width: 100px;
                min-height: 30px;
                border: none;
                background: transparent;
                padding: 4px 8px;
                font-size: ${currentTextSize}px;
                font-family: Arial, sans-serif;
                color: ${currentColor};
                resize: both;
                outline: none;
                cursor: text;
            `;
            
            textInput.placeholder = '输入文字，Enter结束，Shift+Enter换行';
            
            textContainer.appendChild(textInput);
            
            // 将容器添加到画布父容器
            canvasContainer.style.position = 'relative';
            canvasContainer.appendChild(textContainer);
            
            this.activeTextInput = textInput;
            this.activeTextContainer = textContainer;
            
            // 添加拖动功能
            this.makeDraggable(textContainer, textInput);
            
            // 监听工具栏字号变化，实时更新文字输入框
            this.setupTextSizeListener(textInput);
            
            textInput.focus();
        }
        
        // 设置字号实时监听
        setupTextSizeListener(textInput) {
            const textSizeSlider = this.toolbar.querySelector('.text-size-slider');
            const colorPicker = this.toolbar.querySelector('.color-picker');
            
            // 字号实时更新
            const updateTextInputStyle = () => {
                if (this.activeTextInput) {
                    this.activeTextInput.style.fontSize = this.getCurrentTextSize() + 'px';
                    this.activeTextInput.style.color = this.getCurrentColor();
                }
            };
            
            // 移除之前的监听器（避免重复绑定）
            if (this.textSizeListener) {
                textSizeSlider.removeEventListener('input', this.textSizeListener);
            }
            if (this.colorChangeListener) {
                colorPicker.removeEventListener('change', this.colorChangeListener);
            }
            
            // 添加新的监听器
            this.textSizeListener = updateTextInputStyle;
            this.colorChangeListener = updateTextInputStyle;
            
            textSizeSlider.addEventListener('input', this.textSizeListener);
            colorPicker.addEventListener('change', this.colorChangeListener);
        }
        
        handleKeyDown(e) {
            if (this.activeTextInput && e.target === this.activeTextInput) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.commitTextInput();
                }
            }
        }
        
        commitTextInput() {
            if (!this.activeTextInput || !this.activeTextContainer) return;
            
            const text = this.activeTextInput.value.trim();
            if (text) {
                const containerRect = this.activeTextContainer.getBoundingClientRect();
                const canvasRect = this.canvas.getBoundingClientRect();
                
                const x = containerRect.left - canvasRect.left;
                const y = containerRect.top - canvasRect.top;
                
                // 绘制文字到画布
                this.ctx.font = `${this.getCurrentTextSize()}px Arial`;
                this.ctx.fillStyle = this.getCurrentColor();
                this.ctx.textBaseline = 'top';
                
                // 处理多行文字
                const lines = text.split('\n');
                const lineHeight = this.getCurrentTextSize() * 1.2;
                
                lines.forEach((line, index) => {
                    this.ctx.fillText(line, x + 8, y + 4 + index * lineHeight); // 加上 padding 偏移
                });
                
                this.saveState();
            }
            
            this.removeActiveTextInput();
        }
        
        removeActiveTextInput() {
            if (this.activeTextContainer) {
                this.activeTextContainer.remove();
                this.activeTextContainer = null;
            }
            if (this.activeTextInput) {
                this.activeTextInput = null;
            }
        }
        
        // 使文字容器可拖动
        makeDraggable(container, textInput) {
            let isDragging = false;
            let startX, startY, startLeft, startTop;
            
            container.addEventListener('mousedown', (e) => {
                // 只有在容器边框区域才开始拖动，避免干扰文字输入
                if (e.target === container) {
                    isDragging = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    
                    // 获取当前容器的位置（相对于父容器）
                    const containerStyle = window.getComputedStyle(container);
                    startLeft = parseInt(containerStyle.left) || 0;
                    startTop = parseInt(containerStyle.top) || 0;
                    
                    container.style.cursor = 'grabbing';
                    e.preventDefault();
                }
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    const deltaX = e.clientX - startX;
                    const deltaY = e.clientY - startY;
                    
                    const newLeft = startLeft + deltaX;
                    const newTop = startTop + deltaY;
                    
                    // 边界检查：确保不超出画布范围
                    const canvasRect = this.canvas.getBoundingClientRect();
                    const parentRect = container.parentElement.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    
                    // 计算画布在父容器中的边界
                    const canvasLeft = canvasRect.left - parentRect.left;
                    const canvasTop = canvasRect.top - parentRect.top;
                    const canvasRight = canvasLeft + this.canvas.width;
                    const canvasBottom = canvasTop + this.canvas.height;
                    
                    // 限制在画布范围内
                    const constrainedLeft = Math.max(canvasLeft, Math.min(newLeft, canvasRight - containerRect.width));
                    const constrainedTop = Math.max(canvasTop, Math.min(newTop, canvasBottom - containerRect.height));
                    
                    container.style.left = constrainedLeft + 'px';
                    container.style.top = constrainedTop + 'px';
                }
            });
            
            document.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    container.style.cursor = 'move';
                }
            });
        }
        
        resetToOriginal() {
            if (this.isImageEditingMode && this.originalImage) {
                // 完全复原到最初始状态，清除所有编辑痕迹
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(this.originalImage, 0, 0, this.displayWidth, this.displayHeight);
                
                // 重新保存原始数据
                this.originalImageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                
                // 清空历史记录并重新开始
                this.history = [];
                this.historyStep = -1;
                this.saveState();
                
                console.log('[幕布编辑] 已复原到最初始状态');
            } else {
                // 空白画板模式：直接清空并重置历史
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.history = [];
                this.historyStep = -1;
                this.saveState();
            }
        }
        
        cleanup() {
            // 清理事件监听和文字输入框
            document.removeEventListener('keydown', this.handleKeyDown.bind(this));
            this.removeActiveTextInput();
            
            // 清理字号实时监听器
            if (this.textSizeListener) {
                const textSizeSlider = this.toolbar.querySelector('.text-size-slider');
                if (textSizeSlider) {
                    textSizeSlider.removeEventListener('input', this.textSizeListener);
                }
            }
            if (this.colorChangeListener) {
                const colorPicker = this.toolbar.querySelector('.color-picker');
                if (colorPicker) {
                    colorPicker.removeEventListener('change', this.colorChangeListener);
                }
            }
        }
    }
    
    // 复制画板内容到剪切板
    async function copyCanvasToClipboard(canvas) {
        console.log('[画板复制] 开始复制画布内容, 尺寸:', canvas.width, 'x', canvas.height);
        
        // 检查浏览器支持
        if (!navigator.clipboard) {
            const error = '浏览器不支持剪切板API';
            console.error('[画板复制] 错误:', error);
            throw new Error(error);
        }
        
        try {
            console.log('[画板复制] 检查 navigator.clipboard.write 支持:', !!navigator.clipboard.write);
            
            // 方法1：使用 ClipboardItem (推荐)
            if (navigator.clipboard.write) {
                return new Promise((resolve, reject) => {
                    // 优化复制质量，根据图片类型和尺寸调整压缩
                    let quality = 0.95; // 提高默认质量
                    let format = 'image/png';
                    
                    const canvasArea = canvas.width * canvas.height;
                    console.log('[画板复制] 画布面积:', canvasArea);
                    
                    if (canvasArea > 444194304) { 
                        format = 'image/jpeg';
                        quality = 0.90;
                        console.log('[画板复制] 使用 JPEG 格式, 质量: 0.90');
                    } else if (canvasArea > 442073600) { 
                        format = 'image/jpeg';
                        quality = 0.93;
                        console.log('[画板复制] 使用 JPEG 格式, 质量: 0.93');
                    } else {
                        console.log('[画板复制] 使用 PNG 格式, 质量: 0.95');
                    }
                    
                    console.log('[画板复制] 开始转换为 Blob...');
                    canvas.toBlob(async (blob) => {
                        if (!blob) {
                            const error = '无法生成图片数据';
                            console.error('[画板复制] 错误:', error);
                            reject(new Error(error));
                            return;
                        }
                        
                        console.log('[画板复制] Blob 生成成功, 类型:', blob.type, '大小:', blob.size, 'bytes');
                        
                        try {
                            const clipboardItem = new ClipboardItem({
                                [blob.type]: blob
                            });
                            
                            console.log('[画板复制] 创建 ClipboardItem 成功, 开始写入剪贴板...');
                            await navigator.clipboard.write([clipboardItem]);
                            console.log('[画板复制] 写入剪贴板成功!');
                            resolve();
                        } catch (error) {
                            console.error('[画板复制] 写入剪贴板失败:', error);
                            reject(error);
                        }
                    }, format, quality);
                });
            }
            
            // 方法2：fallback 到 writeText (data URL)
            else if (navigator.clipboard.writeText) {
                console.log('[画板复制] 使用备用方法 writeText');
                const dataUrl = canvas.toDataURL('image/png', 0.95);
                console.log('[画板复制] 生成 data URL, 大小:', dataUrl.length, '字符');
                await navigator.clipboard.writeText(dataUrl);
                console.log('[画板复制] writeText 成功');
                return;
            }
            
            // 如果都不支持
            else {
                const error = '浏览器不支持剪切板写入操作';
                console.error('[画板复制] 错误:', error);
                throw new Error(error);
            }
            
        } catch (error) {
            console.error('[画板复制] 复制到剪切板失败:', error);
            throw new Error(`复制失败: ${error.message}`);
        }
    }
    
    // 画板编辑器内的通知显示
    function showCanvasNotification(message, type = 'info') {
        // 检查是否已有通知，如有则先移除
        const existingNotification = document.querySelector('.canvas-notification');
        if (existingNotification) {
            existingNotification.remove();
        }
        
        const notification = document.createElement('div');
        notification.className = `canvas-notification ${type}-notification`;
        
        const bgColors = {
            success: '#10b981',
            warning: '#f59e0b', 
            error: '#ef4444',
            info: '#3b82f6'
        };
        
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${bgColors[type]};
            color: white;
            padding: 16px 24px;
            border-radius: 8px;
            z-index: 10002;
            font-size: 16px;
            font-weight: 600;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
            text-align: center;
            min-width: 200px;
            animation: canvasNotificationShow 0.3s ease-out;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        // 2秒后自动消失
        setTimeout(() => {
            notification.style.animation = 'canvasNotificationHide 0.3s ease-in';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 2000);
    }

    // 实现拖拽排序功能（重新设计，避免与拖拽上传冲突）
    function makeSortable(container) {
        let draggedElement = null;
        let isDraggingForSort = false;
        let startY = 0;
        let startX = 0;
        const threshold = 5; // 拖拽阀值，超过这个距离才认为是排序拖拽

        // 使用鼠标事件而不是 HTML5 拖拽 API，避免冲突
        container.addEventListener('mousedown', (e) => {
            const dragHandle = e.target.closest('.drag-handle');
            if (dragHandle && e.button === 0) { // 只处理左键
                e.preventDefault();
                draggedElement = dragHandle.closest('.dynamic-image-item');
                if (draggedElement) {
                    startY = e.clientY;
                    startX = e.clientX;
                    isDraggingForSort = false;
                    
                    // 添加全局事件监听
                    document.addEventListener('mousemove', handleMouseMove);
                    document.addEventListener('mouseup', handleMouseUp);
                    
                    // 禁止选中文本
                    document.body.style.userSelect = 'none';
                }
            }
        });

        function handleMouseMove(e) {
            if (!draggedElement) return;
            
            const deltaY = Math.abs(e.clientY - startY);
            const deltaX = Math.abs(e.clientX - startX);
            
            // 只有当鼠标移动超过阀值时才开始拖拽排序
            if (!isDraggingForSort && (deltaY > threshold || deltaX > threshold)) {
                isDraggingForSort = true;
                
                // 增强拖拽元素的视觉效果
                draggedElement.style.opacity = '0.8';
                draggedElement.style.transform = 'rotate(2deg) scale(1.02)';
                draggedElement.style.zIndex = '1000';
                draggedElement.style.boxShadow = '0 8px 32px rgba(59, 130, 246, 0.3), 0 0 0 2px rgba(59, 130, 246, 0.5)';
                draggedElement.style.borderRadius = '8px';
                draggedElement.classList.add('dragging');
                
                // 创建一个可视化的拖拽指示器
                const indicator = document.createElement('div');
                indicator.className = 'drag-indicator';
                indicator.style.cssText = `
                    position: absolute;
                    background: linear-gradient(90deg, 
                        transparent 0%, 
                        rgba(59, 130, 246, 0.8) 20%, 
                        rgba(59, 130, 246, 1) 50%, 
                        rgba(59, 130, 246, 0.8) 80%, 
                        transparent 100%);
                    border-radius: 2px;
                    z-index: 1001;
                    transition: all 0.2s ease;
                    pointer-events: none;
                    animation: dragPulse 1.5s ease-in-out infinite;
                `;
                container.appendChild(indicator);
            }
            
            if (isDraggingForSort) {
                // 更新拖拽指示器位置
                const indicator = container.querySelector('.drag-indicator');
                const afterElement = getDragAfterElement(container, e.clientY);
                
                // 清除之前的高亮效果
                container.querySelectorAll('.dynamic-image-item').forEach(item => {
                    if (item !== draggedElement) {
                        item.classList.remove('drag-target-hover');
                    }
                });
                
                if (afterElement) {
                    const rect = afterElement.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    indicator.style.top = (rect.top - containerRect.top - 2) + 'px';
                    indicator.style.left = '10px';
                    indicator.style.width = 'calc(100% - 20px)';
                    indicator.style.height = '4px';
                    
                    // 高亮目标元素
                    afterElement.classList.add('drag-target-hover');
                } else {
                    // 在最后一个元素之后
                    const lastItem = container.querySelector('.dynamic-image-item:last-child');
                    if (lastItem && lastItem !== draggedElement) {
                        const rect = lastItem.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();
                        indicator.style.top = (rect.bottom - containerRect.top + 2) + 'px';
                        indicator.style.left = '10px';
                        indicator.style.width = 'calc(100% - 20px)';
                        indicator.style.height = '4px';
                        
                        // 高亮最后一个元素
                        lastItem.classList.add('drag-target-hover');
                    }
                }
            }
        }

        function handleMouseUp(e) {
            if (draggedElement && isDraggingForSort) {
                // 执行拖拽排序
                const afterElement = getDragAfterElement(container, e.clientY);
                if (afterElement) {
                    container.insertBefore(draggedElement, afterElement);
                } else {
                    container.appendChild(draggedElement);
                }
                
                // 更新序号
                updateImageIndicesAfterSort(container);
            }
            
            // 清理
            if (draggedElement) {
                draggedElement.style.opacity = '';
                draggedElement.style.transform = '';
                draggedElement.style.zIndex = '';
                draggedElement.style.boxShadow = '';
                draggedElement.style.borderRadius = '';
                draggedElement.classList.remove('dragging');
            }
            
            // 清除所有高亮效果
            container.querySelectorAll('.dynamic-image-item').forEach(item => {
                item.classList.remove('drag-target-hover');
            });
            
            const indicator = container.querySelector('.drag-indicator');
            if (indicator) {
                indicator.remove();
            }
            
            draggedElement = null;
            isDraggingForSort = false;
            document.body.style.userSelect = '';
            
            // 移除全局事件监听
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        }

        // 为新添加的元素设置样式
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1 && node.classList.contains('dynamic-image-item')) {
                        const dragHandle = node.querySelector('.drag-handle');
                        if (dragHandle) {
                            dragHandle.style.cursor = 'move';
                            dragHandle.title = '拖拽调整顺序';
                        }
                    }
                });
            });
        });
        
        observer.observe(container, { childList: true });
    }

    // 拖拽排序后更新图片序号
    function updateImageIndicesAfterSort(container) {
        const items = container.querySelectorAll('.dynamic-image-item');
        items.forEach((item, index) => {
            const newIndex = index + 2; // 从 image_url_2 开始
            item.dataset.index = newIndex;
            
            const label = item.querySelector('label');
            label.textContent = `图片 ${newIndex}`;
            
            const input = item.querySelector('input[type="text"]');
            input.name = `image_url_${newIndex}`;
            
            const placeholder = `第${newIndex}张图片`;
            input.placeholder = placeholder;
            
            // 更新拖拽输入框内的占位符
            const dragDropContainer = item.querySelector('.dragdrop-image-container');
            if (dragDropContainer) {
                const textInput = dragDropContainer.querySelector('input[type="text"]');
                if (textInput) {
                    textInput.name = `image_url_${newIndex}`;
                    textInput.placeholder = placeholder;
                }
            }
        });
    }

    // 获取拖拽后的位置
    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.dynamic-image-item:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    async function executeTool(toolName) {
        const formData = new FormData(toolForm);
        const args = {};

        // 收集表单数据, 特别处理图片输入
        for (let [key, value] of formData.entries()) {
            const inputElement = toolForm.querySelector(`[name="${key}"]`);
            if (inputElement) {
                if (inputElement.type === 'checkbox') {
                    args[key] = inputElement.checked;
                } else if (inputElement.dataset.fullValue) { // 检查是否存在完整的 Base64 值
                    args[key] = inputElement.dataset.fullValue;
                } else if (value) {
                    args[key] = value;
                }
            }
        }
        
        // 正确处理 radio group
        const radioGroups = toolForm.querySelectorAll('.radio-group');
        radioGroups.forEach(group => {
            const selected = group.querySelector('input:checked');
            if (selected) {
                args[selected.name] = selected.value;
            }
        });

        // 处理翻译
        if (toolName === 'NanoBananaGenOR') {
            if (args['enable_translation']) {
                const translatedPrompt = toolForm.querySelector('.translated-prompt');
                if (translatedPrompt && translatedPrompt.value.trim()) {
                    args.prompt = translatedPrompt.value.trim();
                }
            }
        }
        
        resultContainer.innerHTML = '<div class="loading">正在执行... (通过主进程代理)</div>';

        try {
            // 通过 IPC 将整个请求交由主进程处理
            const result = await ipcRenderer.invoke('vcp-ht-execute-tool-proxy', {
                url: VCP_SERVER_URL,
                apiKey: VCP_API_KEY,
                toolName: toolName,
                userName: USER_NAME,
                args: args
            });

            if (result.success) {
                renderResult(result.data, toolName);
            } else {
                throw new Error(result.error);
            }

        } catch (error) {
            console.error('Error executing tool via proxy:', error);
            resultContainer.innerHTML = `<div class="error">执行出错: ${error.message}</div>`;
        }
    }

    function attachEventListenersToImages(container) {
        const images = container.querySelectorAll('img');
        images.forEach(img => {
            // Prevent adding the listener multiple times
            if (img.dataset.contextMenuAttached) return;

            img.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // 创建自定义上下文菜单，使用画板中经过测试的复制方法
                showImageContextMenu(e, img.src);
            });
            img.dataset.contextMenuAttached = 'true';
        });
    }

    // 显示图片上下文菜单
    function showImageContextMenu(event, imageSrc) {
        // 移除已存在的菜单
        const existingMenu = document.querySelector('.image-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // 创建上下文菜单
        const menu = document.createElement('div');
        menu.className = 'image-context-menu';
        menu.style.cssText = `
            position: fixed;
            z-index: 10000;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            padding: 5px 0;
            min-width: 150px;
        `;

        // 复制图片选项已移除 - 根据用户要求移除幕布中的复制功能

        // 保存图片选项
        const saveOption = document.createElement('div');
        saveOption.className = 'context-menu-item';
        saveOption.innerHTML = '💾 保存图片';
        saveOption.style.cssText = `
            padding: 8px 16px;
            cursor: pointer;
            color: var(--primary-text);
            transition: background-color 0.2s;
        `;
        saveOption.addEventListener('mouseenter', () => {
            saveOption.style.backgroundColor = 'var(--highlight-color, #3b82f6)';
            saveOption.style.color = 'white';
        });
        saveOption.addEventListener('mouseleave', () => {
            saveOption.style.backgroundColor = 'transparent';
            saveOption.style.color = 'var(--primary-text)';
        });
        saveOption.addEventListener('click', () => {
            // 使用原有的下载功能
            ipcRenderer.send('show-image-context-menu', imageSrc);
            menu.remove();
        });

        // 只保留保存选项，移除复制选项
        menu.appendChild(saveOption);

        // 定位菜单
        const x = event.clientX;
        const y = event.clientY;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        document.body.appendChild(menu);

        // 点击其他地方关闭菜单
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
                document.removeEventListener('contextmenu', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
            document.addEventListener('contextmenu', closeMenu);
        }, 0);
    }

    // copyImageToClipboardFromUrl 函数已移除 - 该函数仅用于幕布复制功能
    // 画板中的复制功能使用 copyCanvasToClipboard 函数，保持不变

    function renderResult(data, toolName) {
        resultContainer.innerHTML = '';
    
        // 1. Handle errors first
        if (data.status === 'error' || data.error) {
            const errorMessage = data.error || data.message || '未知错误';
            const pre = document.createElement('pre');
            pre.className = 'error';
            pre.textContent = typeof errorMessage === 'object' ? JSON.stringify(errorMessage, null, 2) : errorMessage;
            resultContainer.appendChild(pre);
            return; // Exit on error, no images to process
        }
    
        // 2. Extract the core content, handling nested JSON from certain tools
        let content = data.result || data.message || data;
        if (content && typeof content.content === 'string') {
            try {
                const parsedContent = JSON.parse(content.content);
                // Prioritize 'original_plugin_output' as it often contains the final, formatted result.
                content = parsedContent.original_plugin_output || parsedContent;
            } catch (e) {
                // If it's not a valid JSON string, just use the string from 'content' property.
                content = content.content;
            }
        }
    
        // 3. Render content based on its type
        if (content == null) {
            const p = document.createElement('p');
            p.textContent = '插件执行完毕，但没有返回明确内容。';
            resultContainer.appendChild(p);
        } else if (content && Array.isArray(content.content)) { // Multi-modal content (e.g., from GPT-4V)
            content.content.forEach(item => {
                if (item.type === 'text') {
                    const pre = document.createElement('pre');
                    pre.textContent = item.text;
                    resultContainer.appendChild(pre);
                } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                    const imgElement = document.createElement('img');
                    imgElement.src = item.image_url.url;
                    resultContainer.appendChild(imgElement);
                }
            });
        } else if (typeof content === 'string' && (content.startsWith('data:image') || /\.(jpg|jpeg|png|gif|webp)$/i.test(content))) { // Direct image URL string
            const imgElement = document.createElement('img');
            imgElement.src = content;
            resultContainer.appendChild(imgElement);
        } else if (typeof content === 'string') { // Markdown/HTML string
            const div = document.createElement('div');
            // Use marked to render markdown, which will also render raw HTML like <img> tags
            div.innerHTML = marked(content);
            resultContainer.appendChild(div);
        } else if (toolName === 'TavilySearch' && content && (content.results || content.images)) {
            const searchResultsWrapper = document.createElement('div');
            searchResultsWrapper.className = 'tavily-search-results';

            // Render images
            if (content.images && content.images.length > 0) {
                const imagesContainer = document.createElement('div');
                imagesContainer.className = 'tavily-images-container';
                content.images.forEach(image => {
                    const imageWrapper = document.createElement('figure');
                    imageWrapper.className = 'tavily-image-wrapper';
                    const img = document.createElement('img');
                    img.src = image.url;
                    const figcaption = document.createElement('figcaption');
                    figcaption.textContent = image.description;
                    imageWrapper.appendChild(img);
                    imageWrapper.appendChild(figcaption);
                    imagesContainer.appendChild(imageWrapper);
                });
                searchResultsWrapper.appendChild(imagesContainer);
            }

            // Render search results
            if (content.results && content.results.length > 0) {
                const resultsContainer = document.createElement('div');
                resultsContainer.className = 'tavily-results-container';
                content.results.forEach(result => {
                    const resultItem = document.createElement('div');
                    resultItem.className = 'tavily-result-item';

                    const title = document.createElement('h4');
                    const link = document.createElement('a');
                    link.href = result.url;
                    link.textContent = result.title;
                    link.target = '_blank'; // Open in new tab
                    title.appendChild(link);

                    const url = document.createElement('p');
                    url.className = 'tavily-result-url';
                    url.textContent = result.url;

                    const snippet = document.createElement('div');
                    snippet.className = 'tavily-result-snippet';
                    snippet.innerHTML = marked(result.content);

                    resultItem.appendChild(title);
                    resultItem.appendChild(url);
                    resultItem.appendChild(snippet);
                    resultsContainer.appendChild(resultItem);
                });
                searchResultsWrapper.appendChild(resultsContainer);
            }

            resultContainer.appendChild(searchResultsWrapper);
        } else if (typeof content === 'object') { // Generic object
            // Check for common image/text properties within the object
            const imageUrl = content.image_url || content.url || content.image;
            const textResult = content.result || content.message || content.original_plugin_output || content.content;
    
            if (typeof imageUrl === 'string') {
                const imgElement = document.createElement('img');
                imgElement.src = imageUrl;
                resultContainer.appendChild(imgElement);
            } else if (typeof textResult === 'string') {
                resultContainer.innerHTML = marked(textResult);
            } else {
                // Fallback for other objects: pretty-print the JSON
                const pre = document.createElement('pre');
                pre.textContent = JSON.stringify(content, null, 2);
                resultContainer.appendChild(pre);
            }
        } else { // Fallback for any other data type
            const pre = document.createElement('pre');
            pre.textContent = `插件返回了未知类型的数据: ${String(content)}`;
            resultContainer.appendChild(pre);
        }
    
        // 4. Finally, ensure all rendered images (newly created or from HTML) have the context menu
        attachEventListenersToImages(resultContainer);
    }

    // --- Image Viewer Modal ---
    function setupImageViewer() {
        if (document.getElementById('image-viewer-modal')) return;

        const viewer = document.createElement('div');
        viewer.id = 'image-viewer-modal';
        viewer.style.cssText = `
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgba(0,0,0,0.85);
            justify-content: center;
            align-items: center;
        `;
        viewer.innerHTML = `
            <span style="position: absolute; top: 15px; right: 35px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer;">&times;</span>
            <img style="margin: auto; display: block; max-width: 90%; max-height: 90%;">
        `;
        document.body.appendChild(viewer);

        const modalImg = viewer.querySelector('img');
        const closeBtn = viewer.querySelector('span');

        function openModal(src) {
            viewer.style.display = 'flex';
            modalImg.src = src;
            document.addEventListener('keydown', handleEscKeyModal);
        }

        function closeModal() {
            viewer.style.display = 'none';
            modalImg.src = '';
            document.removeEventListener('keydown', handleEscKeyModal);
        }

        function handleEscKeyModal(e) {
            if (e.key === 'Escape') {
                closeModal();
            }
        }

        closeBtn.onclick = closeModal;
        viewer.onclick = function(e) {
            if (e.target === viewer) {
                closeModal();
            }
        };

        resultContainer.addEventListener('click', (e) => {
            let target = e.target;
            // Handle case where user clicks an IMG inside an A tag
            if (target.tagName === 'IMG' && target.parentElement.tagName === 'A') {
                target = target.parentElement;
            }

            if (target.tagName === 'A' && target.href && (target.href.match(/\.(jpeg|jpg|gif|png|webp)$/i) || target.href.startsWith('data:image'))) {
                e.preventDefault();
                openModal(target.href);
            }
        });
    }

    // --- 初始化 ---
    async function loadAndProcessWallpaper() {
        // Temporarily apply the body style to get the CSS variable value
        const bodyStyles = getComputedStyle(document.body);
        let wallpaperUrl = bodyStyles.backgroundImage;

        if (wallpaperUrl && wallpaperUrl !== 'none') {
            // Extract the path from url("...")
            const match = wallpaperUrl.match(/url\("(.+)"\)/);
            if (match && match[1]) {
                // The path in CSS is relative to the CSS file, so we need to resolve it
                // from the main process perspective. We assume the path is like '../assets/wallpaper/...'
                // and renderer.js is in 'VCPHumanToolBox', so we go up one level.
                let imagePath = match[1];
                // Decode URI and remove the 'file:///' prefix on Windows
                if (imagePath.startsWith('file:///')) {
                    imagePath = decodeURI(imagePath.substring(8)); // Remove 'file:///' and decode
                }

                try {
                    const processedImageBase64 = await ipcRenderer.invoke('vcp-ht-process-wallpaper', imagePath);
                    if (processedImageBase64) {
                        document.body.style.backgroundImage = `url('${processedImageBase64}')`;
                    }
                } catch (error) {
                    console.error('Wallpaper processing failed:', error);
                }
            }
        }
    }

    function initialize() {
        // Window controls
        document.getElementById('minimize-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'minimize');
        });
        document.getElementById('maximize-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'maximize');
        });
        document.getElementById('close-btn').addEventListener('click', () => {
            ipcRenderer.send('window-control', 'close');
        });

        // Theme toggle
        const themeToggleBtn = document.getElementById('theme-toggle-btn');
        
        function applyTheme(theme) {
            if (theme === 'light') {
                document.body.classList.add('light-theme');
                themeToggleBtn.textContent = '☀️';
            } else {
                document.body.classList.remove('light-theme');
                themeToggleBtn.textContent = '🌙';
            }
        }

        // Apply initial theme from settings
        applyTheme(settings.vcpht_theme);

        themeToggleBtn.addEventListener('click', async () => {
            const isLight = document.body.classList.toggle('light-theme');
            const newTheme = isLight ? 'light' : 'dark';
            applyTheme(newTheme);
            settings.vcpht_theme = newTheme;
            
            try {
                await saveSettings();
            } catch (saveError) {
                console.error('[VCPHumanToolBox] Failed to save theme setting:', saveError);
                // 不阻断用户体验，只记录错误
            }
        });

        // App controls
        backToGridBtn.addEventListener('click', () => {
            toolDetailView.style.display = 'none';
            toolGrid.style.display = 'grid';
        });

        // 工作流编排按钮
        const workflowBtn = document.getElementById('workflow-btn');
        if (workflowBtn) {
            workflowBtn.addEventListener('click', openWorkflowEditor);
        }

        // 移除全局设置按钮，改为工具内设置
        // 设置按钮现在在 buildToolForm 函数中为 NanoBananaGenOR 工具单独添加
        
        renderToolGrid();
        loadAndProcessWallpaper(); // Process the wallpaper on startup
        setupImageViewer();
    }

    initialize();

    // --- ComfyUI 集成功能 ---
    let comfyUIDrawer = null;
    let comfyUILoaded = false;

    // 创建抽屉容器
    function createComfyUIDrawer() {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.className = 'drawer-overlay hidden';
        overlay.addEventListener('click', closeComfyUISettings);

        // 创建抽屉面板
        const drawer = document.createElement('div');
        drawer.className = 'drawer-panel';
        drawer.innerHTML = `
            <div class="drawer-content" id="comfyui-drawer-content">
                <div style="text-align: center; padding: 50px; color: var(--secondary-text);">
                    正在加载 ComfyUI 配置...
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(drawer);

        return { overlay, drawer };
    }

    // 打开 ComfyUI 设置
    async function openComfyUISettings() {
        if (!comfyUIDrawer) {
            comfyUIDrawer = createComfyUIDrawer();
        }

        // 显示抽屉
        comfyUIDrawer.overlay.classList.remove('hidden');
        comfyUIDrawer.drawer.classList.add('open');
        document.body.classList.add('drawer-open');

        // 动态加载 ComfyUI 模块
        if (!comfyUILoaded) {
            try {
                // 加载 ComfyUILoader
                await loadComfyUIModules();
                
                // 等待 ComfyUILoader 可用
                if (window.ComfyUILoader) {
                    await window.ComfyUILoader.load();
                    
                    // 创建配置 UI
                    const drawerContent = document.getElementById('comfyui-drawer-content');
                    if (window.comfyUI && drawerContent) {
                        window.comfyUI.createUI(drawerContent, {
                            defaultTab: 'connection',
                            onClose: closeComfyUISettings
                        });
                    }
                    
                    comfyUILoaded = true;
                } else {
                    throw new Error('ComfyUILoader 未能正确加载');
                }
            } catch (error) {
                console.error('加载 ComfyUI 模块失败:', error);
                const drawerContent = document.getElementById('comfyui-drawer-content');
                if (drawerContent) {
                    drawerContent.innerHTML = `
                        <div style="text-align: center; padding: 50px; color: var(--danger-color);">
                            加载 ComfyUI 配置失败: ${error.message}
                        </div>
                    `;
                }
            }
        }

        // 绑定 ESC 键关闭
        document.addEventListener('keydown', handleEscKey);
    }

    // 关闭 ComfyUI 设置
    function closeComfyUISettings() {
        if (comfyUIDrawer) {
            comfyUIDrawer.overlay.classList.add('hidden');
            comfyUIDrawer.drawer.classList.remove('open');
            document.body.classList.remove('drawer-open');
        }
        document.removeEventListener('keydown', handleEscKey);
    }

    // ESC 键处理
    function handleEscKey(e) {
        if (e.key === 'Escape') {
            closeComfyUISettings();
        }
    }

    // 动态加载 ComfyUI 模块
    async function loadComfyUIModules() {
        // 首先加载 ComfyUILoader 脚本
        const loaderScript = document.createElement('script');
        loaderScript.src = 'ComfyUImodules/ComfyUILoader.js';
        
        return new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 ComfyUILoader.js'));
            document.head.appendChild(loaderScript);
        });
    }

    // --- 工作流编排集成功能 ---
    let workflowEditorLoaded = false;

    // 打开工作流编排器
    async function openWorkflowEditor() {
        try {
            // 动态加载工作流编排模块
            if (!workflowEditorLoaded) {
                await loadWorkflowEditorModules();
                workflowEditorLoaded = true;
            }

            // 显示工作流编排器
            if (window.workflowEditor) {
                window.workflowEditor.show();
            } else {
                throw new Error('工作流编排器未能正确初始化');
            }
        } catch (error) {
            console.error('打开工作流编排器失败:', error);
            alert(`打开工作流编排器失败: ${error.message}`);
        }
    }

    // 动态加载工作流编排模块
    async function loadWorkflowEditorModules() {
        // 首先加载 WorkflowEditorLoader 脚本
        const loaderScript = document.createElement('script');
        loaderScript.src = 'WorkflowEditormodules/WorkflowEditorLoader_Simplified.js';
        
        await new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 WorkflowEditorLoader_Simplified.js'));
            document.head.appendChild(loaderScript);
        });

        // 等待 WorkflowEditorLoader 可用并加载所有模块
        if (window.WorkflowEditorLoader) {
            await window.WorkflowEditorLoader.load();
            
            // 初始化工作流编排器
            if (window.workflowEditor) {
                await window.workflowEditor.init();
                console.log('工作流编排器初始化成功');
            } else {
                throw new Error('WorkflowEditor 配置模块未能正确加载');
            }
        } else {
            throw new Error('WorkflowEditorLoader 未能正确加载');
        }
    }

    // 将函数暴露到全局作用域，以便按钮点击时调用
    window.openComfyUISettings = openComfyUISettings;
    window.closeComfyUISettings = closeComfyUISettings;
    window.openWorkflowEditor = openWorkflowEditor;
});
