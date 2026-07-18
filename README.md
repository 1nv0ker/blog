# sanityblog

`sanityblog` 是一个本机 Node.js stdio MCP Server 插件，用于准备、校验、探测、发布和更新博客文章。插件把“发布新文章”和“更新现有文章”拆成两个必须显式调用的技能，并把真正的远端写入留在最后一步确认之后。

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

- 本机 MCP Server：`src/server.mjs`
- 配置 CLI：`src/cli.mjs`
- 发布技能：`skills/sanity-blog-publish/`
- 更新技能：`skills/sanity-blog-update/`
- Codex 插件清单：`.codex-plugin/plugin.json`
- Claude Code 插件清单：`.claude-plugin/plugin.json`

最终的 `sanity_blog_publish` 和 `sanity_blog_update` 会修改远端内容。客户端展示的 `readOnlyHint`、`destructiveHint` 等 MCP annotations 只是提示，不是权限边界；是否允许写入必须由用户确认、客户端审批策略和服务端校验共同决定。

## 安装

### 1. 安装 Node.js 与依赖

安装 Node.js 22.12 或更高版本，并确认：

```powershell
node --version
npm --version
```

Codex 的打包配置固定指向以下路径，请把完整插件目录放在：

```text
C:\work\plugins\sanityblog
```

然后安装依赖：

```powershell
Set-Location C:\work\plugins\sanityblog
npm install
```

如果安装到其他位置，Claude 插件仍可通过 `${CLAUDE_PLUGIN_ROOT}` 工作，但 Codex 的 `.codex-mcp.json` 以及下文各客户端的手工配置必须改成真实绝对路径。

### 2. 初始化配置

配置固定保存在：

```text
~/.sanity-blog/config.json
```

在 Windows 中通常对应：

```text
%USERPROFILE%\.sanity-blog\config.json
```

推荐使用交互式初始化：

```powershell
node C:\work\plugins\sanityblog\src\cli.mjs --init
```

CLI 会根据提示或其支持的环境变量创建配置。不要把 token 放进 MCP 客户端 JSON、命令行参数、仓库文件或聊天内容。

配置对象包含五个必填字段：`publisherApiOrigin`、`projectId`、`dataset`、`apiVersion`、`sanityToken`；`workspaceRoot` 是可选字段。旧版五字段配置省略 `workspaceRoot` 时，Server 默认使用 `C:\work\MIYA-LLC-WEB\miyaip2026`。这些配置字段只能来自本机配置文件，不能作为任何 `sanity_blog_*` 工具的参数；工具调用必须严格使用其公开 schema。

也可以手工创建：

```powershell
New-Item -ItemType Directory -Force "$HOME\.sanity-blog"
Copy-Item C:\work\plugins\sanityblog\config.example.json "$HOME\.sanity-blog\config.json"
```

随后只在本机编辑该文件，并限制为当前用户可访问。

### 3. 检查配置与测试

检查实际运行时配置：

```powershell
node C:\work\plugins\sanityblog\src\cli.mjs --check
```

`npm run check` 只是同一个安全配置检查的 npm 入口，等价于 `node src/cli.mjs --check`：

```powershell
Set-Location C:\work\plugins\sanityblog
npm run check
```

它不运行测试，也不校验插件 manifest 或技能。运行项目测试：

```powershell
Set-Location C:\work\plugins\sanityblog
npm test
```

必须先让配置检查成功，再连接 AI 客户端。配置变更后重启 MCP Server 或对应客户端。

## stdio 启动约定

最通用、最稳妥的客户端配置是把可执行文件和参数分开：

```json
{
  "command": "node",
  "args": [
    "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
  ]
}
```

macOS/Linux 同样必须使用独立的绝对路径。例如把插件安装在 `/opt/sanityblog` 时：

```json
{
  "command": "node",
  "args": [
    "/opt/sanityblog/src/server.mjs"
  ]
}
```

如果 `node` 不在服务进程的 `PATH` 中，把 `command` 改为实际绝对路径，例如 `/usr/local/bin/node`。不要在 JSON 中使用 `~` 代替绝对插件路径。

