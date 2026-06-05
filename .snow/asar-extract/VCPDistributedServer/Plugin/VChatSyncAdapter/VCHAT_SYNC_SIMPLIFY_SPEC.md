# VChatSync 多端同步简化与动态投影实现文档

> 执笔：银染  
> 审核：Nova  
> 日期：2026-05-18  
> 范围：  
> - `G:\VCP\VCPChat\VCPDistributedServer\Plugin\VChatSyncAdapter`
> - `G:\VCP\VCPToolBox\Plugin\VChatSyncCenter`

---

## 0. 结论

本次改造不做本地物理文件结构重构。

不拆 `Agents/*/config.json`。  
不迁移 `topics`。  
不把模块化提示词小仓从 `advancedSystemPrompt` 中物理剥离。  
不重写 Center 基础协议骨架。

核心改法是：

1. 引入 `profile` 区分同步阶段：
   - `runtime`：日常 watch，只同步轻量、高频、跨端应一致的数据。
   - `bootstrap`：初始化/重建基线，同步完整安全投影。
   - 可预留 `manual`：以后手动全量配置同步使用。

2. 引入 `projection_fields`：
   - 每条 config operation 必须声明本次投影涉及哪些字段或嵌套路径。
   - `projection_fields` 支持 dot-path 语义，例如：
     - `name`
     - `topics`
     - `advancedSystemPrompt.hiddenBlocks`
   - 接收端只 patch `projection_fields` 中声明的字段或路径。
   - 未声明字段绝不删除、绝不覆盖。

3. Runtime 默认同步范围收窄，但支持字段级配置扩展。

4. `mergeExisting` 继续保持 report-only，不静默合并冲突。

---

## 1. 当前问题

### 1.1 `config.json` 承载过重

`Agents/*/config.json` 同时包含：

- agent 列表入口数据：`name`
- 话题入口：`topics`
- 模块化提示词结构：`advancedSystemPrompt`
  - `advancedSystemPrompt.blocks`：提示词正文积木，默认不 runtime 同步。
  - `advancedSystemPrompt.hiddenBlocks`：agent 私有提示词小仓，默认 runtime 同步。
  - `advancedSystemPrompt.warehouseOrder`：小仓顺序，默认 runtime 同步。
  - `advancedSystemPrompt.viewMode`：模块视图模式，默认 runtime 同步。
- 预设引用：`presetSystemPrompt`、`selectedPreset`
- 提示词正文：`systemPrompt`、`originalSystemPrompt`、`advancedSystemPrompt.blocks`
- 编辑行为开关：`syncPrompt`
- 模型运行参数：`model`、`temperature`、`contextTokenLimit`、`maxOutputTokens`
- TTS / CSS / UI 状态等本地偏好

这些字段不能在 runtime watch 阶段无差别漂移。

### 1.2 模块化提示词小仓不是顶层字段

源码保存逻辑显示，模块化提示词保存时会写入：

```js
await this.electronAPI.updateAgentConfig(this.agentId, {
  advancedSystemPrompt: {
    blocks: this.blocks,
    hiddenBlocks: { ...this.hiddenBlocks },
    warehouseOrder: this.warehouseOrder,
    viewMode: this.viewMode
  }
});
```

因此真实结构是：

```json
{
  "advancedSystemPrompt": {
    "blocks": [],
    "hiddenBlocks": {},
    "warehouseOrder": [],
    "viewMode": false
  }
}
```

不是：

```json
{
  "hiddenBlocks": {},
  "warehouseOrder": [],
  "viewMode": false
}
```

所以文档和实现必须使用嵌套路径：

```txt
advancedSystemPrompt.hiddenBlocks
advancedSystemPrompt.warehouseOrder
advancedSystemPrompt.viewMode
```

### 1.3 旧 projector 存在误删风险

当前 `configProjector.js` 的核心风险是按 schema allowed 集合执行“先删后写”：

```js
for (const key of allowed) delete base[key];

for (const [key, value] of Object.entries(remoteDto || {})) {
  if (allowed.has(key)) base[key] = cloneJsonValue(value);
}
```

如果 runtime 只发送局部字段，但接收端仍按完整 allowed 删除字段，会导致本地配置被误删。

