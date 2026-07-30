# sanityblog

`sanityblog` 是一个本地 stdio MCP 插件，提供文章预览、发布和更新三个显式技能。

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

### 从源码安装

适用于 macOS、Linux，或需要本地开发的环境：

```bash
git clone https://github.com/1nv0ker/blog.git sanityblog
cd sanityblog
npm install
npm run build
node src/cli.mjs --init
```

安装或更新后，请完全重启 Codex/客户端并新建任务，使 MCP Server 和技能重新加载。

## 如何初始化配置

Windows 一键安装会自动进入初始化。手动初始化或更换配置时：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\dist\cli.mjs" --init
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

检查配置：

```powershell
$plugin = Join-Path $HOME 'plugins\sanityblog'
& "$plugin\runtime\node.exe" "$plugin\dist\cli.mjs" --check
```

源码模式使用：

```bash
node src/cli.mjs --check
```

不要把 token 放进仓库、MCP 参数、客户端配置或聊天内容，只配置你信任的发布服务。

## 技能概览

| 技能 | 用途 |
| --- | --- |
| `sanity-blog-preview` | 生成双语 Markdown、严格文章 JSON 和 PNG 封面，并输出本地 HTML 可视化预览；不探测或写入发布服务 |
| `sanity-blog-publish` | 创建并发布新文章；先校验和预览，用户接受后 dry-run，最终确认后才写入远端 |
| `sanity-blog-update` | 更新明确存在的文章；保持 PUT-only，不会在文章缺失时改为创建 |

发布和更新都会用 `previewRevision` 绑定用户接受的 JSON、Markdown 和封面快照。文件变化后必须重新预览；最终远端写入始终需要用户明确确认。
