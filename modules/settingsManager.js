/**
 * settingsManager.js
 * 
 * Manages the settings panel for both Agents and Groups.
 * Handles displaying, populating, saving, and deleting items.
 */
const settingsManager = (() => {
    /**
     * Completes a VCP Server URL to the full completions endpoint.
     * @param {string} url - The URL to complete.
     * @returns {string} The completed URL.
     */
    function completeVcpUrl(url) {
        if (!url) return '';
        let trimmedUrl = url.trim();
        if (trimmedUrl === '') return '';

        // If it doesn't have a protocol, add http://
        if (!/^https?:\/\//i.test(trimmedUrl)) {
            trimmedUrl = 'http://' + trimmedUrl;
        }

        try {
            const urlObject = new URL(trimmedUrl);
            const requiredPath = '/v1/chat/completions';

            // For any other case (e.g., root path '/', or some other path),
            // we set the path to the required one.
            urlObject.pathname = requiredPath;
            return urlObject.toString();

        } catch (e) {
            // If URL parsing fails, it's likely an invalid URL.
            // We return the original input for the user to see and correct.
            console.warn(`Could not parse and complete URL: ${url}`, e);
            return url;
        }
    }

    // --- Private Variables ---
    let electronAPI = null;
    let uiHelper = null;
    let refs = {}; // To hold references to currentSelectedItem, etc.
    let mainRendererFunctions = {}; // To call back to renderer.js functions if needed

    // DOM Elements
    let agentSettingsContainer, groupSettingsContainer, selectItemPromptForSettings;
    let itemSettingsContainerTitle, selectedItemNameForSettingsSpan, deleteItemBtn;
    let agentSettingsForm, editingAgentIdInput, agentNameInput, agentAvatarInput, agentAvatarPreview;
    let agentSystemPromptTextarea, agentModelInput, agentTemperatureInput;
    let agentContextTokenLimitInput, agentMaxOutputTokensInput, agentTopPInput, agentTopKInput;
    let openModelSelectBtn, modelSelectModal, modelList, modelSearchInput, refreshModelsBtn;
    let topicSummaryModelInput, openTopicSummaryModelSelectBtn; // New elements for topic summary model
    let agentTtsVoicePrimarySelect, agentTtsRegexPrimaryInput, agentTtsVoiceSecondarySelect, agentTtsRegexSecondaryInput, refreshTtsModelsBtn, agentTtsSpeedSlider, ttsSpeedValueSpan;
    let stripRegexListContainer;
    
    // --- New Regex Modal Elements ---
    let regexRuleModal, regexRuleForm, editingRegexRuleId, regexRuleTitle, regexRuleFind, regexRuleReplace;
    let regexRuleMinDepth, regexRuleMaxDepth, cancelRegexRuleBtn, closeRegexRuleModalBtn;
    
    // A private variable to hold the regex rules for the currently edited agent
    let currentAgentRegexes = [];

    // A private variable to hold the preset messages for the currently edited agent
    let currentAgentPresetMessages = [];

    /**
     * Displays the appropriate settings view (agent, group, or default prompt)
     * based on the currently selected item.
     */
    function displaySettingsForItem() {
        const currentSelectedItem = refs.currentSelectedItemRef.get();
        
        const agentSettingsExists = agentSettingsContainer && typeof agentSettingsContainer.style !== 'undefined';
        const groupSettingsExists = groupSettingsContainer && typeof groupSettingsContainer.style !== 'undefined';

        if (currentSelectedItem.id) {
            selectItemPromptForSettings.style.display = 'none';
            selectedItemNameForSettingsSpan.textContent = currentSelectedItem.name || currentSelectedItem.id;

            if (currentSelectedItem.type === 'agent') {
                if (agentSettingsExists) agentSettingsContainer.style.display = 'block';
                if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
                itemSettingsContainerTitle.textContent = 'Agent 设置: ';
                deleteItemBtn.textContent = '删除此 Agent';
                populateAgentSettingsForm(currentSelectedItem.id, (currentSelectedItem.config || currentSelectedItem));
            } else if (currentSelectedItem.type === 'group') {
                if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
                if (groupSettingsExists) groupSettingsContainer.style.display = 'block';
                itemSettingsContainerTitle.textContent = '群组设置: ';
                deleteItemBtn.textContent = '删除此群组';
                if (window.GroupRenderer && typeof window.GroupRenderer.displayGroupSettingsPage === 'function') {
                    window.GroupRenderer.displayGroupSettingsPage(currentSelectedItem.id);
                } else {
                    console.error("GroupRenderer or displayGroupSettingsPage not available.");
                    if (groupSettingsExists) groupSettingsContainer.innerHTML = "<p>无法加载群组设置界面。</p>";
                }
            }
        } else {
            if (agentSettingsExists) agentSettingsContainer.style.display = 'none';
            if (groupSettingsExists) groupSettingsContainer.style.display = 'none';
            selectItemPromptForSettings.textContent = '请先在左侧选择一个 Agent 或群组以查看或修改其设置。';
            selectItemPromptForSettings.style.display = 'block';
            itemSettingsContainerTitle.textContent = '设置';
            selectedItemNameForSettingsSpan.textContent = '';
        }
    }

    /**
     * Populates the agent settings form with the config of the selected agent.
     * @param {string} agentId - The ID of the agent.
     * @param {object} agentConfig - The configuration object for the agent.
     */
    async function populateAgentSettingsForm(agentId, agentConfig) {
        if (groupSettingsContainer) groupSettingsContainer.style.display = 'none';
        if (agentSettingsContainer) agentSettingsContainer.style.display = 'block';

        if (!agentConfig || agentConfig.error) {
            uiHelper.showToastNotification(`加载Agent配置失败: ${agentConfig?.error || '未知错误'}`, 'error');
            if (agentSettingsContainer) agentSettingsContainer.style.display = 'none';
            selectItemPromptForSettings.textContent = `加载 ${agentId} 配置失败。`;
            selectItemPromptForSettings.style.display = 'block';
            return;
        }
        
        editingAgentIdInput.value = agentId;
        agentNameInput.value = agentConfig.name || agentId;
        agentSystemPromptTextarea.value = agentConfig.systemPrompt || '';
        agentModelInput.value = agentConfig.model || '';
        agentTemperatureInput.value = agentConfig.temperature !== undefined ? agentConfig.temperature : 0.7;
        agentContextTokenLimitInput.value = agentConfig.contextTokenLimit !== undefined ? agentConfig.contextTokenLimit : 4000;
        agentMaxOutputTokensInput.value = agentConfig.maxOutputTokens !== undefined ? agentConfig.maxOutputTokens : 1000;
        agentTopPInput.value = agentConfig.top_p !== undefined ? agentConfig.top_p : '';
        agentTopKInput.value = agentConfig.top_k !== undefined ? agentConfig.top_k : '';

        const streamOutput = agentConfig.streamOutput !== undefined ? agentConfig.streamOutput : true;
        document.getElementById('agentStreamOutputTrue').checked = streamOutput === true || String(streamOutput) === 'true';
        document.getElementById('agentStreamOutputFalse').checked = streamOutput === false || String(streamOutput) === 'false';
        
        if (agentConfig.avatarUrl) {
            agentAvatarPreview.src = `${agentConfig.avatarUrl}${agentConfig.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
            agentAvatarPreview.style.display = 'block';
        } else {
            agentAvatarPreview.src = '#';
            agentAvatarPreview.style.display = 'none';
        }
        agentAvatarInput.value = '';
        mainRendererFunctions.setCroppedFile('agent', null);
        
        // Populate bilingual TTS settings
        populateTtsModels(agentConfig.ttsVoicePrimary, agentConfig.ttsVoiceSecondary);
        
        agentTtsRegexPrimaryInput.value = agentConfig.ttsRegexPrimary || '';
        agentTtsRegexSecondaryInput.value = agentConfig.ttsRegexSecondary || '';

        agentTtsSpeedSlider.value = agentConfig.ttsSpeed !== undefined ? agentConfig.ttsSpeed : 1.0;
    ttsSpeedValueSpan.textContent = parseFloat(agentTtsSpeedSlider.value).toFixed(1);
    
    // Load and render regex rules
    currentAgentRegexes = JSON.parse(JSON.stringify(agentConfig.stripRegexes || [])); // Deep copy
    renderRegexList();

    // Load and render preset messages
    currentAgentPresetMessages = JSON.parse(JSON.stringify(agentConfig.presetMessages || [])); // Deep copy
    renderPresetMessageList();

    // Set the initial state of the enable switch
    const enableCheckbox = document.getElementById('enablePresetMessage');
    if (enableCheckbox) {
        enableCheckbox.checked = agentConfig.presetMessageEnabled !== false; // Default to true if not specified
    }
}

    /**
     * Handles the submission of the agent settings form, saving the changes.
     * @param {Event} event - The form submission event.
     */
    async function saveCurrentAgentSettings(event) {
        event.preventDefault();
        const agentId = editingAgentIdInput.value;
        const newConfig = {
            name: agentNameInput.value.trim(),
            systemPrompt: agentSystemPromptTextarea.value.trim(),
            model: agentModelInput.value.trim() || 'gemini-pro',
            temperature: parseFloat(agentTemperatureInput.value),
            contextTokenLimit: parseInt(agentContextTokenLimitInput.value),
            maxOutputTokens: parseInt(agentMaxOutputTokensInput.value),
            top_p: parseFloat(agentTopPInput.value) || undefined,
            top_k: parseInt(agentTopKInput.value) || undefined,
            streamOutput: document.getElementById('agentStreamOutputTrue').checked,
            ttsVoicePrimary: agentTtsVoicePrimarySelect.value,
            ttsRegexPrimary: agentTtsRegexPrimaryInput.value.trim(),
            ttsVoiceSecondary: agentTtsVoiceSecondarySelect.value,
            ttsRegexSecondary: agentTtsRegexSecondaryInput.value.trim(),
            ttsSpeed: parseFloat(agentTtsSpeedSlider.value),
            stripRegexes: currentAgentRegexes,
            presetMessages: currentAgentPresetMessages,
            presetMessageEnabled: document.getElementById('enablePresetMessage')?.checked ?? true
        };
     
        if (!newConfig.name) {
            uiHelper.showToastNotification("Agent名称不能为空！", 'error');
            return;
        }
     
        const croppedFile = mainRendererFunctions.getCroppedFile('agent');
        if (croppedFile) {
            try {
                const arrayBuffer = await croppedFile.arrayBuffer();
                const avatarResult = await electronAPI.saveAvatar(agentId, {
                    name: croppedFile.name,
                    type: croppedFile.type,
                    buffer: arrayBuffer
                });
     
                if (avatarResult.error) {
                    uiHelper.showToastNotification(`保存Agent头像失败: ${avatarResult.error}`, 'error');
                } else {
                    if (avatarResult.needsColorExtraction && electronAPI.saveAvatarColor) {
                         uiHelper.getAverageColorFromAvatar(avatarResult.avatarUrl, (avgColor) => {
                            if (avgColor) {
                                electronAPI.saveAvatarColor({ type: 'agent', id: agentId, color: avgColor })
                                    .then((saveColorResult) => {
                                        if (saveColorResult && saveColorResult.success) {
                                            if(refs.currentSelectedItemRef.get().id === agentId && refs.currentSelectedItemRef.get().type === 'agent' && window.messageRenderer) {
                                                window.messageRenderer.setCurrentItemAvatarColor(avgColor);
                                            }
                                        } else {
                                            console.warn(`Failed to save agent ${agentId} avatar color:`, saveColorResult?.error);
                                        }
                                    }).catch(err => console.error(`Error saving agent ${agentId} avatar color:`, err));
                            }
                        });
                    }
                    agentAvatarPreview.src = avatarResult.avatarUrl;
                    mainRendererFunctions.setCroppedFile('agent', null);
                    agentAvatarInput.value = '';
                }
            } catch (readError) {
                console.error("读取Agent头像文件失败:", readError);
                uiHelper.showToastNotification(`读取Agent头像文件失败: ${readError.message}`, 'error');
            }
        }
     
        const result = await electronAPI.saveAgentConfig(agentId, newConfig);
        const saveButton = agentSettingsForm.querySelector('button[type="submit"]');
     
        if (result.success) {
            if (saveButton) uiHelper.showSaveFeedback(saveButton, true, '已保存!', '保存 Agent 设置');
            await window.itemListManager.loadItems();
            
            const currentSelectedItem = refs.currentSelectedItemRef.get();
            if (currentSelectedItem.id === agentId && currentSelectedItem.type === 'agent') {
                const updatedAgentConfig = await electronAPI.getAgentConfig(agentId);
                currentSelectedItem.name = newConfig.name;
                if (currentSelectedItem.config) {
                    currentSelectedItem.config = updatedAgentConfig;
                } else {
                    Object.assign(currentSelectedItem, updatedAgentConfig);
                }
                
                // Update other UI parts via callbacks or direct calls if modules are passed in
                if (mainRendererFunctions.updateChatHeader) {
                    mainRendererFunctions.updateChatHeader(`与 ${newConfig.name} 聊天中`);
                }
                if (window.messageRenderer) {
                    window.messageRenderer.setCurrentItemAvatar(updatedAgentConfig.avatarUrl);
                    window.messageRenderer.setCurrentItemAvatarColor(updatedAgentConfig.avatarCalculatedColor || null);
                }
                selectedItemNameForSettingsSpan.textContent = newConfig.name;
            }
        } else {
            if (saveButton) uiHelper.showSaveFeedback(saveButton, false, '保存失败', '保存 Agent 设置');
            uiHelper.showToastNotification(`保存Agent设置失败: ${result.error}`, 'error');
        }
    }

    /**
     * Handles the deletion of the currently selected item (agent or group).
     */
    async function handleDeleteCurrentItem() {
        const currentSelectedItem = refs.currentSelectedItemRef.get();
        if (!currentSelectedItem.id) {
            uiHelper.showToastNotification("没有选中的项目可删除。", 'info');
            return;
        }

        const itemTypeDisplay = currentSelectedItem.type === 'group' ? '群组' : 'Agent';
        const itemName = currentSelectedItem.name || '当前选中的项目';

        if (confirm(`您确定要删除 ${itemTypeDisplay} "${itemName}" 吗？其所有聊天记录和设置都将被删除，此操作不可撤销！`)) {
            let result;
            if (currentSelectedItem.type === 'agent') {
                result = await electronAPI.deleteAgent(currentSelectedItem.id);
            } else if (currentSelectedItem.type === 'group') {
                result = await electronAPI.deleteAgentGroup(currentSelectedItem.id);
            }

            if (result && result.success) {
                // Reset state in renderer via refs
                refs.currentSelectedItemRef.set({ id: null, type: null, name: null, avatarUrl: null, config: null });
                refs.currentTopicIdRef.set(null);
                refs.currentChatHistoryRef.set([]);
                
                // Call back to renderer to update UI
                if (mainRendererFunctions.onItemDeleted) {
                    mainRendererFunctions.onItemDeleted();
                }
            } else {
                uiHelper.showToastNotification(`删除${itemTypeDisplay}失败: ${result?.error || '未知错误'}`, 'error');
            }
        }
    }

    /**
     * Populates the assistant agent select dropdown with available agents.
     */
    async function populateAssistantAgentSelect() {
        const assistantAgentSelect = document.getElementById('assistantAgent');
        if (!assistantAgentSelect) {
            console.warn('[SettingsManager] populateAssistantAgentSelect: assistantAgentSelect element not found');
            return;
        }

        const agents = await electronAPI.getAgents();
        if (agents && !agents.error) {
            assistantAgentSelect.innerHTML = '<option value="">请选择一个Agent</option>'; // Clear and add placeholder
            agents.forEach(agent => {
                const option = document.createElement('option');
                option.value = agent.id;
                option.textContent = agent.name || agent.id;
                assistantAgentSelect.appendChild(option);
            });
        } else {
            console.error('[SettingsManager] Failed to load agents for assistant select:', agents?.error);
            assistantAgentSelect.innerHTML = '<option value="">加载Agent失败</option>';
        }
    }

    /**
     * Populates the primary and secondary TTS voice model select dropdowns.
     * @param {string} currentPrimaryVoice - The currently selected primary voice.
     * @param {string} currentSecondaryVoice - The currently selected secondary voice.
     */
    async function populateTtsModels(currentPrimaryVoice, currentSecondaryVoice) {
        if (!agentTtsVoicePrimarySelect || !agentTtsVoiceSecondarySelect) return;

        try {
            const models = await electronAPI.sovitsGetModels();
            
            // Clear existing options
            agentTtsVoicePrimarySelect.innerHTML = '<option value="">不使用语音</option>';
            agentTtsVoiceSecondarySelect.innerHTML = '<option value="">不使用</option>';

            if (models && Object.keys(models).length > 0) {
                for (const modelName in models) {
                    // Create options for primary dropdown
                    const primaryOption = document.createElement('option');
                    primaryOption.value = modelName;
                    primaryOption.textContent = modelName;
                    if (modelName === currentPrimaryVoice) {
                        primaryOption.selected = true;
                    }
                    agentTtsVoicePrimarySelect.appendChild(primaryOption);

                    // Create options for secondary dropdown
                    const secondaryOption = document.createElement('option');
                    secondaryOption.value = modelName;
                    secondaryOption.textContent = modelName;
                    if (modelName === currentSecondaryVoice) {
                        secondaryOption.selected = true;
                    }
                    agentTtsVoiceSecondarySelect.appendChild(secondaryOption);
                }
            } else {
                const disabledOption = '<option value="" disabled>未找到模型,请启动Sovits</option>';
                agentTtsVoicePrimarySelect.innerHTML += disabledOption;
                agentTtsVoiceSecondarySelect.innerHTML += disabledOption;
            }
        } catch (error) {
            console.error('Failed to get Sovits TTS models:', error);
            const errorOption = '<option value="" disabled>获取模型失败</option>';
            agentTtsVoicePrimarySelect.innerHTML = errorOption;
            agentTtsVoiceSecondarySelect.innerHTML = errorOption;
            uiHelper.showToastNotification('获取Sovits语音模型失败', 'error');
        }
    }

    // --- Public API ---
    return {
        init: (options) => {
            electronAPI = options.electronAPI;
            uiHelper = options.uiHelper;
            refs = options.refs;
            mainRendererFunctions = options.mainRendererFunctions;

            // DOM Elements
            agentSettingsContainer = options.elements.agentSettingsContainer;
            groupSettingsContainer = options.elements.groupSettingsContainer;
            selectItemPromptForSettings = options.elements.selectItemPromptForSettings;
            itemSettingsContainerTitle = options.elements.itemSettingsContainerTitle;
            selectedItemNameForSettingsSpan = options.elements.selectedItemNameForSettingsSpan;
            deleteItemBtn = options.elements.deleteItemBtn;
            agentSettingsForm = options.elements.agentSettingsForm;
            editingAgentIdInput = options.elements.editingAgentIdInput;
            agentNameInput = options.elements.agentNameInput;
            agentAvatarInput = options.elements.agentAvatarInput;
            agentAvatarPreview = options.elements.agentAvatarPreview;
            agentSystemPromptTextarea = options.elements.agentSystemPromptTextarea;
            agentModelInput = options.elements.agentModelInput;
            agentTemperatureInput = options.elements.agentTemperatureInput;
            agentContextTokenLimitInput = options.elements.agentContextTokenLimitInput;
            agentMaxOutputTokensInput = options.elements.agentMaxOutputTokensInput;
            agentTopPInput = document.getElementById('agentTopP');
            agentTopKInput = document.getElementById('agentTopK');
            openModelSelectBtn = options.elements.openModelSelectBtn;
            modelSelectModal = options.elements.modelSelectModal;
            modelList = options.elements.modelList;
            modelSearchInput = options.elements.modelSearchInput;
            refreshModelsBtn = options.elements.refreshModelsBtn;
            topicSummaryModelInput = options.elements.topicSummaryModelInput; // Get new element
            openTopicSummaryModelSelectBtn = options.elements.openTopicSummaryModelSelectBtn; // Get new element
            
            // TTS Elements
            agentTtsVoicePrimarySelect = document.getElementById('agentTtsVoicePrimary');
            agentTtsRegexPrimaryInput = document.getElementById('agentTtsRegexPrimary');
            agentTtsVoiceSecondarySelect = document.getElementById('agentTtsVoiceSecondary');
            agentTtsRegexSecondaryInput = document.getElementById('agentTtsRegexSecondary');
            refreshTtsModelsBtn = document.getElementById('refreshTtsModelsBtn');
            agentTtsSpeedSlider = options.elements.agentTtsSpeedSlider;
            ttsSpeedValueSpan = options.elements.ttsSpeedValueSpan;

            // --- New Regex Modal Elements ---
            regexRuleModal = document.getElementById('regexRuleModal');
            regexRuleForm = document.getElementById('regexRuleForm');
            editingRegexRuleId = document.getElementById('editingRegexRuleId');
            regexRuleTitle = document.getElementById('regexRuleTitle');
            regexRuleFind = document.getElementById('regexRuleFind');
            regexRuleReplace = document.getElementById('regexRuleReplace');
            regexRuleMinDepth = document.getElementById('regexRuleMinDepth');
            regexRuleMaxDepth = document.getElementById('regexRuleMaxDepth');
            cancelRegexRuleBtn = document.getElementById('cancelRegexRule');
            closeRegexRuleModalBtn = document.getElementById('closeRegexRuleModal');

            // Event Listeners
            if (agentSettingsForm) {
                agentSettingsForm.addEventListener('submit', saveCurrentAgentSettings);
            }
            if (regexRuleForm) {
                regexRuleForm.addEventListener('submit', handleRegexFormSubmit);
            }
            if (cancelRegexRuleBtn) {
                cancelRegexRuleBtn.addEventListener('click', closeRegexModal);
            }
            if (closeRegexRuleModalBtn) {
                closeRegexRuleModalBtn.addEventListener('click', closeRegexModal);
            }
            if (regexRuleModal) {
                regexRuleModal.addEventListener('click', (e) => {
                    if (e.target === regexRuleModal) {
                        closeRegexModal();
                    }
                });
            }
            if (deleteItemBtn) {
                deleteItemBtn.addEventListener('click', handleDeleteCurrentItem);
            }
            if(agentAvatarInput){
                agentAvatarInput.addEventListener('change', (event) => {
                    const file = event.target.files[0];
                    if (file) {
                        uiHelper.openAvatarCropper(file, (croppedFileResult) => {
                            mainRendererFunctions.setCroppedFile('agent', croppedFileResult);
                            if (agentAvatarPreview) {
                                agentAvatarPreview.src = URL.createObjectURL(croppedFileResult);
                                agentAvatarPreview.style.display = 'block';
                            }
                        }, 'agent');
                    } else {
                        if(agentAvatarPreview) agentAvatarPreview.style.display = 'none';
                        mainRendererFunctions.setCroppedFile('agent', null);
                    }
                });
            }

            if (openModelSelectBtn) {
                openModelSelectBtn.addEventListener('click', () => handleOpenModelSelect(agentModelInput));
            }
            if (openTopicSummaryModelSelectBtn) {
                openTopicSummaryModelSelectBtn.addEventListener('click', () => handleOpenModelSelect(topicSummaryModelInput));
            }
            if (modelSearchInput) {
                modelSearchInput.addEventListener('input', filterModels);
            }
            if (refreshModelsBtn) {
                refreshModelsBtn.addEventListener('click', handleRefreshModels);
            }
            if (electronAPI.onModelsUpdated) {
                electronAPI.onModelsUpdated((models) => {
                    console.log('[SettingsManager] Received models-updated event. Repopulating list.');
                    populateModelList(models);
                    uiHelper.showToastNotification('模型列表已刷新', 'success');
                });
            }
            
            if (agentTtsSpeedSlider && ttsSpeedValueSpan) {
                agentTtsSpeedSlider.addEventListener('input', () => {
                    ttsSpeedValueSpan.textContent = parseFloat(agentTtsSpeedSlider.value).toFixed(1);
                });
            }

            if (refreshTtsModelsBtn) {
                refreshTtsModelsBtn.addEventListener('click', async () => {
                    uiHelper.showToastNotification('正在刷新语音模型...', 'info');
                    try {
                        await electronAPI.sovitsGetModels(true); // force refresh
                        await populateTtsModels(agentTtsVoicePrimarySelect.value, agentTtsVoiceSecondarySelect.value); // repopulate
                        uiHelper.showToastNotification('语音模型列表已刷新', 'success');
                    } catch (e) {
                        uiHelper.showToastNotification('刷新语音模型失败', 'error');
                    }
                });
            }

            // 创建正则设置UI
            createStripRegexUI();
            
            console.log('settingsManager initialized.');

            // --- Global Settings Enhancements ---
            const vcpServerUrlInput = document.getElementById('vcpServerUrl');
            if (vcpServerUrlInput) {
                vcpServerUrlInput.addEventListener('blur', () => {
                    const completedUrl = completeVcpUrl(vcpServerUrlInput.value);
                    vcpServerUrlInput.value = completedUrl;
                });
            }
        },
        displaySettingsForItem: displaySettingsForItem,
        populateAssistantAgentSelect: populateAssistantAgentSelect,
        // Expose for external use if needed, e.g., in the save function
        completeVcpUrl: completeVcpUrl
    };

    /**
     * Opens the model selection modal and populates it with cached models.
     */
    async function handleOpenModelSelect(targetInputElement) {
        try {
            const models = await electronAPI.getCachedModels();
            populateModelList(models, (modelId) => {
                if (targetInputElement) {
                    targetInputElement.value = modelId;
                }
                uiHelper.closeModal('modelSelectModal');
            });
            uiHelper.openModal('modelSelectModal');
        } catch (error) {
            console.error('Failed to get cached models:', error);
            uiHelper.showToastNotification('获取模型列表失败', 'error');
        }
    }

    /**
     * Populates the model list in the modal.
     * @param {Array} models - An array of model objects.
     */
    function populateModelList(models, onModelSelect) {
        if (!modelList) return;
        modelList.innerHTML = ''; // Clear existing list

        if (!models || models.length === 0) {
            modelList.innerHTML = '<li>没有可用的模型。请检查您的 VCP 服务器 URL 或刷新列表。</li>';
            return;
        }

        models.forEach(model => {
            const li = document.createElement('li');
            li.textContent = model.id;
            li.dataset.modelId = model.id;
            li.addEventListener('click', () => {
                if (typeof onModelSelect === 'function') {
                    onModelSelect(model.id);
                }
            });
            modelList.appendChild(li);
        });
    }

    /**
     * Filters the model list based on the search input.
     */
    function filterModels() {
        const filter = modelSearchInput.value.toLowerCase();
        const items = modelList.getElementsByTagName('li');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const txtValue = item.textContent || item.innerText;
            if (txtValue.toLowerCase().indexOf(filter) > -1) {
                item.style.display = "";
            } else {
                item.style.display = "none";
            }
        }
    }

    /**
     * Handles the refresh models button click.
     */
    function handleRefreshModels() {
        if (electronAPI.refreshModels) {
            electronAPI.refreshModels();
            uiHelper.showToastNotification('正在刷新模型列表...', 'info');
        }
    }

    /**
     * Creates the strip regex UI section
     */
    // --- Regex Settings V2 ---

    function createStripRegexUI() {
        const ttsSpeedContainer = document.querySelector('.slider-container');
        if (!ttsSpeedContainer) return;

        const divider = document.createElement('hr');
        divider.className = 'form-divider';
        
        const container = document.createElement('div');
        container.className = 'form-group strip-regex-container';

        const title = document.createElement('div');
        title.className = 'form-section-title';
        title.textContent = '正则设置';
        container.appendChild(title);

        stripRegexListContainer = document.createElement('div');
        stripRegexListContainer.id = 'stripRegexListContainer';
        stripRegexListContainer.className = 'strip-regex-list-container';
        container.appendChild(stripRegexListContainer);

        // 添加正则按钮
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '添加正则';  // 改为"添加正则"
        addBtn.className = 'btn-add-regex';
        addBtn.addEventListener('click', () => openRegexModal());
        container.appendChild(addBtn);

        // 导入正则按钮（放在添加正则按钮下方）
        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.textContent = '导入正则';
        importBtn.className = 'btn-add-regex';  // 使用与"添加正则"相同的样式
        importBtn.style.marginTop = '8px';  // 添加上边距
        importBtn.addEventListener('click', () => handleImportRegex());
        container.appendChild(importBtn);
        
        const parent = ttsSpeedContainer.parentNode;
        parent.insertBefore(divider, ttsSpeedContainer.nextSibling);
        parent.insertBefore(container, divider.nextSibling);

        // 创建预设消息UI
        createPresetMessageUI();
    }

    function renderRegexList() {
        if (!stripRegexListContainer) return;
        stripRegexListContainer.innerHTML = '';
        currentAgentRegexes.forEach(rule => {
            const row = createRegexRow(rule);
            stripRegexListContainer.appendChild(row);
        });
    }

    function createRegexRow(rule) {
        const row = document.createElement('div');
        row.className = 'strip-regex-row';
        row.dataset.ruleId = rule.id;

        const title = document.createElement('span');
        title.className = 'strip-regex-title';
        title.textContent = rule.title || '(无标题)';
        title.title = rule.findPattern || '无查找内容';

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.display = 'flex';
        buttonsContainer.style.gap = '8px';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-edit-regex';  // 保持原始样式类，保持主题适应性
        editBtn.title = '编辑规则';
        // 调整为与删除按钮完全相同的大小（38x38px）
        editBtn.style.height = '38px';    // 与删除按钮相同高度
        editBtn.style.width = '38px';     // 与删除按钮相同宽度
        editBtn.style.minHeight = '38px';
        editBtn.style.minWidth = '38px';
        editBtn.style.padding = '0';      // 与删除按钮相同的内边距
        editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        editBtn.addEventListener('click', () => openRegexModal(rule));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-regex';
        deleteBtn.title = '删除规则';
        deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
        deleteBtn.addEventListener('click', () => {
            if (confirm(`确定要删除规则 "${rule.title}" 吗？`)) {
                currentAgentRegexes = currentAgentRegexes.filter(r => r.id !== rule.id);
                renderRegexList();
            }
        });

        buttonsContainer.appendChild(editBtn);
        buttonsContainer.appendChild(deleteBtn);
        row.appendChild(title);
        row.appendChild(buttonsContainer);
        return row;
    }

    function openRegexModal(ruleData = null) {
        regexRuleForm.reset();
        if (ruleData) {
            // Edit mode
            editingRegexRuleId.value = ruleData.id;
            regexRuleTitle.value = ruleData.title || '';
            regexRuleFind.value = ruleData.findPattern || '';
            regexRuleReplace.value = ruleData.replaceWith || '';
            
            (ruleData.applyToRoles || []).forEach(role => {
                const checkbox = regexRuleForm.querySelector(`input[name="applyToRoles"][value="${role}"]`);
                if (checkbox) checkbox.checked = true;
            });

            // 设置应用范围
            if (ruleData.applyToFrontend !== undefined) {
                document.getElementById('applyToFrontend').checked = ruleData.applyToFrontend;
            } else if (ruleData.applyToScopes) {
                // 兼容旧数据结构
                document.getElementById('applyToFrontend').checked = ruleData.applyToScopes.includes('frontend');
            } else {
                document.getElementById('applyToFrontend').checked = true;
            }
            
            if (ruleData.applyToContext !== undefined) {
                document.getElementById('applyToContext').checked = ruleData.applyToContext;
            } else if (ruleData.applyToScopes) {
                // 兼容旧数据结构
                document.getElementById('applyToContext').checked = ruleData.applyToScopes.includes('context');
            } else {
                document.getElementById('applyToContext').checked = true;
            }

            regexRuleMinDepth.value = ruleData.minDepth !== undefined ? ruleData.minDepth : 0;
            regexRuleMaxDepth.value = ruleData.maxDepth !== undefined ? ruleData.maxDepth : -1;
        } else {
            // New rule mode
            editingRegexRuleId.value = '';
            regexRuleMinDepth.value = 0;
            regexRuleMaxDepth.value = -1;
        }
        regexRuleModal.style.display = 'block';
    }

    function closeRegexModal() {
        regexRuleModal.style.display = 'none';
    }

    function handleRegexFormSubmit(event) {
        event.preventDefault();
        
        const id = editingRegexRuleId.value || `rule_${Date.now()}`;
        const title = regexRuleTitle.value.trim();
        const findPattern = regexRuleFind.value.trim();

        if (!title || !findPattern) {
            uiHelper.showToastNotification('规则标题和查找内容不能为空！', 'error');
            return;
        }

        const newRule = {
            id,
            title,
            findPattern,
            replaceWith: regexRuleReplace.value,
            applyToRoles: Array.from(regexRuleForm.querySelectorAll('input[name="applyToRoles"]:checked')).map(cb => cb.value),
            applyToFrontend: document.getElementById('applyToFrontend').checked,
            applyToContext: document.getElementById('applyToContext').checked,
            minDepth: parseInt(regexRuleMinDepth.value, 10),
            maxDepth: parseInt(regexRuleMaxDepth.value, 10)
        };

        const existingIndex = currentAgentRegexes.findIndex(r => r.id === id);
        if (existingIndex > -1) {
            currentAgentRegexes[existingIndex] = newRule;
        } else {
            currentAgentRegexes.push(newRule);
        }

        renderRegexList();
        closeRegexModal();
    }

    /**
     * 处理导入正则规则（暂时未实现）
     */
    async function handleImportRegex() {
        const agentId = editingAgentIdInput.value;
        if (!agentId) {
            uiHelper.showToastNotification('请先选择一个Agent。', 'warning');
            return;
        }

        try {
            const result = await electronAPI.importRegexRules(agentId);

            if (result.success) {
                currentAgentRegexes = result.rules;
                renderRegexList();
                uiHelper.showToastNotification('正则规则导入成功！', 'success');
            } else if (!result.canceled) {
                // Don't show an error if the user just canceled the dialog
                uiHelper.showToastNotification(`导入失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('导入正则规则时发生意外错误:', error);
            uiHelper.showToastNotification(`导入失败: ${error.message}`, 'error');
        }
    }

    /**
     * 创建预设消息UI
     */
    function createPresetMessageUI() {
        const formActions = document.querySelector('.form-actions');
        if (!formActions) return;

        // 创建分隔线
        const divider = document.createElement('hr');
        divider.className = 'form-divider';

        // 创建预设消息容器
        const container = document.createElement('div');
        container.className = 'form-group preset-message-container';

        const title = document.createElement('div');
        title.className = 'form-section-title';
        title.textContent = '预设消息';
        container.appendChild(title);

        // 创建启用开关
        const enableContainer = document.createElement('div');
        enableContainer.className = 'form-group-inline';
        enableContainer.style.justifyContent = 'space-between';
        enableContainer.style.alignItems = 'center';
        enableContainer.style.marginBottom = '15px';

        const enableLabel = document.createElement('label');
        enableLabel.textContent = '启用预设消息';

        const enableSwitch = document.createElement('label');
        enableSwitch.className = 'switch';

        const enableCheckbox = document.createElement('input');
        enableCheckbox.type = 'checkbox';
        enableCheckbox.id = 'enablePresetMessage';

        const slider = document.createElement('span');
        slider.className = 'slider round';

        enableSwitch.appendChild(enableCheckbox);
        enableSwitch.appendChild(slider);

        enableContainer.appendChild(enableLabel);
        enableContainer.appendChild(enableSwitch);
        container.appendChild(enableContainer);

        // Add event listener for the enable switch
        enableCheckbox.addEventListener('change', () => {
            savePresetMessageEnabledState(enableCheckbox.checked);
        });

        // 创建预设消息列表容器
        const listContainer = document.createElement('div');
        listContainer.id = 'presetMessageListContainer';
        listContainer.className = 'preset-message-list-container';
        container.appendChild(listContainer);

        // 创建按钮容器
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'preset-message-buttons';
        buttonsContainer.style.display = 'flex';
        buttonsContainer.style.gap = '8px';
        buttonsContainer.style.marginTop = '10px';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '添加预设消息';
        addBtn.className = 'btn-add-regex';
        addBtn.style.flex = '1';
        addBtn.addEventListener('click', () => openPresetMessageModal());

        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.textContent = '导入预设消息';
        importBtn.className = 'btn-add-regex';
        importBtn.style.flex = '1';
        importBtn.addEventListener('click', () => handleImportPresetMessage());

        buttonsContainer.appendChild(addBtn);
        buttonsContainer.appendChild(importBtn);
        container.appendChild(buttonsContainer);

        // 添加底部分隔线，用于与保存按钮分离
        const bottomDivider = document.createElement('hr');
        bottomDivider.className = 'form-divider';
        bottomDivider.style.marginTop = '15px';
        bottomDivider.style.marginBottom = '15px';
        container.appendChild(bottomDivider);

        // 插入到表单操作按钮之前
        const parent = formActions.parentNode;
        parent.insertBefore(divider, formActions);
        parent.insertBefore(container, formActions);
    }

    function renderPresetMessageList() {
        const listContainer = document.getElementById('presetMessageListContainer');
        if (!listContainer) return;

        listContainer.innerHTML = '';

        if (currentAgentPresetMessages.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.textContent = '暂无首条消息，支持设置多条';
            emptyMessage.style.textAlign = 'center';
            emptyMessage.style.color = 'var(--secondary-text)';
            emptyMessage.style.padding = '20px';
            listContainer.appendChild(emptyMessage);
            return;
        }

        currentAgentPresetMessages.forEach(message => {
            const row = createPresetMessageRow(message);
            listContainer.appendChild(row);
        });
    }

    function createPresetMessageRow(message) {
        const row = document.createElement('div');
        row.className = 'preset-message-row';
        row.dataset.messageId = message.id;
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.marginBottom = '8px';
        row.style.padding = '12px';
        row.style.border = '1px solid var(--border-color)';
        row.style.borderRadius = '8px';
        row.style.backgroundColor = 'var(--input-bg)';

        // 左边容器 (1/4宽度)
        const leftContainer = document.createElement('div');
        leftContainer.style.flex = '1';
        leftContainer.style.display = 'flex';
        leftContainer.style.flexDirection = 'column';
        leftContainer.style.gap = '4px';

        // 角色选择
        const roleContainer = document.createElement('div');
        const roleSelect = document.createElement('select');
        roleSelect.className = 'preset-message-role';
        roleSelect.style.width = '100%';
        roleSelect.style.padding = '4px 8px';
        roleSelect.style.border = '1px solid var(--border-color)';
        roleSelect.style.borderRadius = '4px';
        roleSelect.style.backgroundColor = 'var(--input-bg)';
        roleSelect.style.color = 'var(--primary-text)';
        roleSelect.style.fontSize = '0.9em';

        const roles = [
            { value: 'user', text: '用户' },
            { value: 'assistant', text: '助手' },
            { value: 'system', text: '系统' }
        ];

        roles.forEach(role => {
            const option = document.createElement('option');
            option.value = role.value;
            option.textContent = role.text;
            if (message.role === role.value) {
                option.selected = true;
            }
            roleSelect.appendChild(option);
        });

        roleSelect.addEventListener('change', (e) => {
            message.role = e.target.value;
            savePresetMessagesToAgent();
        });

        roleContainer.appendChild(roleSelect);

        // 名字设定
        const nameContainer = document.createElement('div');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'preset-message-name';
        nameInput.placeholder = '角色名字（可选）';
        nameInput.value = message.name || '';
        nameInput.style.width = '100%';
        nameInput.style.padding = '4px 8px';
        nameInput.style.border = '1px solid var(--border-color)';
        nameInput.style.borderRadius = '4px';
        nameInput.style.backgroundColor = 'var(--input-bg)';
        nameInput.style.color = 'var(--primary-text)';
        nameInput.style.fontSize = '0.9em';

        nameInput.addEventListener('input', (e) => {
            message.name = e.target.value;
            savePresetMessagesToAgent();
        });

        nameContainer.appendChild(nameInput);

        // 删除按钮
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-regex';
        deleteBtn.title = '删除预设消息';
        deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
        deleteBtn.addEventListener('click', () => {
            if (confirm(`确定要删除这条预设消息吗？`)) {
                currentAgentPresetMessages = currentAgentPresetMessages.filter(m => m.id !== message.id);
                renderPresetMessageList();
                savePresetMessagesToAgent();
            }
        });

        leftContainer.appendChild(roleContainer);
        leftContainer.appendChild(nameContainer);
        leftContainer.appendChild(deleteBtn);

        // 右边容器 (3/4宽度)
        const rightContainer = document.createElement('div');
        rightContainer.style.flex = '3';

        const contentTextarea = document.createElement('textarea');
        contentTextarea.className = 'preset-message-content';
        contentTextarea.placeholder = '消息内容';
        contentTextarea.value = message.content || '';
        contentTextarea.style.width = '100%';
        contentTextarea.style.minHeight = '80px';
        contentTextarea.style.padding = '8px';
        contentTextarea.style.border = '1px solid var(--border-color)';
        contentTextarea.style.borderRadius = '4px';
        contentTextarea.style.backgroundColor = 'var(--input-bg)';
        contentTextarea.style.color = 'var(--primary-text)';
        contentTextarea.style.fontSize = '0.9em';
        contentTextarea.style.resize = 'vertical';

        contentTextarea.addEventListener('input', (e) => {
            message.content = e.target.value;
            savePresetMessagesToAgent();
        });

        rightContainer.appendChild(contentTextarea);

        row.appendChild(leftContainer);
        row.appendChild(rightContainer);

        return row;
    }

    function openPresetMessageModal(messageData = null) {
        // 创建模态框
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'presetMessageModal';
        modal.style.display = 'block';

        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content';
        modalContent.style.maxWidth = '600px';

        const closeBtn = document.createElement('span');
        closeBtn.className = 'close-button';
        closeBtn.innerHTML = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '10px';
        closeBtn.style.right = '15px';
        closeBtn.style.fontSize = '24px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.addEventListener('click', () => {
            document.body.removeChild(modal);
        });

        const title = document.createElement('h2');
        title.textContent = messageData ? '编辑预设消息' : '添加预设消息';
        title.style.marginTop = '0';

        const form = document.createElement('form');
        form.id = 'presetMessageForm';
        form.style.display = 'flex';
        form.style.flexDirection = 'column';
        form.style.gap = '15px';

        // 角色选择
        const roleGroup = document.createElement('div');
        const roleLabel = document.createElement('label');
        roleLabel.textContent = '角色:';
        roleLabel.style.fontWeight = '500';
        roleLabel.style.color = 'var(--secondary-text)';
        roleLabel.style.fontSize = '0.9em';
        roleLabel.style.marginBottom = '4px';
        roleLabel.style.display = 'block';

        const roleSelect = document.createElement('select');
        roleSelect.id = 'modalMessageRole';
        roleSelect.style.width = '100%';
        roleSelect.style.padding = '9px 10px';
        roleSelect.style.border = '1px solid var(--border-color)';
        roleSelect.style.borderRadius = '8px';
        roleSelect.style.backgroundColor = 'var(--input-bg)';
        roleSelect.style.color = 'var(--primary-text)';

        const roles = [
            { value: 'user', text: '用户' },
            { value: 'assistant', text: '助手' },
            { value: 'system', text: '系统' }
        ];

        roles.forEach(role => {
            const option = document.createElement('option');
            option.value = role.value;
            option.textContent = role.text;
            if (messageData && messageData.role === role.value) {
                option.selected = true;
            }
            roleSelect.appendChild(option);
        });

        roleGroup.appendChild(roleLabel);
        roleGroup.appendChild(roleSelect);

        // 名字设定
        const nameGroup = document.createElement('div');
        const nameLabel = document.createElement('label');
        nameLabel.textContent = '角色名字（可选）:';
        nameLabel.style.fontWeight = '500';
        nameLabel.style.color = 'var(--secondary-text)';
        nameLabel.style.fontSize = '0.9em';
        nameLabel.style.marginBottom = '4px';
        nameLabel.style.display = 'block';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = 'modalMessageName';
        nameInput.placeholder = '角色名字（可选）';
        nameInput.value = messageData ? (messageData.name || '') : '';
        nameInput.style.width = '100%';
        nameInput.style.padding = '9px 10px';
        nameInput.style.border = '1px solid var(--border-color)';
        nameInput.style.borderRadius = '8px';
        nameInput.style.backgroundColor = 'var(--input-bg)';
        nameInput.style.color = 'var(--primary-text)';

        nameGroup.appendChild(nameLabel);
        nameGroup.appendChild(nameInput);

        // 消息内容
        const contentGroup = document.createElement('div');
        const contentLabel = document.createElement('label');
        contentLabel.textContent = '消息内容:';
        contentLabel.style.fontWeight = '500';
        contentLabel.style.color = 'var(--secondary-text)';
        contentLabel.style.fontSize = '0.9em';
        contentLabel.style.marginBottom = '4px';
        contentLabel.style.display = 'block';

        const contentTextarea = document.createElement('textarea');
        contentTextarea.id = 'modalMessageContent';
        contentTextarea.placeholder = '消息内容';
        contentTextarea.value = messageData ? (messageData.content || '') : '';
        contentTextarea.style.width = '100%';
        contentTextarea.style.minHeight = '120px';
        contentTextarea.style.padding = '9px 10px';
        contentTextarea.style.border = '1px solid var(--border-color)';
        contentTextarea.style.borderRadius = '8px';
        contentTextarea.style.backgroundColor = 'var(--input-bg)';
        contentTextarea.style.color = 'var(--primary-text)';
        contentTextarea.style.resize = 'vertical';

        contentGroup.appendChild(contentLabel);
        contentGroup.appendChild(contentTextarea);

        // 按钮容器
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'form-actions';
        actionsContainer.style.marginTop = '10px';
        actionsContainer.style.display = 'flex';
        actionsContainer.style.justifyContent = 'flex-end';
        actionsContainer.style.gap = '10px';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.className = 'button-secondary';
        cancelBtn.style.backgroundColor = 'var(--button-bg)';
        cancelBtn.style.color = 'var(--primary-text)';
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(modal);
        });

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.textContent = messageData ? '保存修改' : '添加消息';
        submitBtn.style.backgroundColor = 'var(--user-bubble-bg)';
        submitBtn.style.color = 'white';

        actionsContainer.appendChild(cancelBtn);
        actionsContainer.appendChild(submitBtn);

        form.appendChild(roleGroup);
        form.appendChild(nameGroup);
        form.appendChild(contentGroup);
        form.appendChild(actionsContainer);

        form.addEventListener('submit', (e) => {
            e.preventDefault();

            const role = roleSelect.value;
            const name = nameInput.value.trim();
            const content = contentTextarea.value.trim();

            if (!content) {
                uiHelper.showToastNotification('消息内容不能为空！', 'error');
                return;
            }

            if (messageData) {
                // 编辑模式
                messageData.role = role;
                messageData.name = name;
                messageData.content = content;
            } else {
                // 新增模式
                const newMessage = {
                    id: `preset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    role,
                    name,
                    content
                };
                currentAgentPresetMessages.push(newMessage);
            }

            renderPresetMessageList();
            savePresetMessagesToAgent();
            document.body.removeChild(modal);
        });

        modalContent.appendChild(closeBtn);
        modalContent.appendChild(title);
        modalContent.appendChild(form);

        modal.appendChild(modalContent);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });

        document.body.appendChild(modal);

        // 聚焦到内容输入框
        contentTextarea.focus();
    }

    function savePresetMessagesToAgent() {
        const agentId = editingAgentIdInput.value;
        if (!agentId) return;

        // 这里可以立即保存到Agent配置中，或者等到用户点击保存按钮时再保存
        // 为了更好的用户体验，我们选择立即保存
        const agentConfig = {
            presetMessages: currentAgentPresetMessages
        };

        electronAPI.saveAgentConfig(agentId, agentConfig).then(result => {
            if (result.success) {
                console.log('预设消息已保存');
            } else {
                console.error('保存预设消息失败:', result.error);
                uiHelper.showToastNotification(`保存预设消息失败: ${result.error}`, 'error');
            }
        }).catch(error => {
            console.error('保存预设消息时出错:', error);
            uiHelper.showToastNotification(`保存预设消息出错: ${error.message}`, 'error');
        });
    }

    function savePresetMessageEnabledState(enabled) {
        const agentId = editingAgentIdInput.value;
        if (!agentId) return;

        // 立即保存启用状态到Agent配置中
        const agentConfig = {
            presetMessageEnabled: enabled,
            presetMessages: currentAgentPresetMessages
        };

        electronAPI.saveAgentConfig(agentId, agentConfig).then(result => {
            if (result.success) {
                console.log(`预设消息启用状态已保存: ${enabled}`);
            } else {
                console.error('保存预设消息启用状态失败:', result.error);
                uiHelper.showToastNotification(`保存预设消息启用状态失败: ${result.error}`, 'error');
                // 恢复开关状态
                const enableCheckbox = document.getElementById('enablePresetMessage');
                if (enableCheckbox) {
                    enableCheckbox.checked = !enabled;
                }
            }
        }).catch(error => {
            console.error('保存预设消息启用状态时出错:', error);
            uiHelper.showToastNotification(`保存预设消息启用状态出错: ${error.message}`, 'error');
            // 恢复开关状态
            const enableCheckbox = document.getElementById('enablePresetMessage');
            if (enableCheckbox) {
                enableCheckbox.checked = !enabled;
            }
        });
    }

    /**
     * 处理导入预设消息（暂时未实现）
     */
    async function handleImportPresetMessage() {
        const agentId = editingAgentIdInput.value;
        if (!agentId) {
            uiHelper.showToastNotification('请先选择一个Agent。', 'warning');
            return;
        }

        try {
            const result = await electronAPI.importPresetMessages(agentId);

            if (result.success) {
                currentAgentPresetMessages = result.messages;
                renderPresetMessageList();
                uiHelper.showToastNotification('预设消息导入成功！', 'success');
            } else if (!result.canceled) {
                uiHelper.showToastNotification(`导入失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('导入预设消息时发生意外错误:', error);
            uiHelper.showToastNotification(`导入失败: ${error.message}`, 'error');
        }
    }
})();

window.settingsManager = settingsManager;