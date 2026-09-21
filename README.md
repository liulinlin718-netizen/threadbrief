# ThreadBrief

在 Codex 右侧面板放一张任务配置卡片，保存此任务的人设、背景和能力选择。卡片默认折叠为 42px，最大宽度 380px，支持浅色、深色与蓝色滑动开关。

这是独立的本地面板与实验性桌面后端适配器。打开面板、保存设置和执行接入分别显示状态；仅打开页面不会替换 Codex 后端。

## 能做什么

- 人设、背景按轮次从持久配置加入，覆盖普通任务和 Agent 内部继续子任务。
- 明确开启的 Skill 自动加入后续输入；关闭后停止追加，保留已存在的历史和用户明确调用。
- MCP 与已核验归属的插件工具在调用前检查本任务开关，关闭阻断、重新开启恢复原有许可，无需强制重载任务。
- MCP 目录定时读取当前任务的 Codex 运行状态；Skills 与 Apps 主动刷新，旧快照不会作为新任务目录。
- 配置按主机、账户作用域和任务 UUID 隔离，不改 Codex 全局能力开关、模型、权限或任务环境。
- 同一主机与账户的任务共享版本内容和名称；恢复共享版本只修改当前任务。
- 草稿、取消、恢复默认、共享版本恢复、重命名与移除。

共享版本均可重命名。历史移除是逻辑删除：移除后不能从卡片恢复，内部修订链仍保留以维护版本与并发一致性；被任一任务使用的版本不能移除。这不是磁盘内容擦除。

未编辑人设和背景时不额外注入该内容，未明确开启 Skill 时不自动追加正文。目录刷新在模型输入之外完成；能力开关保持工具 schema 稳定，以减少缓存前缀变化。关闭插件也会暂停卡片自动加入其 Skill，不能清除模型已经看过的内容。

## 配置与启动

桌面适配器需要 Windows、Windows PowerShell 5.1、Node.js 22+、已安装的 Codex 桌面应用与 .NET Framework C# 编译器。服务端没有第三方运行依赖。

当前只接受已验收的 Codex CLI **0.146.0-alpha.9.2**（随 Codex 桌面版 `26.915.4065.0` 安装），SHA-256：

```text
bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226
```

构建脚本自动寻找匹配二进制和已安装桌面包。其他构建会被拒绝，需要重新验证适配器；不能只改版本号跳过校验。

在项目根目录打开 **Windows PowerShell 5.1**，输入目标任务的真实 UUID，以及为当前账户设置的稳定作用域名称：

```powershell
$taskId = Read-Host 'Codex task UUID'
$accountScope = Read-Host 'Stable account scope'
.\app\Configure-ThreadBrief.ps1 -ThreadId $taskId -HostId local -AccountScope $accountScope
.\app\Start-ThreadBrief-Codex.ps1 -ValidateOnly
```

调用者必须提供正确的真实任务绑定。`AccountScope` 是本地隔离键，不是登录凭证或自动账户认证；切换账户时应使用不同名称。工具不从历史记录猜测当前任务。

`Configure-ThreadBrief.ps1` 会在本地生成任务绑定、运行配置与桥接 EXE；它们已被 Git 忽略。可先加 `-ValidateOnly` 只检查依赖，也可用 `-NodeExecutable`、`-CodexExecutable`、`-DesktopExecutable` 显式指定安装位置。

完成预检后，手动完全退出 Codex，再双击 [Start-ThreadBrief.cmd](Start-ThreadBrief.cmd)。启动器不会结束已有任务，发现 Codex 仍运行时会停止。它只向新进程传递适配器入口，不修改全局环境变量；运行中的 Codex 不能热替换后端。

重新进入任务后，在卡片详情中检查连接与页面回执。自动挂载跟随任务创建、恢复和派生；返回 `queued` 只表示打开请求已接受。已有页面仍可编辑，关闭本任务的 Codex App 能力可能关闭自动打开入口。

只运行面板可使用 `app/Start-Panel.ps1`，端口冲突时加 `-Port 6301`。脚本返回本地任务地址，可通过 Codex 的 `open_in_codex` 浏览器目标在右侧打开。恢复原启动方式时，退出接入版，再从原 Codex 图标启动即可。

## 验证范围

真实 Codex 后端配合隔离的本地模型响应夹具已覆盖人设输入、原生 Skill 加入、实际子任务隔离、MCP/插件关闭与恢复、原工具 schema 和用户 hook 保留。单元测试另覆盖目录替换、跨任务共享版本、单任务恢复、存储并发、请求透传与页面服务。

已登录 Apps 的远程调用，以及正常用户实例中每个任务的自动可见挂载，尚未完成端到端验收。App 映射与调用控制代码保留相应状态。显式没有执行环境的任务（`environments: []`）无法运行宿主 hook，目前不支持该执行控制路径；适配器保留原任务环境。

普通 stdio MCP 网关是后备路径，不能代替所有 HTTP、隐式插件或其他执行入口的验证。卡片开关控制已接入的调用路径，不授予原 Agent 没有的权限。

## 开发检查

```powershell
cd app
node --test --test-concurrency=1 tests/*.test.mjs native-adapter/*.test.mjs
```

Windows PowerShell 检查仅在 Windows 且 PS5.1 可用时运行。真实安装预检需要已生成的本地运行配置；源码 checkout 中会明确跳过。其余测试使用隔离任务与临时存储，不需要账户认证。

浏览器检查需要 Playwright 与 Chromium：

```powershell
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/verify-browser.cjs
```

也可设置 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 使用已有安装。浏览器测试只操作合成任务与测试目录。

主要代码位于 `app/lib/`、`app/public/` 与 `app/native-adapter/`；早期独立交互示例位于 `preview/thread-config-card.html`。任务内容、访问 token、运行日志、本机能力目录与恢复材料不属于公开源码。
