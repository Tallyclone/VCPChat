const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// 辅助函数：在指定目录下执行shell命令
function runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                // 如果是git diff且有差异，它会返回非0退出码，这不是真正的错误
                if (command.startsWith('git diff') && stdout) {
                    resolve(stdout);
                } else {
                    reject(`Error executing command: ${command}\\n${stderr}`);
                }
            } else {
                resolve(stdout);
            }
        });
    });
}

// 解析git diff --name-status的输出
function parseNameStatus(output) {
    return output.trim().split('\\n').map(line => {
        if (!line) return null;
        const [status, filePath] = line.split('\\t');
        return { status: status.trim(), filePath: filePath.trim() };
    }).filter(Boolean);
}

// 主函数
async function main() {
    try {
        const input = await new Promise(resolve => {
            let data = '';
            process.stdin.on('data', chunk => data += chunk);
            process.stdin.on('end', () => resolve(JSON.parse(data)));
        });

        const { projectPath, upstream = 'upstream', branch = 'main' } = input;

        if (!fs.existsSync(projectPath)) {
            throw new Error(`路径不存在: ${projectPath}`);
        }

        // 1. 执行Git命令
        await runCommand(`git fetch ${upstream}`, projectPath);
        const diffNameStatusOutput = await runCommand(`git diff --name-status ${upstream}/${branch}`, projectPath);
        const files = parseNameStatus(diffNameStatusOutput);

        let diffDetails = [];
        for (const file of files) {
            const diffContent = await runCommand(`git diff ${upstream}/${branch} -- "${file.filePath}"`, projectPath);
            diffDetails.push({ ...file, diffContent });
        }
        
        // 2. AI总结 (这里用简单规则代替复杂AI调用，以保证插件独立性)
        const summary = `发现 ${files.length} 个文件存在差异。其中新增 ${files.filter(f => f.status === 'A').length} 个, 修改 ${files.filter(f => f.status === 'M').length} 个, 删除 ${files.filter(f => f.status === 'D').length} 个。`;

        // 3. 分类文件
        const textFileExtensions = ['.txt', '.md', '.env', '.json', '.example', '.js', '.py', '.html', '.css', '.sh', '.bat', '.jsonc'];
        const textFiles = diffDetails.filter(f => textFileExtensions.includes(path.extname(f.filePath).toLowerCase()));
        const otherFiles = diffDetails.filter(f => !textFileExtensions.includes(path.extname(f.filePath).toLowerCase()));

        // 4. 生成HTML渲染内容
        const html = generateHtml(summary, textFiles, otherFiles, projectPath, upstream, branch);

        // 返回给VCP
        console.log(JSON.stringify({ status: 'success', result: html }));

    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: error.message }));
    }
}

