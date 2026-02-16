# VChat 分布式本地渲染（单层原生）架构与实现方案（定稿）

> 文档状态：已定稿（基于当前讨论）  
> 适用项目：`VCPChat / VChat`  
> 目标：作为后续实施的唯一参考蓝图（Architecture + Implementation + Upgrade）

---

## 1. 背景与决策结论

### 1.1 已确认需求
- 一台主机电脑运行核心能力（AI、插件、数据、文件）。
- 其他电脑与手机接入，主要承担输入输出与界面展示。
- 渲染必须尽量使用各设备本地性能（本地 GPU/CPU），而不是远程桌面流。
- 同步范围覆盖：聊天记录、话题、Agent 列表、气泡渲染、Canvas 等核心功能。
- 不采用“浏览器轻版 + 原生完整版”的双层方案。
- 需要后续跟进上游 VChat 更新，并尽量实现快速/近一键无缝升级。

### 1.2 最终架构决策（定稿）
采用 **单层原生分布式架构**：

- **主机端（Host）**：继续使用 Electron + Node 主进程 + 现有 Python/Rust 能力，升级为“控制面（Control Plane）+ 本地客户端（Local Client）”。
- **电脑客户端（Remote PC）**：原生客户端（优先 Electron，复用最高）。
- **手机客户端（Mobile）**：原生壳内置 Web 运行时（优先 Capacitor），复用现有前端代码与渲染逻辑。
- **通信方式**：统一协议（WebSocket + 必要 HTTP），同步状态与指令，不同步像素流。

> 说明：手机端虽使用内置 Web 渲染引擎，但运行在原生 App 容器中，不是公网浏览器直连模式，仍归类于本方案的“原生客户端层”。

---

## 2. 总体架构

## 2.1 架构分层

### A. 控制面（Host Control Plane）
职责：
1. 权威状态源（SSOT）：Agent/Topic/Chat/Canvas/Settings。
2. 插件执行中心：复用 `VCPDistributedServer` 与 Plugin 体系。
3. 文件系统与本地能力中心：路径白名单、权限校验、审计。
4. 调度中心：流式输出、长任务、工具调用。
5. 同步网关：客户端连接管理、协议协商、广播与重放。

### B. 客户端层（Native Clients）
所有客户端（主机本机 UI / 远程 PC / 手机）职责一致：
1. 本地渲染（气泡、动画、Three.js、Canvas）。
2. 用户输入采集（文本/语音/操作事件）。
3. 协议通信（请求、订阅、增量同步）。
4. 本地缓存（模型、贴图、主题资源、会话快照）。

## 2.2 关键原则
1. **状态同步，不传画面**：仅传业务事件与渲染参数。
2. **主机权威**：所有可持久化数据以主机为准。
3. **客户端本地渲染**：性能消耗分散至各终端。
4. **能力分级**：不同设备可做渲染降级，不影响协议一致性。

---

## 3. 终端架构设计

## 3.1 主机电脑架构

### 3.1.1 进程角色
- `main.js`（主进程）：控制面入口。
- `renderer.js`（本机 UI）：作为 Local Client #1。
- Python/Rust 子系统：AI/音频等计算执行。
- `VCPDistributedServer/*`：插件与分布式工具桥接。

### 3.1.2 新增能力
- `Remote Gateway`（新增模块）：
  - 客户端鉴权
  - 会话管理
  - 事件总线（publish/subscribe）
  - 历史增量补偿（replay）

- `State Sync Service`（新增模块）：
  - Snapshot + Delta 统一输出
  - 版本号/序列号管理
  - 冲突检测（Canvas/并发编辑）

## 3.2 远程电脑客户端架构（Electron）
- 复用现有渲染模块（`renderer.js`、`modules/*`）。
- 新增 `transportAdapter`：
  - Electron 本地模式：走 IPC。
  - Remote 模式：走 WS/HTTP。
- 本地渲染策略：根据 GPU/CPU 自动档位切换（高/中/低）。

## 3.3 手机客户端架构（Capacitor）
- 原生壳 + 内置 Web 运行时。
- 前端代码最大复用（HTML/CSS/JS + modules）。
- 通过 Native Bridge 补齐：
  - 麦克风权限
  - 后台保活（平台允许范围）
  - 文件上传/下载选择器
