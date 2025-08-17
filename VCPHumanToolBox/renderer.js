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
    const path = require('path');

    let VCP_SERVER_URL = '';
    let VCP_API_KEY = '';
    let USER_NAME = 'Human'; // Default value in case it's not found
    let settings = {}; // Make settings available in a wider scope
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

    function saveSettings() {
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
        } catch (error) {
            console.error('Failed to save settings.json:', error);
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
            displayName: '豆包图片生成',
            description: '国产文生图，支持中文和任意分辨率，适合平面设计。',
            params: [
                { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的提示词，可包含中文' },
                { name: 'resolution', type: 'text', required: true, placeholder: '例如: 800x600', default: '1024x1024' }
            ]
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
                renderFormParams(tool.commands[e.target.value].params, paramsContainer);
            });
            renderFormParams(tool.commands[commandSelect.value].params, paramsContainer);

        } else {
            toolForm.appendChild(paramsContainer);
            renderFormParams(tool.params, paramsContainer);
        }

        // 添加按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 15px;';
        
        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = '执行';
        buttonContainer.appendChild(submitButton);

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

        toolForm.appendChild(buttonContainer);

        toolForm.onsubmit = (e) => {
            e.preventDefault();
            executeTool(toolName);
        };
    }

    function renderFormParams(params, container) {
        container.innerHTML = '';
        const dependencyListeners = [];

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
            } else {
                input = document.createElement('input');
                input.type = param.type || 'text';
            }
            
            if (input.tagName !== 'DIV') {
                input.name = param.name;
                input.placeholder = param.placeholder || '';
                if (param.default) input.value = param.default;
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

        dependencyListeners.forEach(listener => listener());
    }

    async function executeTool(toolName) {
        const formData = new FormData(toolForm);
        const args = {};

        // Collect all form data
        for (let [key, value] of formData.entries()) {
            const inputElement = toolForm.querySelector(`[name="${key}"]`);
            if (inputElement && inputElement.type === 'checkbox') {
                args[key] = inputElement.checked;
            } else if (value) { // Don't include empty optional fields
                args[key] = value;
            }
        }
        // Handle radio groups correctly
        const radioGroups = toolForm.querySelectorAll('.radio-group');
        radioGroups.forEach(group => {
            const selected = group.querySelector('input:checked');
            if (selected) {
                args[selected.name] = selected.value;
            }
        });

        // Build the plain text request body
        let requestBody = `<<<[TOOL_REQUEST]>>>\n`;
        requestBody += `maid:「始」${USER_NAME}「末」,\n`;
        requestBody += `tool_name:「始」${toolName}「末」,\n`;
        for (const key in args) {
            if (args[key] !== undefined) {
                const value = typeof args[key] === 'boolean' ? String(args[key]) : args[key];
                requestBody += `${key}:「始」${value}「末」,\n`;
            }
        }
        requestBody += `<<<[END_TOOL_REQUEST]>>>`;

        resultContainer.innerHTML = '<div class="loading">正在执行...</div>';

        try {
            const response = await fetch(VCP_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': `Bearer ${VCP_API_KEY}`
                },
                body: requestBody // Send the plain text body
            });

            const responseText = await response.text();
            if (!response.ok) {
                // Try to parse error JSON if possible, otherwise use the raw text
                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(`HTTP ${response.status}: ${errorJson.error || responseText}`);
                } catch (e) {
                    throw new Error(`HTTP ${response.status}: ${responseText}`);
                }
            }

            const data = JSON.parse(responseText); // The response is JSON
            renderResult(data, toolName);

        } catch (error) {
            console.error('Error executing tool:', error);
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
                ipcRenderer.send('show-image-context-menu', img.src);
            });
            img.dataset.contextMenuAttached = 'true';
        });
    }

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

        themeToggleBtn.addEventListener('click', () => {
            const isLight = document.body.classList.toggle('light-theme');
            const newTheme = isLight ? 'light' : 'dark';
            applyTheme(newTheme);
            settings.vcpht_theme = newTheme;
            saveSettings();
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
        loaderScript.src = 'WorkflowEditormodules/WorkflowEditorLoader.js';
        
        await new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 WorkflowEditorLoader.js'));
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