因此必须改为：

> 按 operation 自带的 `projection_fields` 精准 path-level patch。

---

## 2. 同步 Profile

### 2.1 runtime

日常 watch 使用。

目标：

- 同步多端列表入口。
- 同步话题入口。
- 同步聊天历史。
- 同步附件、头像。
- 同步提示词小仓、预设引用、预设库这类轻量编排资产。
- 不同步完整高级提示词正文。
- 不同步模型、TTS、CSS、本地 UI 状态。
- 不同步提示词编辑器行为开关 `syncPrompt`。

### 2.2 bootstrap

初始化、重建基线使用。

目标：

- 构建完整中心事实基线。
- 使用完整安全投影。
- 允许同步比 runtime 更宽的配置字段。
- 不要求字段极简。

### 2.3 manual（预留）

用于未来手动全量同步配置。

例如用户明确希望一端的 agent 配置覆盖/迁移到另一端时，可以使用 manual profile。  
本次不要求实现。

---

## 3. Runtime 默认同步范围

### 3.1 Agent config 默认 runtime 投影路径

物理路径：

```txt
VCPChat/AppData/Agents/*/config.json
```

Adapter relative path：

```txt
Agents/*/config.json
```

默认 runtime projection fields：

```txt
name
topics
advancedSystemPrompt.hiddenBlocks
advancedSystemPrompt.warehouseOrder
advancedSystemPrompt.viewMode
presetSystemPrompt
selectedPreset
```

含义：

- `name`：agent 列表展示名。
- `topics`：话题入口。
- `advancedSystemPrompt.hiddenBlocks`：agent 私有提示词小仓。
- `advancedSystemPrompt.warehouseOrder`：小仓 UI 顺序；其中 `global` 只是全局仓入口引用，不是全局仓内容。
- `advancedSystemPrompt.viewMode`：模块/视图模式状态。
- `presetSystemPrompt`：当前预设相关内容或快照。
- `selectedPreset`：当前选中的系统提示词预设。

### 3.2 Agent config 默认 runtime 不同步路径

默认不进入 runtime：

```txt
systemPrompt
originalSystemPrompt
advancedSystemPrompt
advancedSystemPrompt.blocks
syncPrompt
model
temperature
contextTokenLimit
maxOutputTokens
streamOutput
ttsVoicePrimary
ttsRegexPrimary
ttsVoiceSecondary
ttsRegexSecondary
ttsSpeed
customCss
cardCss
chatCss
avatarBorderColor
nameTextColor
uiCollapseStates
stripRegexes
regex_rules
```

特别说明：

- `advancedSystemPrompt`：整体默认不 runtime 同步。
- `advancedSystemPrompt.blocks`：提示词正文积木，默认不 runtime 同步。
- `advancedSystemPrompt.hiddenBlocks` / `warehouseOrder` / `viewMode`：允许作为安全子路径默认 runtime 同步。
- `syncPrompt`：不是 VChatSync 多端同步开关，而是提示词编辑器内部的“普通提示词 / 高级提示词联动开关”。行为开关默认跨端漂移，风险高于收益。
- `uiCollapseStates`：纯本地 UI 状态，建议加入 runtime denylist。

### 3.3 Group config 默认 runtime 字段

物理路径：

```txt
VCPChat/AppData/AgentGroups/*/config.json
```

Adapter relative path：

```txt
AgentGroups/*/config.json
```

默认 runtime projection fields：

```txt
name
description
avatarCalculatedColor
avatarBorderColor
nameTextColor
members
topics
```

默认不进入 runtime：

```txt
groupPrompt
invitePrompt
mode
tagMatchMode
memberTags
useUnifiedModel
unifiedModel
```

其中 `mode`、`tagMatchMode`、`memberTags` 可以通过配置显式 include。

### 3.4 独立 runtime 文件

以下文件/目录默认进入 runtime watch。

物理路径：

```txt
VCPChat/AppData/global_prompt_warehouse.json
VCPChat/AppData/systemPromptPresets/**
VCPChat/AppData/UserData/*/topics/*/history.json
```

Adapter relative path：