- 渲染保持本地执行，不依赖远程桌面流。

---

## 4. 同步模型与协议设计

## 4.1 协议协商
客户端连接时发送：
- `clientVersion`
- `protocolVersion`
- `capabilities`（audio_in, audio_out, canvas_edit, file_upload, high_render 等）

服务端返回：
- `acceptedProtocol`
- `featureFlags`
- `serverVersion`

兼容策略：
- 服务端至少兼容 `N` 与 `N-1` 协议。
- 新字段仅新增可选，禁止无版本保护的破坏性删除。

## 4.2 事件分类

### 4.2.1 状态快照类（Snapshot）
- `agent.list.snapshot`
- `topic.list.snapshot`
- `chat.history.snapshot`
- `settings.snapshot`

### 4.2.2 增量事件类（Delta）
- `agent.updated`
- `topic.created / renamed / deleted / reordered`
- `chat.message.append`
- `chat.stream.chunk`
- `chat.stream.end`
- `bubble.render.meta`
- `canvas.op`

### 4.2.3 控制/系统类
- `auth.challenge / auth.ok`
- `sync.resume`
- `error.report`
- `audit.log`

## 4.3 顺序与一致性
- 每个会话通道包含 `seq`（严格递增序号）。
- 客户端收到断序后请求 `sync.resume(lastSeq)`。
- 关键写操作需主机确认（ack）后才视为提交成功。

---

## 5. 功能可实现边界（本方案定义）

## 5.1 可实现（目标必须达成）
1. 聊天记录/流式回复多端同步。
2. 话题管理全同步（增删改排）。
3. Agent 列表与配置同步。
4. 气泡渲染同步（指令驱动，本地动画执行）。
5. Canvas 协同编辑（操作级同步）。
6. 主机继续可完整使用 VChat 全功能。

## 5.2 条件可实现（需权限）
1. 客户端操作主机文件：允许（白名单 + 权限控制 + 审计）。
2. 插件调用透传：允许（按角色与插件风险等级限制）。

## 5.3 明确不做（或不承诺）
1. 主机无授权直接读取手机本地文件（平台安全限制）。
2. 系统级窗口/托盘/全局快捷键在手机端等价实现。
3. 不引入“远程桌面像素流”作为主路径。

---

## 6. 渲染与性能方案

## 6.1 客户端本地渲染策略
- 动画：anime.js / CSS 动画本地执行。
- 3D：Three.js 本地执行。
- Canvas：本地绘制 + 操作同步。

## 6.2 设备档位策略
- **High**：高质量贴图、完整后处理、目标 60 FPS。
- **Medium**：中等贴图、限制阴影/后处理。
- **Low**：关闭高开销特效、优先交互流畅。

启动时与运行中动态降级依据：
- 平均帧率
- 设备温度/卡顿指标（平台可观测范围）
- 内存压力

## 6.3 资源策略
- 模型与贴图本地缓存（版本校验）。
- 增量资源分发（hash 对比）。
- 冷启动预取关键资源，非关键懒加载。

---

## 7. 安全与权限设计

## 7.1 角色模型
- `viewer`：只读浏览与对话。
- `operator`：可编辑话题/Canvas。
- `admin`：可触发文件与插件高权限操作。

## 7.2 文件访问控制
- 路径白名单（仅允许指定根目录）。
- 操作级权限（read/write/delete/execute）。
- 敏感路径默认拒绝。

## 7.3 审计
记录：
- 谁（clientId/deviceId/userId）
- 在何时
- 对何对象（path/topic/plugin）
- 做了什么（action/result）

---

## 8. 与现有代码的对接策略

## 8.1 保持主干可升级原则
- 上游核心逻辑尽量不侵入式改动。
- 新增代码集中在：
  - `modules/distributed/*`
  - `modules/transport/*`
  - `mobile-shell/*`（Capacitor 项目）

## 8.2 关键适配层
新增统一 API 门面（示意）：
- `platformAdapter.call('get-chat-history', args)`
- Electron: 映射到 `window.electronAPI.xxx`
- Mobile Remote: 映射到 WS/HTTP RPC

