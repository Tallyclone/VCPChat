# 分布式联调步骤清单（可执行）

## 1. 启动 Host（VCPChat）
1) 打开 `D:\Vchat\VCPChat`
2) 启动应用（Electron）
3) 在主界面「全局设置」确认：
   - 启用远程网关 = 开
   - 监听地址 = `0.0.0.0`
   - 端口 = `17888`
   - Token = 自定义强口令
4) 保存设置，重启 Host（确保网关参数生效）

## 2. 验证网关健康
1) 浏览器访问：`http://127.0.0.1:17888/health`
2) 预期返回：`{"status":"ok"...}`
3) 访问：`http://127.0.0.1:17888/meta`
4) 检查：`protocolVersion`、`protocolCompat`、`capabilities`

## 3. 联调远程桌面端
1) 打开 `D:\Vchat\VCPRemoteDesktop`
2) `npm install && npm start`
3) 输入网关地址与 token，点击连接
4) 验证：
   - Agent 列表加载
   - Topic 新建/重命名/删除/锁定/未读
   - Agent 配置可读写
   - Stream 输出有 chunk
   - Canvas 新建/读取/保存

## 4. 联调手机端（Web/Capacitor）
1) 打开 `D:\Vchat\VCPMobile`
2) `npm install && npm run start:web`
3) 手机与 Host 同一局域网，用 Host 局域网IP（如 `ws://192.168.1.100:17888`）
4) 验证：
   - Agent/Topic/Chat/Canvas 同步
   - Stream chunk 到达
   - Topic 顺序保存（输入逗号分隔ID）

## 5. 断线重连验证
1) 客户端连接后，临时关闭 Host
2) 观察客户端状态：应显示“连接关闭，准备重连...”
3) 重启 Host
4) 客户端应自动重连并恢复数据加载

## 6. 审计与权限验证
1) 操作若干远程写动作（topic/canvas/agent config）
2) 检查日志：`D:\Vchat\VCPChat\AppData\remote_gateway_audit.log`
3) 确认 action / clientId / role / details 记录正确

## 7. 升级脚手架验证
1) 执行：`powershell -File scripts/release-distributed.ps1 -Target all -Version 0.1.0`
2) 检查：`AppData\release_backups\<timestamp>\release-meta.json`
3) 执行回滚脚本（演练）：
   `powershell -File scripts/rollback-distributed.ps1 -BackupTimestamp <timestamp>`

## 8. 回归检查（每次更新必跑）
- [ ] 鉴权成功率
- [ ] RPC失败率
- [ ] Stream错误率
- [ ] Topic一致性
- [ ] Canvas一致性
- [ ] 审计日志完整性