```txt
global_prompt_warehouse.json
systemPromptPresets/**
UserData/*/topics/*/history.json
```

另有附件类路径：

```txt
attachments/**
fileManager/**
avatar-like paths
```

说明：

- `global_prompt_warehouse.json`：全局公共提示词小仓，独立于 agent config。
- `systemPromptPresets/**`：系统提示词预设库，独立资产。
- `selectedPreset` / `presetSystemPrompt` 在 agent config 内；预设库内容在 `systemPromptPresets/**` 内。两者都要同步，否则引用关系会断。

---

## 4. 字段级 runtime 扩展

### 4.1 配置文件位置

新增同步策略配置文件。

建议放在 SyncAdapter 的可持久数据目录，避免插件升级覆盖。

若当前插件暂无独立数据目录，可先放：

```txt
VChatSyncAdapter/config/sync_profile.json
```

后续再迁移到更合适的 AppData/插件数据目录。

### 4.2 默认配置

```json
{
  "version": 1,
  "runtimeSync": {
    "agent_config": {
      "include": [],
      "exclude": []
    },
    "group_config": {
      "include": [],
      "exclude": []
    }
  },
  "bootstrap": {
    "conflictPolicy": "report_only"
  }
}
```

### 4.3 allowed 计算规则

每个 schema 拆成四层：

```js
{
  bootstrapAllowed,
  runtimeDefaultAllowed,
  runtimeConfigurableAllowed,
  runtimeDenylist
}
```

其中 allowed 项允许是顶层字段，也允许是 dot-path：

```txt
name
topics
advancedSystemPrompt.hiddenBlocks
advancedSystemPrompt.warehouseOrder
advancedSystemPrompt.viewMode
```

runtime 最终字段集：

```txt
effectiveRuntimeAllowed =
  (runtimeDefaultAllowed + userInclude - userExclude)
  ∩ runtimeConfigurableAllowed
  ∩ bootstrapAllowed
  - runtimeDenylist
```

要求：

- `include` 不能绕过 `bootstrapAllowed`。
- `include` 不能绕过 `runtimeConfigurableAllowed`。
- `runtimeDenylist` 优先级最高。
- `projection_fields` 以发送端计算出的最终字段/路径集为准，并随 operation 传输。
- 默认禁止 include `advancedSystemPrompt` 整体。
- 默认禁止 include `advancedSystemPrompt.blocks`。
- 如未来确需同步完整高级提示词正文，应增加单独高危开关，不应通过普通 include 放开。

---

## 5. Operation 格式调整

配置类 operation 需要增加：

```json
{
  "profile": "runtime",
  "projection_fields": [
    "name",
    "topics",
    "advancedSystemPrompt.hiddenBlocks"
  ]
}
```

完整示意：

```json
{
  "type": "config.update",
  "entity_type": "config",
  "schema": "agent_config",
  "entity_id": "Agents/_Agent_xxx/config.json",
  "relative_path": "Agents/_Agent_xxx/config.json",
  "profile": "runtime",
  "projection_fields": [
    "name",
    "topics",
    "advancedSystemPrompt.hiddenBlocks",
    "advancedSystemPrompt.warehouseOrder",
    "advancedSystemPrompt.viewMode",
    "presetSystemPrompt",
    "selectedPreset"
  ],
  "safe_projection_json": {
    "name": "银染",
    "topics": [],
    "advancedSystemPrompt": {
      "hiddenBlocks": {},
      "warehouseOrder": ["global", "default"],
      "viewMode": false
    },
    "presetSystemPrompt": "",
    "selectedPreset": ""
  }
}
```

原则：

- `projection_fields` 支持 dot-path。
- `safe_projection_json` 只包含 `projection_fields` 中的字段或路径。
- 如果某路径在 `projection_fields` 中但远端 DTO 没有该 path，表示远端显式删除该路径。
- 未出现在 `projection_fields` 中的本地字段或路径不可触碰。
- `advancedSystemPrompt.blocks` 不出现在 DTO 中，也不应被删除或覆盖。

### 5.1 独立 runtime 文件 operation

以下独立文件第一阶段建议作为特殊 config schema 接入，而不是新增通用 `file_asset` operation：