## 8.3 现有能力复用
- `main.js` 中已存在分布式服务初始化入口可复用。
- `VCPDistributedServer` 插件执行与工具注册能力可复用。
- `modules/ipc/*` 可逐步映射为远程可调用服务。

---

## 9. 更新与升级方案（重点）

## 9.1 升级目标
- 跟随上游 VChat 更新。
- 尽量不破坏分布式能力。
- 支持快速发布与安全回滚。

## 9.2 版本分层
1. **Core Version**：上游 VChat 版本。
2. **Protocol Version**：客户端-主机协议版本。
3. **Web Bundle Version**：Capacitor 内置前端资源版本（可 OTA）。
4. **Shell Version**：手机原生壳版本（需商店发版）。

## 9.3 仓库与分支策略
- `upstream-mirror`：仅同步上游。
- `integration-main`：分布式集成分支。
- `release/*`：发布分支。

升级流程：
1. 拉取上游新 tag 到 `upstream-mirror`。
2. 合并/重放适配层补丁到 `integration-main`。
3. 自动化测试（协议/同步/回归）。
4. 打包与灰度发布。

## 9.4 自动化发布流水线（近一键）
按钮触发步骤：
1. `fetch upstream` → `merge/rebase`。
2. 运行契约测试（IPC/协议）。
3. 运行端到端冒烟（聊天/话题/Canvas）。
4. 构建主机包、桌面客户端包、移动 Web bundle。
5. 推送 OTA（Web bundle）+ 桌面自动更新。
6. 灰度发布与监控。

## 9.5 热更新边界（明确）
可热更新：
- 前端 JS/CSS/HTML、渲染逻辑、业务 UI。

不可纯热更新（需发新壳/新桌面包）：
- 原生权限变化
- Native 插件能力变更
- 系统级 API 变更

## 9.6 回滚机制
- 主机升级前自动备份 `AppData`。
- OTA bundle 保留最近两个稳定版本。
- 灰度异常超阈值自动回滚到上一稳定版。

---

## 10. 分阶段实施计划

## Phase 1（MVP）
- 建立协议网关与客户端连接。
- 实现 Agent/Topic/Chat 的 Snapshot + Delta。
- 手机端 Capacitor 壳跑通，完成基础对话与气泡本地渲染。

## Phase 2（核心体验）
- 流式回复同步。
- Canvas 操作级协同。
- 音频输入输出链路稳定化。
- 权限模型与审计上线。

## Phase 3（完整化）
- 插件能力分级透传。
- 协议兼容与恢复机制完善。
- 自动化升级流水线与灰度回滚全量上线。

---

## 11. 验收标准（Definition of Done）

1. 主机端功能不倒退，仍可独立完整使用。
2. 远程电脑与手机可稳定接入并同步核心功能。
3. 多端同一会话下聊天/话题/Agent/Canvas 一致性通过测试。
4. 手机端渲染走本地执行，非远程画面流。
5. 完成一轮上游版本升级演练：可升级、可灰度、可回滚。

---

## 12. 风险清单与应对

1. **协议破坏风险**：
   - 应对：版本协商 + N/N-1 兼容 + 契约测试。

2. **移动端性能风险**：
   - 应对：动态档位、资源压缩、帧预算监控。

3. **并发一致性风险（Canvas）**：
   - 应对：操作序列号 + 冲突策略（必要时引入 CRDT/OT）。

4. **权限滥用风险**：
   - 应对：最小权限、路径白名单、审计追踪。

---

## 13. 方案定稿声明

本方案为当前阶段的正式实施蓝图，后续设计与开发以本文件为准。  
如与临时讨论结论冲突，以本文件最新版本为准。

---

## 附录 A：建议目录（新增）

```text
modules/
  distributed/
    gateway/
    state-sync/
    auth/
    audit/
  transport/
    platformAdapter.js
    electronTransport.js
    remoteWsTransport.js
mobile-shell/
  capacitor-app/
```

## 附录 B：关键设计口令（团队统一）
- “状态同步，不传像素”
- “主机权威，终端渲染”
- “协议先行，版本兼容”
- “可灰度，可回滚，先保稳再提效”
