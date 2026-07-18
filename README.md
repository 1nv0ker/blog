# sanityblog

`sanityblog` 是一个本机 Node.js stdio MCP Server 插件，用于准备、校验、探测、发布和更新博客文章。插件把“发布新文章”和“更新现有文章”拆成两个必须显式调用的技能，并把真正的远端写入留在最后一步确认之后。

源码仓库：[1nv0ker/dashboard](https://github.com/1nv0ker/dashboard)

## Codex 从 GitHub 安装

当前 Codex CLI 不支持把 Git URL 直接作为 `plugin add` 的参数，因此下面这条精确命令会在下载仓库之前被 CLI 拒绝：

```powershell
codex plugin add https://github.com/1nv0ker/dashboard
```

仓库已经按 Codex Git marketplace 结构提供 `.agents/plugins/marketplace.json`。当前官方支持的确定安装流程是：

```powershell
codex plugin marketplace add https://github.com/1nv0ker/dashboard --ref main
codex plugin add sanityblog@sanityblog
```

第一条命令登记并获取名为 `sanityblog` 的 marketplace，第二条从该 marketplace 安装插件。仓库内容无法把这两步改写成不受 CLI 支持的 `codex plugin add <URL>` 语法。安装或更新后请完全重启 Codex，并创建新任务。

Git marketplace 安装不会运行仓库里的 `install.ps1`、`npm install` 或其他第三方初始化脚本。插件已包含预构建的 `dist/server.mjs`，所以不需要在插件缓存中安装 npm 依赖；启动配置使用 `node` 和相对插件根目录的 `cwd`。如果当前 Codex 运行环境不能执行 `node`，或本机还没有 `~/.sanity-blog/config.json`，请使用下方 Windows 一键安装器：它会安装私有便携 Node，并只询问发布 API origin、Sanity project ID、dataset 与隐藏 token。

已有 `~/.sanity-blog/config.json` 会被 Git 安装版本直接复用。marketplace 安装本身不会读取、上传或改写其中的 token。

支持的主要客户端：

- Codex / ChatGPT 桌面版 Codex、Codex CLI、Codex IDE 扩展
- Claude Desktop、Claude Code
- Cursor
- VS Code / GitHub Copilot Agent
- Windsurf
- Cline
- 其他支持本地 stdio MCP 的客户端

MCP tools 是广泛兼容层：只要客户端支持本地 stdio MCP，就可以调用 `sanity_blog_*` 工具。完整的发布/更新技能工作流只会在支持 Agent Skills 或插件技能的客户端中自动加载；不支持技能的客户端仍可用 MCP tools，但必须由用户或客户端提示词显式执行同等的研究、校验、封面、确认和禁止重试规则。

## 能力与安全模型

插件包含：

- 本机 MCP Server 源码：`src/server.mjs`
- Git 分发用预构建 Server：`dist/server.mjs`
- 配置 CLI：`src/cli.mjs`
- 发布技能：`skills/sanity-blog-publish/`
- 更新技能：`skills/sanity-blog-update/`
- Codex 插件清单：`.codex-plugin/plugin.json`
- Claude Code 插件清单：`.claude-plugin/plugin.json`

最终的 `sanity_blog_publish` 和 `sanity_blog_update` 会修改远端内容。客户端展示的 `readOnlyHint`、`destructiveHint` 等 MCP annotations 只是提示，不是权限边界；是否允许写入必须由用户确认、客户端审批策略和服务端校验共同决定。

## Windows 一键安装（推荐）

源码仓库：[1nv0ker/dashboard](https://github.com/1nv0ker/dashboard)。64 位 Windows（x64 或 ARM64）只需 PowerShell 和网络连接，**不需要预先安装 Git、Node.js 或 npm**。

在 PowerShell 中运行一条命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/1nv0ker/dashboard/main/install.ps1' | iex"
```

安装器只会要求发布目标与初始 Sanity 配置：

1. `publisherApiOrigin`：完整的裸 HTTPS origin，直接回车默认使用 `https://publish.miyaip.com`
2. `projectId`
3. `dataset`，直接回车默认使用 `production`
4. `sanityToken`，输入时隐藏

发布接口 origin 会写入本机配置，可在重新运行 `--init` 时修改。它必须类似 `https://publisher.example.com`：包含 `https://`，不允许尾部 `/`、path、query、fragment、userinfo 或 HTTP。Sanity API version 和 workspace 不再要求填写：API version 固定为 `2026-07-05`，工作区自动创建在 `~/.sanity-blog/workspace`，并同时创建 `blog/assets`。

只配置你信任的发布服务。该 origin 会接收到 `X-Sanity-Token`、Sanity target、文章正文和封面；配置检查会公开 origin 供发布前核对，但不会返回 token。

安装器会自动完成这些工作：

- 从 GitHub 下载最新 `main` 源码；
- 下载官方 Node.js 22.23.1 便携运行时并校验固定 SHA-256；
- 使用便携 npm 按 lockfile 安装生产依赖；
- 默认安装到 `$HOME\plugins\sanityblog`，不会把 Node.js 写入系统 PATH；
- 生成指向便携运行时的 Codex 与 Claude MCP 配置；
- 加锁并原子更新 `$HOME\.agents\plugins\marketplace.json`，保留其他插件；
- 如果本机能找到 `codex`，自动执行插件注册；
- 运行 `--check`，仅在配置不存在或失效时启动四项发布目标/Sanity 初始化。

重复运行同一条命令就是更新/修复安装。已有有效 Sanity 配置会保留并跳过提问。插件目录先在 staging 中完成校验，再通过同级备份原子替换；配置初始化开始前的失败会自动回滚。若初始化本身失败，新插件会保留以兼容可能已写入的四字段配置，旧插件备份路径会在错误中明确报告。

远程脚本会在当前用户目录写入插件、配置和 personal marketplace。希望先审阅脚本时，可改用：

```powershell
$installer = Join-Path $env:TEMP 'sanityblog-install.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/1nv0ker/dashboard/main/install.ps1' -OutFile $installer
Get-Content $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

### 自动化安装

非交互终端只接受以下环境变量：

```text
SANITY_BLOG_PUBLISHER_API_ORIGIN  # 可省略，默认 https://publish.miyaip.com
SANITY_BLOG_PROJECT_ID
SANITY_BLOG_DATASET        # 可省略，默认 production
SANITY_BLOG_TOKEN
```

token 不作为安装器参数、MCP 参数或命令行参数传递；安装器会先从环境中移除它，只在执行 `--init` 的子进程期间临时恢复，因此便携 npm、MCP 配置 helper 和 Codex 注册进程都不会继承 token。请使用 CI/主机的秘密变量功能，安装后清除临时环境变量，不要把真实 token 写进脚本、终端历史或仓库。

### 配置文件与检查

新配置固定写入 `~/.sanity-blog/config.json`，文件本身只包含：

```json
{
  "publisherApiOrigin": "https://publish.miyaip.com",
  "projectId": "your-project-id",
  "dataset": "production",
  "sanityToken": "stored-locally-never-commit"
}
```

目录与文件会限制为当前用户访问。旧三字段配置继续使用默认 `https://publish.miyaip.com`；要改发布接口请重新运行 `--init`，使 origin 显式写入四字段配置。旧版五/六字段配置会保留其通过裸 HTTPS 校验的 origin 与原有 workspace 语义，但 API version 必须仍为 `2026-07-05`；不完整、origin 不安全或 API version 不一致时返回 `LEGACY_CONFIG_REQUIRES_REINIT`。

使用安装器自带的运行时检查配置，不需要系统 Node.js：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\src\cli.mjs" --check
```

需要更换发布接口 origin、Sanity 项目或 token 时重新初始化：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\src\cli.mjs" --init
```

配置和 token 不能作为任何 `sanity_blog_*` 工具参数，也不要放入 MCP 客户端 JSON。

### Codex 默认安装

一键安装器把插件加入默认个人 marketplace：

```text
$HOME\.agents\plugins\marketplace.json
```

条目使用 `INSTALLED_BY_DEFAULT / ON_INSTALL`，并自动运行 `codex plugin add sanityblog@<marketplace-name> --json`（存在 Codex 时）。默认 personal marketplace 会被 Codex 自动发现，**不要**再运行 `codex plugin marketplace add`。

安装或更新后完全重启 Codex/ChatGPT 桌面应用并创建新任务；已经打开的任务不会可靠地重新载入 manifest、MCP Server 或技能。发布与更新工具仍应保留“每次询问”或更严格的审批策略。

如果 marketplace 合并失败，插件和 Sanity 配置仍会保留，安装器会发出警告；修复 `$HOME\.agents\plugins\marketplace.json` 后重新运行同一条安装命令即可。如果仅自动 Codex 注册发出警告，可根据提示手工重试；新建默认 marketplace 时通常是：

```powershell
codex plugin add sanityblog@personal --json
```

## stdio 启动约定

一键安装后的 Windows MCP 进程直接调用插件内的便携 Node，而不是 shell、`npx` 或系统 PATH：

```json
{
  "command": "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\runtime\\node.exe",
  "args": [
    "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\dist\\server.mjs"
  ]
}
```

请把 `YOUR_NAME` 替换成真实用户名，并始终使用两个独立字段：`command` 是可执行文件绝对路径，`args` 中是 Server 绝对路径。不要使用 `~`、shell 拼接、管道或重定向。stdio Server 的 stdout 只用于 MCP JSON-RPC，日志写 stderr。

一键安装器目前面向 64 位 Windows。macOS/Linux 仍可使用源码模式，或者把官方 Node 22.12+ 压缩包解压到私有目录并将 `command` 指向其中的绝对 `node` 路径；不要求全局安装。示例：

```json
{
  "command": "/absolute/path/to/portable-node/bin/node",
  "args": [
    "/absolute/path/to/sanityblog/dist/server.mjs"
  ]
}
```

## 客户端配置

一键安装会自动配置 Codex personal marketplace。其他客户端出于各自的安全边界，不应由第三方脚本静默改写其设置；把上面的 Windows stdio 子项合并到对应配置即可。连接成功后应看到全部 `sanity_blog_*` 工具。

### Codex

`.codex-plugin/plugin.json` 会加载 `skills/`，并内联声明 Codex MCP Server。Git marketplace 版本使用 `node`、`./dist/server.mjs` 和相对插件根目录的 `cwd`；Windows 一键安装器会在 staging 中把同一配置改写为便携 Node 的绝对路径。通常无需手工编辑 `%USERPROFILE%\.codex\config.toml`。如不用插件系统，可手工配置：

```toml
[mcp_servers.sanityblog]
command = "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\runtime\\node.exe"
args = ["C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\dist\\server.mjs"]
startup_timeout_sec = 15
```

### Claude Desktop

配置位置：

- Windows：`%APPDATA%\Claude\claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux/XDG：`${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json`

合并以下子项，不要覆盖已有 `mcpServers`：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\runtime\\node.exe",
      "args": [
        "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\dist\\server.mjs"
      ]
    }
  }
}
```

保存后完全退出并重新启动 Claude Desktop。

### Claude Code

从一键安装目录加载完整插件：

```powershell
claude --plugin-dir "$HOME\plugins\sanityblog"
```

安装器生成的 `.mcp.json` 使用 `${CLAUDE_PLUGIN_ROOT}/runtime/node.exe` 和 `${CLAUDE_PLUGIN_ROOT}/dist/server.mjs`，因此技能与 MCP Server 会一起加载。也可把 `skills/sanity-blog-publish` 和 `skills/sanity-blog-update` 复制到 `.claude/skills/`。

### Cursor

项目配置为 `<project>/.cursor/mcp.json`；全局配置为 Windows `%USERPROFILE%\.cursor\mcp.json` 或 macOS/Linux `~/.cursor/mcp.json`。合并 Claude Desktop 示例中的 `mcpServers.sanityblog`，在 Cursor MCP 设置中启用，并保留写操作人工确认。

### VS Code / GitHub Copilot Agent Plugins

项目配置放在 `.vscode/mcp.json`。VS Code 使用顶层 `servers`：

```json
{
  "servers": {
    "sanityblog": {
      "type": "stdio",
      "command": "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\runtime\\node.exe",
      "args": [
        "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\dist\\server.mjs"
      ]
    }
  }
}
```

VS Code/Copilot Agent Plugins 也可读取仓库内 Claude 格式 manifest；`.vscode/mcp.json` 是最直接的 MCP 接入方式。云端代理无法启动用户电脑上的本地 stdio Server。

### Windsurf

全局配置位置为 Windows `%USERPROFILE%\.codeium\windsurf\mcp_config.json` 或 macOS/Linux `~/.codeium/windsurf/mcp_config.json`。合并 Claude Desktop 示例中的 `mcpServers.sanityblog`，然后在 Cascade 的 MCP 设置中启用所需工具。

### Cline

用户级配置通常为 Windows `%USERPROFILE%\.cline\mcp.json` 或 macOS/Linux `~/.cline/mcp.json`。在 **MCP Servers → Configure** 中合并：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\runtime\\node.exe",
      "args": [
        "C:\\Users\\YOUR_NAME\\plugins\\sanityblog\\dist\\server.mjs"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

保持 `autoApprove` 为空，让发布和更新始终经过人工审批。

### macOS/Linux 源码安装与开发

需要在非 Windows 平台直接从源码运行时，安装 Node.js 22.12 或更高版本：

```bash
git clone https://github.com/1nv0ker/dashboard.git sanityblog
cd sanityblog
npm install
node src/cli.mjs --init
node src/cli.mjs --check
```

生产依赖也可用 `npm ci --omit=dev --ignore-scripts` 严格按 lockfile 安装。客户端 MCP JSON 中仍须使用 `command` 与独立绝对 `args`，不得保存 token。

## 技能安装

插件原生提供两个技能：

- `sanity-blog-publish`：准备并发布新文章；仅在 POST dry-run 返回明确冲突后，才允许经过 PUT dry-run 的受控更新路径。
- `sanity-blog-update`：更新明确存在的文章；始终是 PUT dry-run 加一次 PUT，永不 POST 创建。

Codex 和 Claude Code 以插件方式安装时会自动发现根目录 `skills/`。其他客户端如果支持 Agent Skills，可把两个技能目录复制到其项目级技能目录：

| 客户端 | 常用项目级目录 |
| --- | --- |
| Cursor | `.cursor/skills/` 或 `.agents/skills/` |
| VS Code / Copilot | `.github/skills/` 或 `.agents/skills/` |
| Windsurf | `.windsurf/skills/` 或 `.agents/skills/` |
| Cline | `.cline/skills/`；部分版本也识别 `.claude/skills/` |
| Claude Code | `.claude/skills/`，或直接安装本插件 |

两个技能的 `agents/openai.yaml` 都设置 `policy.allow_implicit_invocation: false`。不识别该字段的客户端通常会忽略它，因此仍须依靠工具审批策略；不要把写工具加入自动批准名单。再次强调：MCP tools 可被更多客户端调用，但完整技能工作流只有支持 Agent Skills 或插件技能的客户端才能加载。

## MCP 工具

| 工具 | 作用 | 远端影响 |
| --- | --- | --- |
| `sanity_blog_check_config` | 检查本机配置是否可用 | 无 |
| `sanity_blog_prepare_publish` | 为 base slug 建立发布 staging 与 reservation | 仅本机 |
| `sanity_blog_prepare_update` | 为已有 slug 建立更新 staging 与 reservation | 仅本机 |
| `sanity_blog_validate` | 校验指定 `articlePath` 的本地快照 | 无 |
| `sanity_blog_probe_publish` | 自身执行 POST dry-run；仅明确冲突时内部执行 PUT dry-run | 不提交远端内容 |
| `sanity_blog_probe_update` | 对更新候选执行 PUT dry-run | 不提交远端内容 |
| `sanity_blog_commit` | 提交 slug reservation，锁定最终尝试 | 仅本机 |
| `sanity_blog_release` | 在明确未发生远端写入时释放 reservation | 仅本机 |
| `sanity_blog_publish` | 发布快照：一次 POST；仅明确冲突时走受控 PUT | 写远端 |
| `sanity_blog_update` | 对已有文章执行一次 PUT | 写远端 |

所有输入 schema 都使用 `additionalProperties: false`。调用方必须使用工具暴露的确切参数：

```text
sanity_blog_check_config({})
sanity_blog_prepare_publish({baseSlug})
sanity_blog_prepare_update({slug})
sanity_blog_validate({articlePath})
sanity_blog_probe_publish({articlePath})
sanity_blog_probe_update({articlePath})
sanity_blog_commit({slug, reservationId})
sanity_blog_release({slug, reservationId})
sanity_blog_publish({articlePath})
sanity_blog_update({articlePath})
```

## 严格操作顺序

发布和更新都遵守以下阶段：

1. `prepare_*` 创建独立 staging 和 reservation。
2. 在 staging 中生成或修改文章与封面。
3. `validate` 在本地校验；失败时不发送远端写请求。
4. `probe_*` 对将要发送的精确快照执行 dry-run。`sanity_blog_probe_publish` 自己完成 POST dry-run，并且只在明确冲突时内部完成 PUT dry-run；调用方不再额外调用 `probe_update`。
5. probe 成功后立刻冻结所有 staging 文件，不再修改 Markdown、文章 JSON、封面或 metadata。需要修改时必须放弃本次 probe，并在安全释放后重新准备、校验和 probe。
6. 请求层根据 probe 模式处理 publication time：`mode=create` 在同一次尝试中写当前 UTC `publishedAt`；`mode=update` 自动从请求中省略 `publishedAt`。调用方不要在 probe 后手工增删该字段。
7. 向用户展示目标、slug、模式、字段变化、来源和封面，并取得最终确认。
8. `commit` reservation，并以 commit 返回的最终 `articlePath`、`markdownPath`、`coverPath` 为准。
9. 只调用一次最终 `publish` 或 `update`，且传入 commit 返回的最终 `articlePath`。最终工具会内部重新 dry-run 并绑定 revision。

发布流程只接受 `sanity_blog_probe_publish` 返回的 create 模式或其明确冲突驱动的 update 模式。更新流程永远不使用 POST；`sanity_blog_prepare_update` 只确认完整本地文章三件套并建立 staging，远端文章是否存在必须由 `sanity_blog_probe_update` 证明。probe 报告远端缺失时必须硬停止，不能创建替代文章。

## 本地发布记录

只有最终 POST/PUT 已被确认成功，并且响应中的 slug、ID、revision 与 target 全部通过校验后，Server 才写本地记录：

```text
~/.sanity-blog/published/<slug>.json
```

记录语义：

- 同一 slug 保存最近一次确认成功的结果；新成功会原子替换旧记录。
- 先在同目录写完整临时文件，再执行原子 replace。
- 拒绝记录目录或目标文件的 symlink。
- 记录文件限制为当前用户访问。
- probe、校验失败、API 失败、超时或结果不确定时都不写记录，也不覆盖旧记录。
- `recordPath` 是成功响应中实际写入的记录路径，不要自行推测。

记录只包含安全审计字段：

- `schemaVersion`
- `recordedAt`
- `operation`：`created` 或 `updated`
- `article`：实际发送的不可变请求快照；PUT 快照已移除 `publishedAt`
- `result`：`status`、`id`、`revision`、`slug`、`requestId`、`uploadedAssetIds` 和 target 的 `projectId`、`dataset`、`apiVersion`

记录不保存 token、origin、headers、原始响应 body、stack 或临时文件内容。它是审计与恢复线索，不是远端事务回滚，也不能证明一次结果不确定的请求没有成功。

## 部分成功与禁止重试

如果远端已经确认成功，但本地记录写入失败，工具返回：

```json
{
  "code": "PUBLISHED_BUT_RECORD_WRITE_FAILED",
  "remoteMutationSucceeded": true
}
```

响应还会携带安全 receipt/result，包括：

```text
status, id, revision, slug, requestId, uploadedAssetIds, target, operation
```

这是**部分成功**，不是可安全重试的失败：

- 远端 POST/PUT 已成功。
- 不得重试 `sanity_blog_publish` 或 `sanity_blog_update`。
- 不得改用另一种 HTTP 方法。
- 不得重复上传封面；`uploadedAssetIds` 可能已在远端生效。
- 不得因为缺少 `recordPath` 就假设文章未发布。
- 应保存安全回执，独立核对远端状态，再单独修复本地记录问题。

对超时、连接断开、取消或格式错误等**结果不确定**情况也禁止自动重试。先通过独立远端状态核对确认结果，再决定是否开始全新的 staging/reservation。

## 故障排查

### 客户端看不到工具

1. 使用便携运行时执行配置检查：

   ```powershell
   $plugin = Join-Path $HOME 'plugins\sanityblog'
   & "$plugin\runtime\node.exe" "$plugin\src\cli.mjs" --check
   ```

2. 确认 MCP 的 `command` 和 `args` 都是实际绝对路径，且没有 token。
3. 运行 `& "$plugin\runtime\node.exe" --version`，应看到 `v22.23.1`。
4. 完全重启客户端并创建新任务，查看 MCP stderr 日志。
5. 检查顶层格式：VS Code 使用 `servers`，Codex、Claude Desktop 和多数其他客户端使用 `mcpServers`。

### Server 启动后立即退出

重新运行一键安装命令以修复便携运行时、锁定依赖和 MCP 路径，再执行 `--check`。不要在 stdio 命令外包一层会输出 banner 或改写 stdout 的脚本。

### 配置或 token 失效

重新初始化并检查：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\src\cli.mjs" --init
& "$plugin\runtime\node.exe" "$plugin\src\cli.mjs" --check
```

初始化只询问发布 API origin、Sanity project ID、dataset 和隐藏 token。发布前核对 `--check` 返回的 origin；不要把完整配置文件粘贴给 AI，只提供脱敏后的错误 code 和安全 receipt 字段。

### 发布或更新结果不确定

不要再次调用最终工具。保留 staging、slug、reservationId、requestId 和安全回执，通过远端管理界面或受信任的只读查询核对实际状态。

## 开发检查

以下命令仅供仓库开发者使用；一键安装用户不需要安装系统 Node.js 或运行测试。开发环境要求 Node.js 22.12+：

```powershell
git clone https://github.com/1nv0ker/dashboard.git sanityblog
Set-Location sanityblog
npm install
npm run check
npm test
```

`npm test` 会先重新生成 `dist/server.mjs`，再运行 Node 测试，包括配置、预构建 MCP、远端 mock、工作区、发布记录和安装器测试。它不替代 manifest/skill validators。若本机安装了 Codex 系统技能，在仓库根目录运行：

```powershell
$repo = (Get-Location).Path
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }
python "$codexHome\skills\.system\skill-creator\scripts\quick_validate.py" "$repo\skills\sanity-blog-publish"
python "$codexHome\skills\.system\skill-creator\scripts\quick_validate.py" "$repo\skills\sanity-blog-update"
python "$codexHome\skills\.system\plugin-creator\scripts\validate_plugin.py" $repo
```

如已安装 Claude Code，再运行：

```powershell
claude plugin validate (Get-Location).Path --strict
```

最后人工确认：Codex/Claude 能加载对应 manifest、客户端能列出全部 `sanity_blog_*` 工具、写工具保持人工审批、两个技能不会被隐式调用。
## 兼容规范

- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [VS Code Agent Plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
