# Shadow Distributed Router - Vector Intent Routing Architecture

## 1. 目标
在不修改 VCP 核心源码的前提下，为 ShadowDistributedRouter 实现意图驱动的分布式路由，支持通过自然语言显式指定设备调用。

## 2. 核心技术：运行时补丁 (Monkey Patching)
- 拦截机制：在 Shadow 插件初始化时，动态 patch ToolExecutor.prototype.execute，从而截获 contextMessages。
- 意图传递：利用 AsyncLocalStorage 在调用链中传递 routeContext，避免污染插件接口。

## 3. 设备映射机制
- device-aliases.json：存储设备别名映射。
- 数据来源：
    - serverId, hostName, lastKnownIPs：由 Shadow 启动时从注册表同步。
    - friendlyNames：用户手动定义，系统绝不覆盖。

## 4. 路由算法
1. 输入提取：从 contextMessages 提取最新用户指令。
2. 向量化：优先使用 RAGDiaryPlugin 缓存，兜底使用 EmbeddingUtils。
3. 匹配逻辑：精确匹配 (friendlyNames) 或 语义匹配 (Cosine Similarity > 0.72)。
4. 后置校验：目标设备必须拥有对应 toolName 的可用实例。
5. 悲悯兜底：置信度不足时 fallback 至 RequestIp 亲和路由。

## 5. 实施阶段
- Phase 0: 最小探针验证。
- Phase 1: 设备别名表同步。
- Phase 2: 向量索引构建。
- Phase 3: 路由匹配与决策逻辑。