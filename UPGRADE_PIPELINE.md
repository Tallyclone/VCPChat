# 分布式版本升级与回滚流水线（草案）

## 目标
- 支持 Host / RemoteDesktop / Mobile(OTA) 统一发布。
- 支持灰度和快速回滚。

## 推荐流程
1. 从上游同步 VChat 变更。
2. 运行兼容测试（协议、聊天、话题、canvas、流式）。
3. 生成发布包：
   - Host Electron
   - RemoteDesktop Electron
   - Mobile Web Bundle (OTA)
4. 灰度发布：5% -> 20% -> 100%。
5. 监控异常：
   - auth 失败率
   - rpc 错误率
   - stream 错误率
6. 若超阈值，执行 `scripts/rollback-distributed.ps1`。

## 脚本
- `scripts/release-distributed.ps1`
- `scripts/rollback-distributed.ps1`

## 版本策略
- Protocol: `N` 兼容 `N-1`
- Mobile:
  - Web Bundle 可 OTA 热更新
  - Native 壳变更走商店发版

## 发布前检查清单
- [ ] Remote Gateway `/meta` 输出正确
- [ ] 远程客户端可鉴权
- [ ] Topic CRUD 正常
- [ ] Chat Stream 正常
- [ ] Canvas 读写正常
- [ ] 审计日志写入正常