Windows 注意事项：

- JSON 中的反斜杠必须写成 `\\`。
- 不要把 `node "C:\path with spaces\server.mjs"` 拼成一个 `command` 字符串。
- 不要依赖客户端的当前工作目录；始终使用服务端文件的绝对路径。
- 优先直接调用 `node`，不要把 `npx`、`.cmd`、管道、重定向或 shell 运算符作为跨客户端基线。
- 如果 `node` 不在 `PATH` 中，把 `command` 改为 `C:\\Program Files\\nodejs\\node.exe`。
- 在 WSL、SSH、Dev Container 或远程工作区中，`node` 和服务端路径必须都属于客户端实际运行的环境；不要混用 Windows 路径与 Linux Node。
- stdio Server 的 stdout 只用于 MCP JSON-RPC。日志应写 stderr，不要在外面再套会改写 stdout 的脚本。

## 客户端配置

下列配置均启动同一个本机 Server。连接后应看到以 `sanity_blog_` 开头的工具。

### Codex

#### 插件方式

`.codex-plugin/plugin.json` 已将技能目录指向 `./skills/`，并将 MCP 配置指向 `./.codex-mcp.json`。该文件固定使用：

```text
C:\work\plugins\sanityblog\src\server.mjs
```

把插件加入 Codex 的个人或团队 marketplace 后，在插件目录中安装并启用 `sanityblog`。为写工具保留“每次询问”或更严格的审批策略，不要为 `sanity_blog_publish`、`sanity_blog_update` 自动批准。

Codex 桌面 marketplace 清单位于 `C:\work\.agents\plugins\marketplace.json`。确认其中存在 `workspace → sanityblog` 映射，并将该插件标记为 `AVAILABLE`、安装策略标记为 `ON_INSTALL`。

marketplace 安装或升级后，完全重启 ChatGPT/Codex 桌面应用并创建一个新任务。已经打开的任务不会可靠地重新载入新 manifest、MCP 配置或技能版本。

如果暂不使用 marketplace，可直接编辑 `%USERPROFILE%\.codex\config.toml`：

```toml
[mcp_servers.sanityblog]
command = "node"
args = ["C:\\work\\plugins\\sanityblog\\src\\server.mjs"]
startup_timeout_sec = 15
```

Codex CLI、Codex IDE 扩展和 ChatGPT 桌面版中的 Codex 使用同一类配置。ChatGPT 网页端不能读取本机 stdio 配置。

### Claude Desktop

配置文件位置：

- Windows：`%APPDATA%\Claude\claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux/XDG 兼容发行版：`${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json`

加入：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ]
    }
  }
}
```

如果文件已有其他 `mcpServers`，只合并 `sanityblog` 子项，不要覆盖其他配置。完全退出并重新启动 Claude Desktop。

### Claude Code

插件开发或本机加载：

```powershell
claude --plugin-dir C:\work\plugins\sanityblog
```

插件根目录的 `.mcp.json` 使用字面量 `${CLAUDE_PLUGIN_ROOT}/src/server.mjs`，因此 Claude Code 安装插件后可从任意插件安装目录启动 Server。不要把该字面量预先替换成 staging 路径。

不使用插件系统时，可把以下内容放入项目根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ]
    }
  }
}
```

也可使用 CLI：

```powershell
claude mcp add --transport stdio sanityblog -- node C:\work\plugins\sanityblog\src\server.mjs
```

### Cursor

项目配置在各平台均放在 `<project>/.cursor/mcp.json`。全局配置位置：

- Windows：`%USERPROFILE%\.cursor\mcp.json`
- macOS/Linux：`~/.cursor/mcp.json`

配置内容：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ]
    }
  }
}
```

在 Cursor 的 MCP 设置中启用 Server，并保持写工具需要人工确认。

### VS Code / GitHub Copilot

项目配置放在 `.vscode/mcp.json`。注意 VS Code 使用顶层 `servers`，不是 `mcpServers`：

