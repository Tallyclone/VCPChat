// URL渲染器简化版本
// 专注于单条和多条URL的基本渲染功能

(function() {
    'use strict';

    // 扩展WorkflowEditor_NodeManager类的URL渲染功能
    if (window.WorkflowEditor_NodeManager) {
        const nodeManager = window.WorkflowEditor_NodeManager;

        // 执行URL渲染节点 - 简化版本
        nodeManager.executeUrlRendererNode = async function(node, inputData) {
            const { urlPath, renderType, width, height } = node.config;
            const input = inputData.input || inputData;

            if (!input) {
                throw new Error('Input data is required for URL rendering');
            }

            try {
                console.log(`[URLRenderer] 开始处理输入数据:`, input);
                console.log(`[URLRenderer] 配置参数:`, { urlPath, renderType, width, height });

                // 提取URL数据
                const urlData = this.extractUrlData(input, urlPath || 'url');
                console.log(`[URLRenderer] 提取的URL数据:`, urlData);

                if (!urlData) {
                    throw new Error(`URL not found in input data using path: ${urlPath || 'url'}`);
                }

                // 判断是单个URL还是URL数组
                const isArray = Array.isArray(urlData);
                console.log(`[URLRenderer] 数据类型: ${isArray ? '数组' : '单个URL'}`);

                let renderResult;

                if (isArray) {
                    // 多条URL渲染
                    renderResult = await this.renderMultipleUrls(node, urlData, {
                        renderType, width, height
                    });
                } else {
                    // 单条URL渲染
                    renderResult = await this.renderSingleUrl(node, urlData, {
                        renderType, width, height
                    });
                }

                return {
                    ...renderResult,
                    originalData: input,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                throw new Error(`URL rendering failed: ${error.message}`);
            }
        };

        // 提取URL数据 - 简化版本
        nodeManager.extractUrlData = function(data, path) {
            console.log(`[URLRenderer] extractUrlData - data:`, data, `path:`, path);

            // 处理模板语法 {{xxx}} 或 {{input.xxx}}
            if (typeof path === 'string' && path.includes('{{') && path.includes('}}')) {
                console.log(`[URLRenderer] 检测到模板语法: ${path}`);
                
                const templateRegex = /\{\{(.*?)\}\}/;
                const match = path.match(templateRegex);
                
                if (match) {
                    const variablePath = match[1].trim();
                    console.log(`[URLRenderer] 解析模板变量路径: ${variablePath}`);
                    
                    // 支持 input.xxx 格式
                    let actualPath = variablePath;
                    if (variablePath.startsWith('input.')) {
                        actualPath = variablePath.substring(6);
                    }
                    
                    // 从输入数据中提取
                    const extractedData = this.getNestedProperty(data, actualPath);
                    console.log(`[URLRenderer] 模板解析结果:`, extractedData);
                    
                    if (extractedData !== undefined && extractedData !== null) {
                        return this.processUrlData(extractedData);
                    }
                }
            }

            // 如果输入直接是字符串URL
            if (typeof data === 'string' && this.isValidUrl(data)) {
                return data;
            }

            // 如果输入是URL数组
            if (Array.isArray(data)) {
                return this.processUrlData(data);
            }

            // 如果输入是对象，尝试从指定路径提取
            if (typeof data === 'object' && data !== null) {
                const extractedData = this.getNestedProperty(data, path);
                return this.processUrlData(extractedData);
            }

            return null;
        };

        // 处理URL数据
        nodeManager.processUrlData = function(data) {
            if (Array.isArray(data)) {
                // 如果是数组，提取其中的URL
                const urlArray = data.map(item => {
                    if (typeof item === 'string' && this.isValidUrl(item)) {
                        return item;
                    }
                    if (typeof item === 'object' && item !== null) {
                        return item.url || item.imageUrl || item.src;
                    }
                    return null;
                }).filter(url => url !== null);

                return urlArray.length > 0 ? urlArray : null;
            } else if (typeof data === 'string' && this.isValidUrl(data)) {
                return data;
            } else if (typeof data === 'object' && data !== null) {
                // 如果是对象，尝试提取URL字段
                return data.url || data.imageUrl || data.src;
            }

            return null;
        };

        // 获取嵌套属性
        nodeManager.getNestedProperty = function(obj, path) {
            if (!obj || typeof obj !== 'object' || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {
                if (current === null || typeof current !== 'object' || !current.hasOwnProperty(part)) {
                    return undefined;
                }
                current = current[part];
            }
            return current;
        };

        // 渲染单条URL
        nodeManager.renderSingleUrl = async function(node, url, config) {
            const { renderType, width = 300, height = 200 } = config;
            
            console.log(`[URLRenderer] 渲染单个URL: ${url}`);
            
            if (!this.isValidUrl(url)) {
                throw new Error(`Invalid URL: ${url}`);
            }

            // 检测URL类型
            const detectedType = renderType === 'auto' ? this.detectUrlType(url) : renderType;
            
            // 在节点UI中显示渲染结果
            const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeElement) {
                this.renderUrlInNode(nodeElement, url, detectedType, { width, height });
            }

            return {
                result: url,
                rendered: true,
                type: detectedType,
                count: 1
            };
        };

        // 渲染多条URL
        nodeManager.renderMultipleUrls = async function(node, urlArray, config) {
            const { renderType, width = 300, height = 200 } = config;
            
            console.log(`[URLRenderer] 渲染多个URL: ${urlArray.length} 个`);
            
            const validUrls = urlArray.filter(url => this.isValidUrl(url));
            
            if (validUrls.length === 0) {
                throw new Error('No valid URLs found in array');
            }

            // 在节点UI中显示渲染结果
            const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeElement) {
                this.renderMultipleUrlsInNode(nodeElement, validUrls, { renderType, width, height });
            }

            return {
                result: validUrls,
                rendered: true,
                type: 'multiple',
                count: validUrls.length
            };
        };

        // 在节点中渲染单个URL
        nodeManager.renderUrlInNode = function(nodeElement, url, type, config) {
            const { width, height } = config;
            
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    margin: 8px 0;
                    padding: 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 4px;
                    max-width: ${width + 20}px;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(renderArea);
            }

            let contentHtml = '';
            
            switch (type) {
                case 'image':
                    contentHtml = `
                        <div class="single-image-container">
                            <img src="${url}" alt="图片" 
                                 style="max-width: ${width}px; max-height: ${height}px; border-radius: 4px; cursor: pointer;"
                                 onclick="window.open('${url}', '_blank')"
                                 onerror="this.parentElement.innerHTML='<div style=\\'color: #ff6b6b; text-align: center; padding: 20px;\\'>图片加载失败</div>'" />
                            <div style="margin-top: 4px; font-size: 11px; color: #888; word-break: break-all;">
                                ${this.truncateUrl(url, 50)}
                            </div>
                        </div>
                    `;
                    break;

                case 'video':
                    contentHtml = `
                        <div class="single-video-container">
                            <video style="max-width: ${width}px; max-height: ${height}px; border-radius: 4px;" controls>
                                <source src="${url}" type="video/mp4">
                                您的浏览器不支持视频播放
                            </video>
                            <div style="margin-top: 4px; font-size: 11px; color: #888; word-break: break-all;">
                                ${this.truncateUrl(url, 50)}
                            </div>
                        </div>
                    `;
                    break;

                case 'iframe':
                    contentHtml = `
                        <div class="single-iframe-container">
                            <iframe src="${url}" 
                                    style="width: ${width}px; height: ${height}px; border: none; border-radius: 4px;">
                            </iframe>
                            <div style="margin-top: 4px; font-size: 11px; color: #888; word-break: break-all;">
                                ${this.truncateUrl(url, 50)}
                            </div>
                        </div>
                    `;
                    break;

                default:
                    contentHtml = `
                        <div class="single-link-container">
                            <div style="padding: 20px; text-align: center; background: #333; border-radius: 4px;">
                                <a href="${url}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500;">
                                    打开链接
                                </a>
                            </div>
                            <div style="margin-top: 4px; font-size: 11px; color: #888; word-break: break-all;">
                                ${this.truncateUrl(url, 50)}
                            </div>
                        </div>
                    `;
            }

            renderArea.innerHTML = contentHtml;
        };

        // 在节点中渲染多个URL
        nodeManager.renderMultipleUrlsInNode = function(nodeElement, urlArray, config) {
            const { renderType, width, height } = config;
            
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    margin: 8px 0;
                    padding: 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 4px;
                    max-height: 400px;
                    overflow-y: auto;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(renderArea);
            }

            let contentHtml = `
                <div style="margin-bottom: 8px; font-size: 12px; color: #ccc;">
                    共 ${urlArray.length} 个URL
                </div>
                <div class="multiple-urls-container" style="display: flex; flex-direction: column; gap: 8px;">
            `;

            urlArray.forEach((url, index) => {
                const detectedType = renderType === 'auto' ? this.detectUrlType(url) : renderType;
                
                let itemHtml = '';
                
                switch (detectedType) {
                    case 'image':
                        itemHtml = `
                            <div class="url-item" style="display: flex; align-items: center; gap: 8px; padding: 4px; background: #333; border-radius: 4px;">
                                <img src="${url}" alt="图片 ${index + 1}" 
                                     style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; cursor: pointer;"
                                     onclick="window.open('${url}', '_blank')"
                                     onerror="this.style.display='none'" />
                                <div style="flex: 1; font-size: 11px; color: #888; word-break: break-all;">
                                    ${index + 1}. ${this.truncateUrl(url, 40)}
                                </div>
                            </div>
                        `;
                        break;

                    default:
                        itemHtml = `
                            <div class="url-item" style="padding: 8px; background: #333; border-radius: 4px;">
                                <div style="font-size: 11px; color: #888; word-break: break-all;">
                                    ${index + 1}. <a href="${url}" target="_blank" style="color: #1a73e8; text-decoration: none;">${this.truncateUrl(url, 40)}</a>
                                </div>
                            </div>
                        `;
                }
                
                contentHtml += itemHtml;
            });

            contentHtml += '</div>';
            renderArea.innerHTML = contentHtml;
        };

        // 检测URL类型
        nodeManager.detectUrlType = function(url) {
            if (!url || typeof url !== 'string') return 'link';
            
            const urlLower = url.toLowerCase();
            
            if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)(\?|$)/i.test(urlLower)) {
                return 'image';
            }
            
            if (/\.(mp4|avi|mov|wmv|flv|webm|mkv)(\?|$)/i.test(urlLower)) {
                return 'video';
            }
            
            return 'link';
        };

        // 检查URL是否有效
        nodeManager.isValidUrl = function(url) {
            if (!url || typeof url !== 'string') return false;
            try {
                new URL(url);
                return true;
            } catch {
                return false;
            }
        };

        // 截断URL显示
        nodeManager.truncateUrl = function(url, maxLength) {
            if (!url || url.length <= maxLength) {
                return url;
            }
            return url.substring(0, maxLength - 3) + '...';
        };

        console.log('[URLRenderer] 简化版本已加载');
    }
})();