```txt
global_prompt_warehouse.json
systemPromptPresets/**
```

建议 schema：

```txt
global_prompt_warehouse
system_prompt_preset
```

建议语义：

```txt
entity_type: config
schema: global_prompt_warehouse
entity_id: global_prompt_warehouse.json

entity_type: config
schema: system_prompt_preset
entity_id: systemPromptPresets/{presetFileName}
```

原因：

- Center 当前主要支持 `message` / `config` 类型 operation。
- 第一阶段复用 `configService` 改动面较小。
- 不急于扩展通用 `file_asset` 协议。

注意：

- 这些特殊 config schema 是整文件 JSON 同步语义。
- 不使用 agent/group 的字段级 projection。
- 可不使用 `projection_fields`，或使用固定值 `["$"]` 表示整 JSON 文档。
- 不调用 agent/group 的 `mergeProjectedConfig()`。
- 需要独立 projector 或在 config projector 中按 schema 分支整文件写入。

未来如需同步非 JSON 或更多文件资产，再考虑新增通用 `file_asset` operation。

---

## 6. Projector 改造

### 6.1 旧逻辑废弃

禁止 runtime 继续使用“schema allowed 全量先删后写”。

### 6.2 新逻辑：path-level patch

`configProjector.js` 中 `mergeProjectedConfig` 改为声明式 path patch：

```js
function mergeProjectedConfig(localConfig, remoteDto, options = {}) {
  const projectionFields = Array.isArray(options.projection_fields)
    ? options.projection_fields
    : null;

  if (!projectionFields) {
    // 兼容旧 operation：仅 bootstrap 或旧协议可回退到 schema allowed。
    // runtime operation 必须携带 projection_fields。
    return mergeBySchemaAllowedForLegacy(localConfig, remoteDto, options);
  }

  const base = isPlainObject(localConfig) ? cloneJsonValue(localConfig) : {};

  for (const fieldPath of projectionFields) {
    if (hasByPath(remoteDto || {}, fieldPath)) {
      setByPath(base, fieldPath, cloneJsonValue(getByPath(remoteDto, fieldPath)));
    } else {
      deleteByPath(base, fieldPath);
    }
  }

  return base;
}
```

辅助函数语义：

```js
function getByPath(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function hasByPath(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return false;
    }
    cur = cur[part];
  }
  return true;
}

function setByPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteByPath(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return;
    }
    cur = cur[part];
  }
  if (cur && typeof cur === "object") {
    delete cur[parts[parts.length - 1]];
  }
}
```

runtime 要求：

- 没有 `projection_fields` 的 runtime operation 应拒绝或跳过。
- bootstrap 可兼容旧逻辑，但建议也携带 `projection_fields`。
- 对 `advancedSystemPrompt.hiddenBlocks` 等嵌套路径 patch 时，不得触碰同级的 `advancedSystemPrompt.blocks`。

---

## 7. Adapter 修改点

### 7.1 `core/configSchema.js`

需要实现：

- `bootstrapAllowed`
- `runtimeDefaultAllowed`
- `runtimeConfigurableAllowed`
- `runtimeDenylist`
- `schemaForPath(relativePath, profile)`
- `getEffectiveAllowed(schemaName, profile, syncProfileConfig)`

agent runtime default：

```js
[
  "name",
  "topics",
  "advancedSystemPrompt.hiddenBlocks",
  "advancedSystemPrompt.warehouseOrder",
  "advancedSystemPrompt.viewMode",
  "presetSystemPrompt",
  "selectedPreset"
]
```

group runtime default：

```js
[
  "name",
  "description",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics"
]
```

特殊 config schema：

```txt
global_prompt_warehouse
system_prompt_preset
```

### 7.2 `core/safeConfigDto.js`

函数签名调整：

```js
safeConfigDto(relativePath, parsedJson, {
  profile = "bootstrap",
  syncProfileConfig
} = {})
```

输出增加：

```js
{
  schema,
  syncable,
  safe_projection_json,
  projection_fields,
  profile
}
```

要求：

