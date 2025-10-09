// renderer_modules/config.js

// --- 工具定义 (基于 supertool.txt) ---
export const tools = {
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