function generateHtml(summary, textFiles, otherFiles, projectPath, upstream, branch) {
    const fileToHtml = (file) => {
        const fileId = file.filePath.replace(/[^a-zA-Z0-9]/g, '_');
        const diffHtml = file.diffContent
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .split('\\n')
            .map(line => {
                if (line.startsWith('+')) return \`<span class="diff-add">\${line}</span>\`;
                if (line.startsWith('-')) return \`<span class="diff-del">\${line}</span>\`;
                if (line.startsWith('@@')) return \`<span class="diff-head">\${line}</span>\`;
                return \`<span>\${line}</span>\`;
            })
            .join('\\n');

        return \`
            <div class="file-diff-container">
                <div class="file-header">
                    <span class="file-status status-\${file.status}">\${file.status}</span>
                    <span class="file-path">\${file.filePath}</span>
                    <div class="file-actions" data-filepath="\${file.filePath}">
                        <label><input type="radio" name="action_\${fileId}" value="keep" checked> 保留本地</label>
                        <label><input type="radio" name="action_\${fileId}" value="overwrite"> 覆盖更新</label>
                        \${file.status === 'M' ? \`<label><input type="radio" name="action_\${fileId}" value="merge"> 合并(手动)</label>\` : ''}
                    </div>
                </div>
                <details class="diff-details">
                    <summary>点击展开/折叠差异</summary>
                    <pre class="diff-content"><code>\${diffHtml}</code></pre>
                </details>
            </div>
        \`;
    };

    return \`
    <div id="git-update-wizard">
        <style>
            #git-update-wizard {
                background-color: var(--primary-bg);
                color: var(--primary-text);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 20px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                backdrop-filter: blur(10px) saturate(120%);
            }
            #git-update-wizard h2 { color: var(--highlight-text); border-bottom: 2px solid var(--border-color); padding-bottom: 10px; }
            #git-update-wizard .summary { margin: 15px 0; font-size: 1.1em; }
            .category-title { font-size: 1.2em; font-weight: bold; margin-top: 20px; color: var(--highlight-text); }
            .file-diff-container { border: 1px solid var(--border-color); border-radius: 8px; margin-top: 10px; overflow: hidden; }
            .file-header { display: flex; align-items: center; padding: 10px; background-color: var(--secondary-bg); }
            .file-status { font-weight: bold; padding: 3px 8px; border-radius: 5px; margin-right: 10px; }
            .status-A { background-color: #28a745; color: white; }
            .status-M { background-color: #ffc107; color: black; }
            .status-D { background-color: #dc3545; color: white; }
            .file-path { flex-grow: 1; font-family: "Courier New", Courier, monospace; }
            .file-actions label { margin-left: 15px; cursor: pointer; }
            .diff-details summary { cursor: pointer; padding: 8px; background-color: rgba(128,128,128,0.1); }
            .diff-content { max-height: 400px; overflow-y: auto; background-color: #222; color: #eee; padding: 10px; white-space: pre; font-family: "Courier New", Courier, monospace; font-size: 0.9em; }
            .diff-add { color: #28a745; }
            .diff-del { color: #dc3545; }
            .diff-head { color: #007bff; }
            #generate-script-btn { display: block; width: 100%; padding: 12px; margin-top: 20px; background-color: #007bff; color: white; border: none; border-radius: 8px; font-size: 1.1em; cursor: pointer; transition: background-color 0.3s ease; }
            #generate-script-btn:hover { background-color: #0056b3; }
            #update-script-output { margin-top: 20px; background-color: var(--secondary-bg); border-radius: 8px; padding: 15px; }
            #update-script-output h3 { margin-top: 0; }
            #update-script-output pre { background-color: #111; color: #0f0; padding: 10px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word; }
        </style>
        
        <h2>Git 项目更新向导</h2>
        <p class="summary">\${summary}</p>

        <div class="category-title">文本文件</div>
        \${textFiles.map(fileToHtml).join('')}

        <div class="category-title">其他文件</div>
        \${otherFiles.map(fileToHtml).join('')}

        <button id="generate-script-btn" onclick="generateUpdateScript()">生成更新脚本</button>
        <div id="update-script-output" style="display:none;">
            <h3>定制更新脚本 (请在项目根目录执行):</h3>
            <pre id="script-content"></pre>
        </div>

        <script>
            function generateUpdateScript() {
                const actions = [];
                document.querySelectorAll('.file-actions').forEach(el => {
                    const filePath = el.dataset.filepath;
                    const selectedAction = el.querySelector('input[type="radio"]:checked').value;
                    actions.push({ filePath, selectedAction });
                });

                let script = '#!/bin/bash\\n# 根据你的选择生成的定制更新脚本\\n\\n';
                script += '# 确保在最新的上游状态下操作\\n';
                script += 'git fetch ' + \`\${upstream}\` + '\\n\\n';

                actions.forEach(action => {
                    const escapedPath = \`"\${action.filePath}"\`;
                    switch (action.selectedAction) {
                        case 'overwrite':
                            script += \`# 覆盖更新: \${escapedPath}\\n\`;
                            script += \`git checkout \${upstream}/\${branch} -- \${escapedPath}\\n\\n\`;
                            break;
                        case 'keep':
                            script += \`# 保留本地: \${escapedPath} (无操作)\\n\\n\`;
                            break;
                        case 'merge':
                            script += \`# 手动合并: \${escapedPath}\\n\`;
                            script += \`# VCP 提示: 请手动解决此文件的冲突\\n\`;
                            script += \`git merge-tool \${escapedPath}\\n\\n\`;
                            break;
                    }
                });
                
                script += '# 更新完成\\n';
                script += 'echo "定制化更新脚本执行完毕。"\\n';

                document.getElementById('script-content').textContent = script;
                document.getElementById('update-script-output').style.display = 'block';
            }
        </script>
    </div>
    \`;
}

main();