- 按 dot-path 从 `parsedJson` 提取值。
- 按 dot-path 写入 `safe_projection_json`。
- 不得把 `advancedSystemPrompt` 的未声明子路径（如 `blocks`）放入 DTO。DTO 中的 `advancedSystemPrompt` 对象只包含 `projection_fields` 中声明的叶子路径。
- 不得把 `advancedSystemPrompt.blocks` 放入 DTO。

### 7.3 `diff/configDiffEngine.js`

调用 `safeConfigDto` 时传入 profile。

runtime diff：

```js
diffConfig(relativePath, oldJson, newJson, {
  profile: "runtime"
});
```

bootstrap diff / manifest：

```js
diffConfig(relativePath, oldJson, newJson, {
  profile: "bootstrap"
});
```

生成 operation 时附带：

```js
profile
projection_fields
```

runtime skip 规则：

```js
const dto = safeConfigDto(relativePath, parsedJson, {
  profile: "runtime",
  syncProfileConfig
});

if (!dto || dto.schema === "skip" || dto.syncable === false) {
  return {
    changed: false,
    skipped: true,
    reason: "runtime_profile_excluded"
  };
}
```

要求：

- `settings.json`、`UserData/forum.config.json`、`UserData/memo.config.json`、`Agents/*/regex_rules.json` 等路径在 `runtime` profile 下应返回 `skip` 或 `syncable: false`。
- `diffConfig()` 遇到 skip 后不产生 operation。
- watcher 不需要自行维护大段排除逻辑，路径是否进入 runtime 同步由 `schemaForPath(path, profile)` 与 diff 层统一裁决。

### 7.4 `watcher/appDataWatcher.js`

runtime watch 调用 diff 时统一传：

```js
profile: "runtime"
```

watch 范围应覆盖：

```txt
Agents/*/config.json
AgentGroups/*/config.json
global_prompt_warehouse.json
systemPromptPresets/**
UserData/*/topics/*/history.json
attachments / fileManager / avatar-like paths
```

不建议在 watcher 层大量硬编码排除逻辑。  
路径识别可交给 `schemaForPath(path, profile)` 与 diff 层 skip。

### 7.5 `scanner/appDataScanner.js`

扫描函数增加 profile/context。

runtime 扫描走 runtime projection。  
bootstrap manifest 走 bootstrap projection。

### 7.6 `projector/configProjector.js`

实现第 6 节的声明式 path-level patch。

### 7.7 `sync/bootstrapManager.js`

- bootstrap manifest 构建传 `profile: "bootstrap"`。
- `mergeExisting` 保持 report-only。
- 后续可新增 `applyMergeReport(report, policy)`，但本轮可以只预留接口与文档说明。

---

## 8. Center 修改点

### 8.1 `core/configService.js`

需要支持并保留 operation 元数据：

```txt
profile
projection_fields
```

校验要求：

- `projection_fields` 必须是字符串数组。
- runtime agent/group config operation 必须携带 `projection_fields`。
- `projection_fields` 中字段必须属于该 schema 的允许范围。
- `projection_fields` 支持 dot-path。
- `safe_projection_json` 不应包含 projection_fields 之外的字段或路径。
- `advancedSystemPrompt.blocks` 默认不允许出现在 runtime projection_fields。
- `presetSystemPrompt`、`selectedPreset` 需要加入 agent_config schema allowed。
- 特殊 config schema `global_prompt_warehouse`、`system_prompt_preset` 需要放行。

### 8.2 存储模型

必须避免 runtime 碎片覆盖 bootstrap 完整基线。

当前 Center 若使用类似：

```txt
PRIMARY KEY (schema, entity_id)
```

则需要升级为逻辑上包含 profile：

```txt
schema + entity_id + profile
```

或采用等价双层存储：

```txt
config_entities_latest_runtime
config_entities_bootstrap_baseline
```

语义：

- `profile: "runtime"` 的 operation 只更新 runtime 最新投影，用于实时多端收敛。
- `profile: "bootstrap"` 的 operation 更新 bootstrap baseline，用于新设备初始化和重建基线。
- bootstrap baseline 不被 runtime projection 覆盖。
- runtime projection 可以参与实时广播，但不能被当作完整 config 快照。

备选方案：