```json
{
  "servers": {
    "sanityblog": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ]
    }
  }
}
```

也可以通过命令面板打开用户级 MCP 配置。这里指本机 VS Code/Copilot Agent；运行在云端的代理无法直接启动用户电脑上的 stdio Server。

VS Code 的 Agent Plugins 功能可读取 Claude 格式插件，但该功能在部分版本中仍为 Preview。稳定接入方式仍是 `.vscode/mcp.json`。

### Windsurf

全局配置位置：

- Windows：`%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- macOS/Linux：`~/.codeium/windsurf/mcp_config.json`

加入：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ]
    }
  }
}
```

在 Cascade 的 MCP 设置中启用 Server 和所需工具。Windsurf 对可启用工具数量有上限时，只启用本插件实际使用的工具。

### Cline

Cline CLI 的用户级配置通常位于：

- Windows：`%USERPROFILE%\.cline\mcp.json`
- macOS/Linux：`~/.cline/mcp.json`

IDE 扩展的具体内部存储位置可能随版本变化，因此优先在 Cline 面板中打开 **MCP Servers → Configure**，然后合并：

```json
{
  "mcpServers": {
    "sanityblog": {
      "command": "node",
      "args": [
        "C:\\work\\plugins\\sanityblog\\src\\server.mjs"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

保留空的 `autoApprove`，让发布和更新始终经过人工审批。

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

1. 运行 `node C:\work\plugins\sanityblog\src\cli.mjs --check`。
2. 确认客户端配置使用 `command: node` 和独立的绝对 `args`。
3. 在同一运行环境中确认 `node --version`。
4. 完全重启客户端，并查看它的 MCP 日志。
5. 确认没有把 `.mcp.json` 的顶层格式混用：VS Code 是 `servers`，多数其他客户端是 `mcpServers`，Codex 插件文件是直接 server map。

### Server 启动后立即退出

检查 Node 版本、依赖安装、服务端绝对路径以及配置文件权限。不要在 stdio 命令外包一层会输出 banner 或改写 stdout 的脚本。

### 配置或 token 失效

重新运行：

```powershell
node C:\work\plugins\sanityblog\src\cli.mjs --init
node C:\work\plugins\sanityblog\src\cli.mjs --check
```

不要把配置文件内容粘贴给 AI。只提供脱敏后的错误 code 和安全 receipt 字段。

### 发布或更新结果不确定

不要再次调用最终工具。保留 staging、slug、reservationId、requestId 和安全回执，通过远端管理界面或受信任的只读查询核对实际状态。

## 开发检查

配置检查（两条命令等价，任选其一）：

```powershell
Set-Location C:\work\plugins\sanityblog
npm run check
node C:\work\plugins\sanityblog\src\cli.mjs --check
```

运行 Node 测试：

```powershell
Set-Location C:\work\plugins\sanityblog
npm test
```

`npm test` 只运行 `node --test --test-concurrency=1`，不替代以下 manifest/skill validators。若本机安装了 Codex 系统技能，运行：

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }
python "$codexHome\skills\.system\skill-creator\scripts\quick_validate.py" C:\work\plugins\sanityblog\skills\sanity-blog-publish
python "$codexHome\skills\.system\skill-creator\scripts\quick_validate.py" C:\work\plugins\sanityblog\skills\sanity-blog-update
python "$codexHome\skills\.system\plugin-creator\scripts\validate_plugin.py" C:\work\plugins\sanityblog
```

如果已安装 Claude Code，再运行：

```powershell
claude plugin validate C:\work\plugins\sanityblog --strict
```

最后分别人工验证：

- Codex 能载入 `.codex-plugin/plugin.json` 与 `.codex-mcp.json`
- Claude Code 能载入 `.claude-plugin/plugin.json` 与保留字面量 `${CLAUDE_PLUGIN_ROOT}` 的 `.mcp.json`
- 客户端能列出全部 `sanity_blog_*` 工具
- 写工具保持人工审批
- 发布与更新技能不会被隐式调用

## 兼容规范

- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [VS Code Agent Plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
