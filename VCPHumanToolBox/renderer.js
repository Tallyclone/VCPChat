// VCPHumanToolBox/renderer.js
import { tools } from './renderer_modules/config.js';
import * as canvasHandler from './renderer_modules/ui/canvas-handler.js';
import * as dynamicImageHandler from './renderer_modules/ui/dynamic-image-handler.js';

document.addEventListener('DOMContentLoaded', async () => {
    // --- 元素获取 ---
    const toolGrid = document.getElementById('tool-grid');
    const toolDetailView = document.getElementById('tool-detail-view');
    const backToGridBtn = document.getElementById('back-to-grid-btn');
    const toolTitle = document.getElementById('tool-title');
    const toolDescription = document.getElementById('tool-description');
    const toolForm = document.getElementById('tool-form');
    const resultContainer = document.getElementById('result-container');

    // --- 全局变量 ---
    let VCP_SERVER_URL = '';
    let VCP_API_KEY = '';
    let USER_NAME = 'Human';
    let settings = {};
    let MAX_FILENAME_LENGTH = 400;

    // --- 设置加载与保存 ---
    async function loadSettings() {
        try {
            settings = await window.electronAPI.invoke('vcp-ht-get-settings');
        } catch (error) {
            console.error('Failed to load settings:', error);
            settings = {};
        }
    }

    async function saveSettings() {
        try {
            const result = await window.electronAPI.invoke('vcp-ht-save-settings', settings);
            if (!result.success) {
                throw new Error(result.error);
            }
            console.log('[VCPHumanToolBox] Settings saved successfully');
        } catch (error) {
            console.error('[VCPHumanToolBox] Failed to save settings:', error);
            throw error;
        }
    }

    // --- 初始化应用程序 ---
    async function initializeApp() {
        await loadSettings();

        if (settings.vcpServerUrl) {
            try {
                const url = new URL(settings.vcpServerUrl);
                url.pathname = '/v1/human/tool';
                VCP_SERVER_URL = url.toString();
            } catch (e) {
                console.error("Invalid vcpServerUrl in settings:", settings.vcpServerUrl);
            }
        }
        VCP_API_KEY = settings.vcpApiKey || '';
        USER_NAME = settings.userName || 'Human';
        MAX_FILENAME_LENGTH = settings.maxFilenameLength || 400;
        
        // 动态加载模块并传递配置
        // 注意：由于移除了 require，模块需要重构为浏览器兼容的格式
        canvasHandler.setMaxFilenameLength(MAX_FILENAME_LENGTH);

        if (!VCP_SERVER_URL || !VCP_API_KEY) {
            toolGrid.innerHTML = `<div class="error">错误：无法加载配置文件 (settings.json)。请确保文件存在且格式正确。<br>未能从 settings.json 中找到 vcpServerUrl 或 vcpApiKey</div>`;
            return;
        }

        initializeUI();
    }
    


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
        
        // 为 NanoBananaGen 工具添加文件名设置按钮
        if (toolName === 'NanoBananaGen') {
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

        // 检查是否为 NanoBananaGen 的 compose 命令
        const isNanoBananaCompose = toolName === 'NanoBananaGen' && commandName === 'compose';
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
                input = canvasHandler.createDragDropImageInput(param);

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
            dynamicImageHandler.createDynamicImageContainer(container);
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
        
        // 5. 清空动态图片区域（仅限 NanoBananaGen compose 模式）
        if (toolName === 'NanoBananaGen') {
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

    async function executeTool(toolName) {
        const formData = new FormData(toolForm);
        const args = {};
        let finalToolName = toolName;

        const tool = tools[toolName];
        // The finalToolName is always the toolName. The 'command' is an argument.

        for (let [key, value] of formData.entries()) {
            // Handle checkbox
            const inputElement = toolForm.querySelector(`[name="${key}"]`);
            if (inputElement && inputElement.type === 'checkbox') {
                args[key] = inputElement.checked;
            } else if (value) {
                args[key] = value;
            }
        }

        resultContainer.innerHTML = '<div class="loader"></div>';

        try {
            const result = await window.electronAPI.invoke('vcp-ht-execute-tool-proxy', {
                url: VCP_SERVER_URL,
                apiKey: VCP_API_KEY,
                toolName: finalToolName,
                userName: USER_NAME,
                args: args
            });

            if (result.success) {
                renderResult(result.data, toolName);
            } else {
                renderResult({ status: 'error', error: result.error }, toolName);
            }
        } catch (error) {
            renderResult({ status: 'error', error: error.message }, toolName);
        }
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
            if (window.marked && typeof window.marked.parse === 'function') {
                div.innerHTML = window.marked.parse(content);
            } else {
                console.error("'marked' library not loaded. Displaying content as plain text.");
                div.textContent = content;
            }
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
                    if (window.marked && typeof window.marked.parse === 'function') {
                        snippet.innerHTML = window.marked.parse(result.content);
                    } else {
                        console.error("'marked' library not loaded. Displaying content as plain text.");
                        snippet.textContent = result.content;
                    }

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
                if (window.marked && typeof window.marked.parse === 'function') {
                    resultContainer.innerHTML = window.marked.parse(textResult);
                } else {
                    console.error("'marked' library not loaded. Displaying content as plain text.");
                    resultContainer.textContent = textResult;
                }
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
        // attachEventListenersToImages(resultContainer);
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
        const bodyStyles = getComputedStyle(document.body);
        let wallpaperUrl = bodyStyles.backgroundImage;

        if (wallpaperUrl && wallpaperUrl !== 'none') {
            const match = wallpaperUrl.match(/url\("(.+)"\)/);
            if (match && match[1]) {
                let imagePath = match[1];
                if (imagePath.startsWith('file:///')) {
                    imagePath = decodeURI(imagePath.substring(8));
                }

                try {
                    const processedImageBase64 = await window.electronAPI.invoke('vcp-ht-process-wallpaper', imagePath);
                    if (processedImageBase64) {
                        document.body.style.backgroundImage = `url('${processedImageBase64}')`;
                    }
                } catch (error) {
                    console.error('Wallpaper processing failed:', error);
                }
            }
        }
    }

    function initializeUI() {
        // Window controls
        document.getElementById('minimize-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control', 'minimize');
        });
        document.getElementById('maximize-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control', 'maximize');
        });
        document.getElementById('close-btn').addEventListener('click', () => {
            window.electronAPI.send('window-control', 'close');
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
        
        renderToolGrid();
        loadAndProcessWallpaper();
        setupImageViewer();
    }

    initializeApp();

    // --- ComfyUI 集成功能 ---
    let comfyUIDrawer = null;
    let comfyUILoaded = false;

    function createComfyUIDrawer() {
        const overlay = document.createElement('div');
        overlay.className = 'drawer-overlay hidden';
        overlay.addEventListener('click', closeComfyUISettings);

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

    async function openComfyUISettings() {
        if (!comfyUIDrawer) {
            comfyUIDrawer = createComfyUIDrawer();
        }

        comfyUIDrawer.overlay.classList.remove('hidden');
        comfyUIDrawer.drawer.classList.add('open');
        document.body.classList.add('drawer-open');

        if (!comfyUILoaded) {
            try {
                await loadComfyUIModules();
                
                if (window.ComfyUILoader) {
                    await window.ComfyUILoader.load();
                    
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

        document.addEventListener('keydown', handleEscKey);
    }

    function closeComfyUISettings() {
        if (comfyUIDrawer) {
            comfyUIDrawer.overlay.classList.add('hidden');
            comfyUIDrawer.drawer.classList.remove('open');
            document.body.classList.remove('drawer-open');
        }
        document.removeEventListener('keydown', handleEscKey);
    }

    function handleEscKey(e) {
        if (e.key === 'Escape') {
            closeComfyUISettings();
        }
    }

    async function loadComfyUIModules() {
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

    async function openWorkflowEditor() {
        try {
            if (!workflowEditorLoaded) {
                await loadWorkflowEditorModules();
                workflowEditorLoaded = true;
            }

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

    async function loadWorkflowEditorModules() {
        const loaderScript = document.createElement('script');
        loaderScript.src = 'WorkflowEditormodules/WorkflowEditorLoader_Simplified.js';
        
        await new Promise((resolve, reject) => {
            loaderScript.onload = resolve;
            loaderScript.onerror = () => reject(new Error('无法加载 WorkflowEditorLoader_Simplified.js'));
            document.head.appendChild(loaderScript);
        });

        if (window.WorkflowEditorLoader) {
            await window.WorkflowEditorLoader.load();
            
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