- Center 不拆物理表。
- 但所有记录必须保留 `profile`。
- `bootstrapService` 生成 baseline 时，只从历史记录中选取 `profile: "bootstrap"` 的最新完整投影。
- 不允许使用 runtime 记录重建完整配置。

优先推荐：

```txt
schema + entity_id + profile
```

或等价双层存储。  
查询简单，风险更低。

### 8.3 `core/bootstrapService.js`

生成 bootstrap baseline 时，只使用：

```txt
profile = "bootstrap"
```

不能把 runtime 碎片当作完整配置恢复基线。

### 8.4 独立文件第一阶段接入策略

第一阶段不新增通用 `file_asset` operation。  
以下文件走特殊 config schema：

```txt
global_prompt_warehouse.json       -> schema: global_prompt_warehouse
systemPromptPresets/**             -> schema: system_prompt_preset
```

Center 侧需要：

- 放行 schema。
- 存储 entity_id。
- 支持 upsert/delete。
- bootstrap baseline 根据 profile 规则处理。
- runtime 广播可按 config operation 复用现有链路。

---

## 9. 冲突处理

### 9.1 当前原则

`mergeExisting` 默认继续：

```txt
report_only
```

即：

- 构建本地 manifest。
- 拉取 Center baseline。
- 对比 key / checksum。
- 输出 `merge_report.json`。
- 不自动写入本地。
- 不自动删除本地。
- 不自动覆盖中心。

### 9.2 后续执行器

预留：

```js
applyMergeReport(report, {
  policy: "server_wins" | "local_wins" | "field_merge"
});
```

策略含义：

- `server_wins`：冲突项以中心为准。
- `local_wins`：冲突项以本地为准。
- `field_merge`：配置类逐字段/路径合并；history 类按消息 ID / 时间；附件按 hash 去重。

默认不自动执行。  
必须由用户显式触发。

---

## 10. 最终 Runtime 同步表

### 10.1 Agent config

```txt
name
topics
advancedSystemPrompt.hiddenBlocks
advancedSystemPrompt.warehouseOrder
advancedSystemPrompt.viewMode
presetSystemPrompt
selectedPreset
```

### 10.2 Group config

```txt
name
description
avatarCalculatedColor
avatarBorderColor
nameTextColor
members
topics
```

### 10.3 Independent / Special Config

```txt
global_prompt_warehouse.json
systemPromptPresets/**
UserData/*/topics/*/history.json
attachments/**
fileManager/**
avatar-like paths
```

其中：

```txt
global_prompt_warehouse.json -> schema: global_prompt_warehouse
systemPromptPresets/**       -> schema: system_prompt_preset
```

### 10.4 Default Excluded From Runtime

> 注：`advancedSystemPrompt` 整体排除意味着不允许通过 include 把它作为单一顶层字段全量同步；`advancedSystemPrompt.blocks` 单独列出是为了明确即使未来允许 include 其他子路径，blocks 仍然受 denylist 保护。

```txt
systemPrompt
originalSystemPrompt
advancedSystemPrompt
advancedSystemPrompt.blocks
syncPrompt
model
temperature
contextTokenLimit
maxOutputTokens
streamOutput
tts*
customCss
cardCss
chatCss
uiCollapseStates
regex_rules
settings.json
forum.config.json
memo.config.json
```

---

## 11. 验收标准

### 11.1 runtime agent config：私有小仓

修改模块化提示词小仓后：

- 产生 runtime config operation。
- `projection_fields` 包含：
  - `advancedSystemPrompt.hiddenBlocks`
  - 必要时包含 `advancedSystemPrompt.warehouseOrder`
  - 必要时包含 `advancedSystemPrompt.viewMode`
- `safe_projection_json` 中的 `advancedSystemPrompt` 只包含上述子路径。
- 接收端只更新声明子路径。
- 本地 `advancedSystemPrompt.blocks` 不变化。
- 本地 `model`、`customCss`、`tts*` 不变化。

### 11.2 runtime selected preset

修改 `selectedPreset` 后：

- 产生 runtime config operation。
- 只 patch `selectedPreset` / 必要时 `presetSystemPrompt`。
- 不触碰 `advancedSystemPrompt.blocks`。

