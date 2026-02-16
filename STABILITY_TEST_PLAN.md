# 稳定性压测说明（个人自用）

> 个人自用建议：默认先不做重压测。

## 可选压测脚本
- `tests/remote-gateway-stress.js`

## 运行方式
```bash
node tests/remote-gateway-stress.js
```

可选环境变量：
- `TARGET`：默认 `ws://127.0.0.1:17888`
- `TOKEN`：默认 `vchat-remote-token`
- `CLIENTS`：默认 `20`
- `DURATION_MS`：默认 `30000`

## 建议最小检查
- 两台设备同时连接是否稳定
- Topic/Chat/Canvas 是否能同步
- 主机重启后客户端是否自动重连

## 已保留的轻量稳定措施
1. WebSocket 心跳（ping/pong）
2. 单客户端并发 RPC 限制（默认16）
3. 消息体大小限制（默认1MB）
4. 客户端断线自动重连（指数退避）
