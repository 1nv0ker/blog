# sanityblog

`sanityblog` 是一个本地 stdio MCP 插件，为旧 `blogPost` 和发布器 API 1.1
富内容提供相互隔离的预览、发布和更新技能。

源码仓库：[1nv0ker/blog](https://github.com/1nv0ker/blog)

## 如何安装

### Codex Marketplace

本机已安装 Node.js 22.12 或更高版本时，可直接执行：

```powershell
codex plugin marketplace add https://github.com/1nv0ker/blog --ref main
codex plugin add sanityblog@sanityblog
```

### Windows 一键安装

一键安装器自带便携 Node.js，不需要预先安装 Git、Node.js 或 npm：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/1nv0ker/blog/main/install.ps1' | iex"
```

### macOS 一键安装

支持 Apple Silicon 和 Intel Mac。安装器同样自带经过 SHA-256 校验的便携
Node.js，不需要预先安装 Git、Node.js 或 npm，也不需要 `sudo`：

```bash
/bin/bash -c 'set -o pipefail; curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL "https://raw.githubusercontent.com/1nv0ker/blog/main/install.sh" | /bin/bash'
```

安装器默认写入 `~/plugins/sanityblog`，自动初始化配置并注册个人
Marketplace。更新时可重复运行同一命令；新版本激活失败会恢复旧安装。

### 从源码安装

适用于 Linux，或需要本地开发的环境：

```bash
git clone https://github.com/1nv0ker/blog.git sanityblog
cd sanityblog
npm install
npm run build
node src/cli.mjs --init
```

安装或更新后，请完全重启 Codex/客户端并新建任务，使 MCP Server 和技能重新加载。

## 如何初始化配置

Windows 和 macOS 一键安装都会自动进入初始化。Windows 手动初始化或更换配置时：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\dist\cli.mjs" --init
```

macOS 一键安装目录使用：

```bash
plugin="$HOME/plugins/sanityblog"
"$plugin/runtime/bin/node" "$plugin/dist/cli.mjs" --init
```

从源码运行时：

```bash
node src/cli.mjs --init
```

初始化需要以下四项：

- `publisherApiOrigin`：发布服务的裸 HTTPS origin，默认 `https://publish.miyaip.com`
- `projectId`：Sanity Project ID
- `dataset`：Sanity dataset，默认 `production`
- `sanityToken`：Sanity token，输入时隐藏

配置保存在 `~/.sanity-blog/config.json`。`apiVersion` 固定为 `2026-07-05`，本地工作区自动创建在 `~/.sanity-blog/workspace`。

六类富内容还使用非敏感的 `publicSiteOrigin` 校验 canonical URL，默认
`https://miyaip.com`。现有四字段配置会自动使用该默认值，无需迁移。需要修改时运行：

```bash
node src/cli.mjs --init-content
```

macOS 一键安装目录中对应命令为：

```bash
plugin="$HOME/plugins/sanityblog"
"$plugin/runtime/bin/node" "$plugin/dist/cli.mjs" --init-content
```

该模式会额外询问 `publicSiteOrigin`。旧 `--init` 流程和旧 blog 工具的配置输出保持不变。

检查配置：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\dist\cli.mjs" --check
```

macOS 一键安装目录使用：

```bash
plugin="$HOME/plugins/sanityblog"
"$plugin/runtime/bin/node" "$plugin/dist/cli.mjs" --check
```

源码模式使用：

```bash
node src/cli.mjs --check
```

不要把 token 放进仓库、MCP 参数、客户端配置或聊天内容，只配置你信任的发布服务。

## 技能概览

插件公开 7 类 × 3 操作共 21 个类型专属技能。旧 `blog-post` 保留原名称；
其余六类统一使用 `sanity-content-<type>-<operation>`：

| 类型 | 本地预览 | 远端发布 | 严格更新 |
| --- | --- | --- | --- |
| `blog-post` | `sanity-blog-preview` | `sanity-blog-publish` | `sanity-blog-update` |
| `blog-en` | `sanity-content-blog-en-preview` | `sanity-content-blog-en-publish` | `sanity-content-blog-en-update` |
| `guide` | `sanity-content-guide-preview` | `sanity-content-guide-publish` | `sanity-content-guide-update` |
| `comparison` | `sanity-content-comparison-preview` | `sanity-content-comparison-publish` | `sanity-content-comparison-update` |
| `solution` | `sanity-content-solution-preview` | `sanity-content-solution-publish` | `sanity-content-solution-update` |
| `alternative` | `sanity-content-alternative-preview` | `sanity-content-alternative-publish` | `sanity-content-alternative-update` |
| `tutorial` | `sanity-content-tutorial-preview` | `sanity-content-tutorial-publish` | `sanity-content-tutorial-update` |

预览只处理本地 bundle，不探测或写入发布服务。发布先校验和预览，再
dry-run，并仅在最终确认后写入远端。更新保持 PUT-only，文档缺失时绝不创建。

发布和更新都会用 `previewRevision` 绑定用户接受的 JSON、Markdown 和所有本地
asset 字节。文件变化后必须重新预览；最终远端写入始终需要用户明确确认。

旧 blog bundle 继续位于 `workspace/blog`。新富内容按类型与 slug 隔离在
`workspace/contents/<type>/<slug>/`，其中包含同名 Markdown、JSON 和 `assets/`
目录；不同内容类型可以安全使用相同 slug。新发布记录写入
`~/.sanity-blog/published/contents/<type>/<slug>.json`，不会覆盖旧 blog 收据。
