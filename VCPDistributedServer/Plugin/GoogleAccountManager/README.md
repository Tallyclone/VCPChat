# GoogleAccountManager 使用说明

Windows 分布式节点单插件 synchronous/stdio 实现，管理 G:/profiles-manage 下 profile_1 至 profile_50。Node 18+、PowerShell 5+、Chrome，无新增 npm 依赖。原 HTA 和 scripts/close_profile.ps1 不改动。

## 配置和权限

节点 Plugin.js 读取本目录 config.env，按 manifest.configSchema 注入子进程环境。GAM_SOURCE_CONFIG 指向 G:/profiles-manage/config.json，只使用 paths.accountsDir、paths.chromePath、clash.host/port。GAM_ALLOWED_ROOT 必须与账号根目录一致。

GAM_ALLOWED_COMMANDS 是代码实际执行的命令白名单；缺省仅允许七个只读命令。本机 config.env 已启用全部 12 个命令，GAM_APPROVAL=local-policy 表示可信节点本地预授权，不是逐用户鉴权。调用参数不能更改权限。stdio 路径不注入远端 requiresAdmin 授权，本插件不依赖该字段，不要求每次验证码或 Electron 弹窗。旧 dialog 配置仅兼容保留，在 stdio 中不可用。应通过节点访问控制、白名单和 Windows ACL 保护操作权限。

令牌仅从账号根目录下 scripts/clash_party.token、scripts/.clash_party_token、clash_party.token 顺序读取，不输出令牌或原始 API 错误正文。

## 命令

profile 只接受 1-50 整数或规范数字字符串，拒绝 01、路径、shell 参数、布尔值。布尔参数接受 true/false 及同名字符串。未知字段拒绝。url 可选，默认https://accounts.google.com，只允许http(s)，拒绝凭据、控制字符和其他协议；不能传入可执行路径或任意Chrome参数。

| 命令                       | 参数和行为                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| list                       | 可选 type、running、emailHint、noteContains，列出匹配槽位                  |
| inspect                    | profile；本地账号、备注、类型、运行模式和绑定                              |
| launch                     | profile，可选 url、restart、force；显式直连                                |
| proxy_login                | 参数同 launch，验证代理并切组后启动，不自动登录                            |
| close                      | profile、confirm:true；先正常关闭，force:true 才强制结束残留               |
| proxy_status               | 可选 profile、live:true；只读绑定，live 仅 GET 实时状态                    |
| refresh_proxy_bindings     | 可选 force:true 重算；保存绑定，不 PUT 切组                                |
| set_note                   | profile、note，最长 2000 字符，空串清除                                    |
| set_type                   | profile、type:google 或 other，默认 1-30 google、31-50 other               |
| find_available_account     | 可选 type、emailHint、noteContains、initialized；选最小未运行槽位，不预留  |
| find_and_launch            | mode:direct 或 proxy，支持以上过滤和 url；锁内选取和启动                   |
| close_all_managed_profiles | confirm:true，可选 force:true；逐项返回结果，complete:false 表示部分未关闭 |

emailHint 和 noteContains 为忽略大小写的子串。邮箱只是 Preferences 本地账号记录，不证明在线登录、健康或未封禁；loginStatus 恒为 unknown。不读取密码、Cookies、Login Data，不解决验证码。未初始化槽位也可选，需排除时使用 initialized:true。