### 11.3 global warehouse

修改物理文件：

```txt
VCPChat/AppData/global_prompt_warehouse.json
```

对应 Adapter relative path：

```txt
global_prompt_warehouse.json
```

要求：

- 产生特殊 config schema operation。
- schema 为 `global_prompt_warehouse`。
- 另一端能恢复该文件。

### 11.4 systemPromptPresets

新增/修改/删除物理目录：

```txt
VCPChat/AppData/systemPromptPresets/**
```

对应 Adapter relative path：

```txt
systemPromptPresets/**
```

要求：

- 产生特殊 config schema operation。
- schema 为 `system_prompt_preset`。
- 另一端同步对应文件变化。

### 11.5 excluded fields

修改 `advancedSystemPrompt.blocks`：

- 默认 runtime 不产生同步 operation，或 operation 不包含该路径。
- 接收端不得删除或覆盖另一端本地 `advancedSystemPrompt.blocks`。

修改 `syncPrompt`：

- 默认 runtime 不同步。
- 显式 include 后可同步。

### 11.6 projector safety

接收 runtime operation 后：

- 未出现在 `projection_fields` 中的本地字段保持 byte-level 语义不变。
- 未出现在 `projection_fields` 中的嵌套路径保持不变。
- 不再出现 schema allowed 全量删除导致的字段丢失。
- 对 `advancedSystemPrompt.hiddenBlocks` 的 patch 不影响 `advancedSystemPrompt.blocks`。

---

## 12. 实施顺序建议

1. 明确 projection path 语义：
   - dot-path；
   - 嵌套对象提取；
   - 嵌套 path patch；
   - 嵌套 path 删除语义。
2. 改 `configSchema.js`：
   - 建立 profile / allowed resolver；
   - allowed 支持 dot-path；
   - 加入 `presetSystemPrompt`、`selectedPreset`；
   - 加入特殊 schema。
3. 改 `safeConfigDto.js`：
   - 按 dot-path 输出 `safe_projection_json`；
   - 输出 `projection_fields`。
4. 改 `configDiffEngine.js`：
   - operation 带 profile / projection_fields；
   - runtime skip。
5. 改 `configProjector.js`：
   - 声明式 path-level patch。
6. 改 watcher / scanner / bootstrapManager：
   - 透传 profile；
   - 识别新增 runtime 路径。
7. 改 Center configService：
   - 存储并校验 profile / projection_fields；
   - 支持 dot-path；
   - 支持特殊 schema。
8. 改 Center 存储：
   - `schema + entity_id + profile` 或等价隔离。
9. 改 Center bootstrapService：
   - bootstrap baseline 过滤 profile。
10. 接入独立 runtime 文件：
   - `global_prompt_warehouse.json`
   - `systemPromptPresets/**`
11. 做验收测试。
12. 再考虑 `applyMergeReport`。

---

## 13. 不做事项

本轮不做：

- 物理拆分 `config.json`。
- 新建 `topics.json`。
- 将 `advancedSystemPrompt` 整体默认 runtime 同步。
- 将 `advancedSystemPrompt.blocks` 默认 runtime 同步。
- 将 `syncPrompt` 默认 runtime 同步。
- 自动执行 mergeExisting 冲突合并。
- 重写 history / attachment diff engine。
- 改动 `isAttachmentLikePath()` 的既有头像同步逻辑。
- 第一阶段不新增通用 `file_asset` operation。

---

## 14. 备注

`warehouseOrder` 中出现的 `"global"` 是 UI 顺序入口，不是全局仓内容。  
全局仓内容持久化在：

```txt
物理路径：VCPChat/AppData/global_prompt_warehouse.json
相对路径：global_prompt_warehouse.json
```

Agent 私有小仓持久化在：

```txt
Agents/*/config.json:advancedSystemPrompt.hiddenBlocks
```

模块化提示词正文积木持久化在：

```txt
Agents/*/config.json:advancedSystemPrompt.blocks
```

系统提示词预设库持久化在：

```txt
物理路径：VCPChat/AppData/systemPromptPresets/**
相对路径：systemPromptPresets/**
```

以上几者需要分别处理，不可混为一个顶层字段。