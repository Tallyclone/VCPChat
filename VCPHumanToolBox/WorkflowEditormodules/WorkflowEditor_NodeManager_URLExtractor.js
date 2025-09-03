// URL提取器节点实现
// 专门用于从各种格式的数据中提取URL并标准化输出

(function() {
    'use strict';

    // 扩展WorkflowEditor_NodeManager类的URL提取功能
    if (window.WorkflowEditor_NodeManager) {
        const nodeManager = window.WorkflowEditor_NodeManager;

        // 执行URL提取节点
        nodeManager.executeUrlExtractorNode = async function(node, inputData) {
            const { urlTypes, deduplication, outputFormat, outputParamName } = node.config;
            const input = inputData.input || inputData;

            if (!input) {
                throw new Error('Input data is required for URL extraction');
            }

            try {
                console.log(`[URLExtractor] 开始提取URL:`, input);
                console.log(`[URLExtractor] 配置参数:`, { urlTypes, deduplication, outputFormat, outputParamName });

                // 提取所有URL
                const extractedUrls = this.extractAllUrls(input, urlTypes || ['image']);
                console.log(`[URLExtractor] 原始提取结果:`, extractedUrls);

                // 去重处理
                let finalUrls = extractedUrls;
                if (deduplication !== false) {
                    finalUrls = [...new Set(extractedUrls)];
                    console.log(`[URLExtractor] 去重后结果:`, finalUrls);
                }

                // 格式化输出，传递 outputParamName
                const result = this.formatUrlOutput(finalUrls, outputFormat || 'array', outputParamName);
                
                // 在节点UI中显示提取结果
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeElement) {
                    this.displayExtractionResult(nodeElement, result);
                }

                return {
                    ...result,
                    originalData: input,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                throw new Error(`URL extraction failed: ${error.message}`);
            }
        };

        // 从各种数据格式中提取URL
        nodeManager.extractAllUrls = function(data, urlTypes) {
            const urls = [];
            
            // 1. 如果输入直接是字符串URL
            if (typeof data === 'string' && this.isValidUrl(data)) {
                if (this.matchesUrlType(data, urlTypes)) {
                    urls.push(data);
                }
                return urls;
            }

            // 2. 如果输入是URL数组
            if (Array.isArray(data)) {
                data.forEach(item => {
                    const extractedFromItem = this.extractAllUrls(item, urlTypes);
                    urls.push(...extractedFromItem);
                });
                return urls;
            }

            // 3. 如果输入是对象，递归查找URL
            if (typeof data === 'object' && data !== null) {
                this.extractUrlsFromObject(data, urls, urlTypes);
            }

            // 4. 如果输入是字符串（可能包含HTML或文本中的URL）
            if (typeof data === 'string') {
                this.extractUrlsFromText(data, urls, urlTypes);
            }

            return urls;
        };

        // 从对象中递归提取URL
        nodeManager.extractUrlsFromObject = function(obj, urls, urlTypes) {
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const value = obj[key];
                    
                    // 检查常见的URL字段名
                    if (this.isUrlField(key) && typeof value === 'string' && this.isValidUrl(value)) {
                        if (this.matchesUrlType(value, urlTypes)) {
                            urls.push(value);
                        }
                    }
                    // 递归处理嵌套对象和数组
                    else if (typeof value === 'object' && value !== null) {
                        this.extractUrlsFromObject(value, urls, urlTypes);
                    }
                    else if (Array.isArray(value)) {
                        value.forEach(item => {
                            if (typeof item === 'string' && this.isValidUrl(item)) {
                                if (this.matchesUrlType(item, urlTypes)) {
                                    urls.push(item);
                                }
                            } else if (typeof item === 'object' && item !== null) {
                                this.extractUrlsFromObject(item, urls, urlTypes);
                            }
                        });
                    }
                }
            }
        };

        // 从文本中提取URL（包括HTML）
        nodeManager.extractUrlsFromText = function(text, urls, urlTypes) {
            // URL正则表达式 - 匹配http/https URL
            const urlRegex = /https?:\/\/[^\s<>"']+/g;
            const matches = text.match(urlRegex);
            
            if (matches) {
                matches.forEach(url => {
                    // 清理URL（移除可能的HTML标签结尾符号）
                    const cleanUrl = url.replace(/[<>"']+$/, '');
                    if (this.isValidUrl(cleanUrl) && this.matchesUrlType(cleanUrl, urlTypes)) {
                        urls.push(cleanUrl);
                    }
                });
            }

            // 特殊处理：从HTML img标签中提取src
            const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
            let imgMatch;
            while ((imgMatch = imgRegex.exec(text)) !== null) {
                const imgUrl = imgMatch[1];
                if (this.isValidUrl(imgUrl) && this.matchesUrlType(imgUrl, urlTypes)) {
                    urls.push(imgUrl);
                }
            }
        };

        // 判断字段名是否可能包含URL
        nodeManager.isUrlField = function(fieldName) {
            const urlFieldNames = [
                'url', 'imageUrl', 'videoUrl', 'audioUrl', 'src', 'href', 'link',
                'image', 'video', 'audio', 'file', 'path', 'uri'
            ];
            const lowerFieldName = fieldName.toLowerCase();
            return urlFieldNames.some(name => lowerFieldName.includes(name));
        };

        // 检查URL是否匹配指定类型
        nodeManager.matchesUrlType = function(url, urlTypes) {
            if (!urlTypes || urlTypes.includes('all')) {
                return true;
            }

            const urlLower = url.toLowerCase();
            
            for (const type of urlTypes) {
                switch (type) {
                    case 'image':
                        if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)(\?|$)/i.test(urlLower)) {
                            return true;
                        }
                        break;
                    case 'video':
                        if (/\.(mp4|avi|mov|wmv|flv|webm|mkv)(\?|$)/i.test(urlLower)) {
                            return true;
                        }
                        break;
                    case 'audio':
                        if (/\.(mp3|wav|ogg|aac|flac|m4a)(\?|$)/i.test(urlLower)) {
                            return true;
                        }
                        break;
                }
            }
            
            return false;
        };

        // 格式化输出结果
        nodeManager.formatUrlOutput = function(urls, outputFormat, outputParamName) {
            const urlFieldName = outputParamName || 'url'; // 使用自定义参数名或默认 'url'
            
            switch (outputFormat) {
                case 'single':
                    return {
                        [urlFieldName]: urls.length > 0 ? urls[0] : null,
                        count: urls.length
                    };
                
                case 'object':
                    return {
                        [urlFieldName]: urls,
                        count: urls.length,
                        types: this.analyzeUrlTypes(urls),
                        extractedAt: new Date().toISOString()
                    };
                
                case 'array':
                default:
                    return {
                        [urlFieldName]: urls,
                        count: urls.length
                    };
            }
        };

        // 分析URL类型分布
        nodeManager.analyzeUrlTypes = function(urls) {
            const types = { image: 0, video: 0, audio: 0, other: 0 };
            
            urls.forEach(url => {
                if (this.matchesUrlType(url, ['image'])) {
                    types.image++;
                } else if (this.matchesUrlType(url, ['video'])) {
                    types.video++;
                } else if (this.matchesUrlType(url, ['audio'])) {
                    types.audio++;
                } else {
                    types.other++;
                }
            });
            
            return types;
        };

        // 在节点UI中显示提取结果
        nodeManager.displayExtractionResult = function(nodeElement, result) {
            let displayArea = nodeElement.querySelector('.url-extraction-display');
            
            if (!displayArea) {
                displayArea = document.createElement('div');
                displayArea.className = 'url-extraction-display';
                displayArea.style.cssText = `
                    margin: 8px 0;
                    padding: 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 4px;
                    font-size: 11px;
                    color: #ccc;
                    max-height: 200px;
                    overflow-y: auto;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(displayArea);
            }

            // 构建显示内容
            let displayHtml = `
                <div style="margin-bottom: 6px; font-weight: bold; color: #4CAF50;">
                    ✓ 提取完成: ${result.count} 个URL
                </div>
            `;

            if (result.types) {
                const typeInfo = [];
                if (result.types.image > 0) typeInfo.push(`图片: ${result.types.image}`);
                if (result.types.video > 0) typeInfo.push(`视频: ${result.types.video}`);
                if (result.types.audio > 0) typeInfo.push(`音频: ${result.types.audio}`);
                if (result.types.other > 0) typeInfo.push(`其他: ${result.types.other}`);
                
                if (typeInfo.length > 0) {
                    displayHtml += `<div style="margin-bottom: 6px; color: #888;">${typeInfo.join(', ')}</div>`;
                }
            }

            if (result.urls && result.urls.length > 0) {
                displayHtml += '<div style="margin-top: 6px;">';
                result.urls.slice(0, 5).forEach((url, index) => {
                    const shortUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
                    displayHtml += `
                        <div style="margin: 2px 0; padding: 2px 4px; background: #333; border-radius: 2px; font-family: monospace;">
                            ${index + 1}. ${shortUrl}
                        </div>
                    `;
                });
                
                if (result.urls.length > 5) {
                    displayHtml += `<div style="margin: 4px 0; color: #888; font-style: italic;">... 还有 ${result.urls.length - 5} 个URL</div>`;
                }
                displayHtml += '</div>';
            }

            displayArea.innerHTML = displayHtml;
        };

        console.log('[URLExtractor] URL提取器节点已加载');
    }
})();