### 调用示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」GoogleAccountManager「末」,
command:「始」proxy_login「末」,
profile:「始」1「末」,
restart:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
```

每个命令的完整中文示例见 plugin-manifest.json。先 refresh_proxy_bindings 建立或修复绑定，再 proxy_login。CLI 只读：PowerShell 中运行 '{"command":"list"}' | node index.js。CLI 不自动加载 config.env，需要显式环境变量，缺省只读。

stdout 只有一行 JSON：status、result.content 文本数组、result.details 和顶层 details；错误另有 error 与 details.code。实际 VCPDistributedServer 成功时读取 result，失败读取 error。无 stdout 调试日志。

## 运行与安全边界

Chrome 使用 spawn(shell:false)参数数组。已有相同模式返回 alreadyRunning，不再次打开 URL；模式冲突/未知时报 MODE_CONFLICT_RESTART_REQUIRED。restart:true 先正常关闭，不隐式强杀；关闭约 3 秒后仍有进程报 CLOSE_REQUIRES_FORCE，只有 force:true 允许强制结束。精确匹配 user-data-dir 及 Chrome 子进程，操作前核验 PID、创建时间、命令行与名称，不全杀 Chrome 或 Node。后台驻留或页面阻止关闭可能需要显式 force。批量关闭即使部分失败也返回逐项结果，必须检查 complete。

代理 GET /outlets 筛选 enable 不为 false、direct、octopus-top 前缀，按数字端口排序；至少 50 个不同端口和组。GET /groups/{target}读取 proxies，PUT 提交{name:node}，再次 GET 确认选择。API 单次 5 秒超时、2MiB 响应限制、共享 90 秒期限。代理失败禁止直连 fallback；PUT 超时可能已改变选择，返回不确定错误而不启动，不声称回滚。TCP 可连不代表上游健康或匿名性。

绑定优先保留有效旧选择并全局去重，不足通过 duplicateProfiles 明确报告；force 重算不保证每个节点都改变。无每日后台切换任务。其他运行 Profile 使用同组/端口时拒绝切换。

所有写命令（包括启动、关闭、代理切组）使用根目录.google_account_manager.lock 跨进程排他锁；竞争返回 BUSY_LOCK。锁内重读状态；JSON 损坏拒绝覆盖；支持 UTF8/BOM 与 UTF16LE。写入采用同目录独占临时文件、fsync、原子 rename 和.bak 备份。崩溃留下锁时，确认记录 PID 不运行且无操作执行后再人工删除，不自动抢锁。

**写操作前关闭 HTA 并保持关闭直到调用结束。** 任意 mshta.exe 运行时均拒绝写操作，防止 HTA 旧状态覆盖新备注/类型/绑定。原 HTA 没有共享锁，调用中途再打开 HTA 仍有竞态；其他直接写状态或切代理的脚本也须暂停。只读命令可以与 HTA 共存。这是最少改动原项目所选择的局限。

脱敏审计.google_account_manager.audit.jsonl 仅记录时间、命令、阶段和错误码，1MiB 轮转，不记录备注、邮箱、节点、命令行、URL、令牌。只读不写审计。状态、备份、审计均应保护在本机。

## 指定工位和节点（1.1.0）

新增 `list_outlets(keyword?)`、`list_groups(keyword?, outletPort?)`、`list_nodes(group, keyword?)`、`login_with_proxy`、`restore_auto_binding(profile)`。

指定登录示例：

```json
{
  "command": "login_with_proxy",
  "profile": 12,
  "outletPort": 7900,
  "group": "实际策略组名",
  "node": "实际成员名",
  "saveBinding": true
}
```

`group` 可省略，从工位推导；`node` 必须是该组成员。支持全部启用的 direct 工位，不限 octopus-top，按入站类型使用 HTTP 或 SOCKS5。`list_outlets` 也展示禁用和 fallback 工位，但后两者不能执行手动切换。列表 `/groups` 会漏掉隐藏组，可按工位端口查组，或按准确组名查成员。

`saveBinding` 默认 false；临时登录不改保存设置，但实际 Clash 选择仍会改变。true 在确认启动后写入独立 `.google_manual_proxy_bindings.json`；返回 bindingSaved，保存失败返回 bindingSaveError，不掩盖浏览器已经启动。插件 inspect、proxy_status、proxy_login、find_and_launch 优先使用手动覆盖。自动刷新与 HTA 仍维护原自动绑定，无法覆盖独立手动设置；HTA 本身不读取这份覆盖。restore_auto_binding 删除覆盖，不改变正在运行的浏览器；needsRefresh 提示是否缺少自动绑定。

同节点共享不重复 PUT；不同节点切换检查真实 Chrome 端口及嵌套组链，冲突返回 PROXY_IN_USE。明确允许影响这些会话可传 allowSharedSwitch:true。无法识别所有其他应用的使用情况。新手动登录 PUT 使用 `?close=0`，不会主动断开全局连接，已存在连接可能继续使用旧出口。selectionChain 返回子组选择链；末端仅为组 API 返回非组的名字，不证明健康、实际 IP 或固定叶节点。

**当前脚本 API 只有 GET /outlets，没有修改工位目标接口。** group 与工位目标不一致时报 OUTLET_GROUP_MISMATCH；即使传 reassignOutlet:true 也返回 OUTLET_REASSIGN_UNSUPPORTED_BY_API。需先在 Clash Party 配置工位目标并应用，再调用插件。插件不会直接改 Clash 配置或重启内核。PARTY-OUTLET/PROBE 托管组和不支持手动选择的组拒绝切换。

## 测试与加载

运行 npm run check 和 npm test，测试使用临时目录、mock API 和 mock 进程，包含真实 Plugin.js 隔离发现/配置注入/stdio 子进程调用，不初始化其他插件。真实环境仅只读 smoke，不启动/关闭浏览器、不切组、不改备注。

本次没有重启运行中的节点。隔离加载验证不代表运行服务自动发现插件；如当前服务尚未加载，需要在你选择的安全时间正常重启分布式节点。不要为测试全量 loadPlugins，以免触发其他插件任务。
