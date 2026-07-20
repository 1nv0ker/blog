import {createHash, randomUUID} from 'node:crypto'
import {
  chmod,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

import {materializeArticlePreviewAssets} from './article.mjs'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
const FILE_MODE = 0o600

export class PreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PreviewError'
    this.category = 'preview'
    this.code = code
    this.retryable = false
    this.resultUnknown = false
  }
}

function fail(code, message) {
  throw new PreviewError(code, message)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function inspectMarkdown(articlePath, slug) {
  const markdownPath = path.join(path.dirname(articlePath), `${slug}.md`)
  let pathInfo
  let resolved
  try {
    pathInfo = await lstat(markdownPath, {bigint: true})
    resolved = await realpath(markdownPath)
  } catch {
    fail(
      'PREVIEW_MARKDOWN_INVALID',
      'The sibling Markdown source is missing or unavailable.',
    )
  }
  if (
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    resolved !== markdownPath ||
    pathInfo.size <= 0n ||
    pathInfo.size > BigInt(MAX_MARKDOWN_BYTES)
  ) {
    fail(
      'PREVIEW_MARKDOWN_INVALID',
      'The sibling Markdown source must be a regular non-empty file no larger than 2 MiB.',
    )
  }

  let handle
  let source
  let bytes
  try {
    handle = await open(markdownPath, 'r')
    const before = await handle.stat({bigint: true})
    if (!before.isFile() || !sameFileSnapshot(pathInfo, before)) {
      fail('PREVIEW_MARKDOWN_CHANGED', 'The Markdown source changed while it was inspected.')
    }
    bytes = await handle.readFile()
    const after = await handle.stat({bigint: true})
    if (
      !sameFileSnapshot(before, after) ||
      bytes.length !== Number(before.size) ||
      bytes.length > MAX_MARKDOWN_BYTES
    ) {
      fail('PREVIEW_MARKDOWN_CHANGED', 'The Markdown source changed while it was inspected.')
    }
    try {
      source = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    } catch {
      fail('PREVIEW_MARKDOWN_INVALID', 'The Markdown source must be valid UTF-8 text.')
    }
    if (source.trim().length === 0) {
      fail('PREVIEW_MARKDOWN_INVALID', 'The Markdown source must not be blank.')
    }
  } finally {
    await handle?.close().catch(() => {})
  }
  return {
    markdownPath,
    source,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function safeLinkHref(value) {
  if (value.startsWith('/') && !value.startsWith('//')) return true
  if (value.startsWith('#') || value.startsWith('./') || value.startsWith('../')) return true
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)
  } catch {
    return false
  }
}

function renderMarkdownInline(source, depth = 0) {
  if (depth > 12 || source.length === 0) return escapeHtml(source)
  const patterns = [
    {kind: 'code', expression: /`([^`\n]+)`/u},
    {kind: 'link', expression: /\[([^\]\n]+)\]\(([^)\s]+)\)/u},
    {kind: 'strong', expression: /\*\*([^*\n]+)\*\*/u},
    {kind: 'strong', expression: /__([^_\n]+)__/u},
    {kind: 'em', expression: /\*([^*\n]+)\*/u},
    {kind: 'em', expression: /_([^_\n]+)_/u},
  ]
  let selected
  for (const pattern of patterns) {
    const match = pattern.expression.exec(source)
    if (!match) continue
    if (!selected || match.index < selected.match.index) {
      selected = {kind: pattern.kind, match}
    }
  }
  if (!selected) return escapeHtml(source)

  const before = source.slice(0, selected.match.index)
  const after = source.slice(selected.match.index + selected.match[0].length)
  let rendered
  if (selected.kind === 'code') {
    rendered = `<code>${escapeHtml(selected.match[1])}</code>`
  } else if (selected.kind === 'link') {
    const label = renderMarkdownInline(selected.match[1], depth + 1)
    const href = selected.match[2]
    rendered = safeLinkHref(href)
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="unsafe-link" title="Unsupported link omitted">${label}</span>`
  } else if (selected.kind === 'strong') {
    rendered = `<strong>${renderMarkdownInline(selected.match[1], depth + 1)}</strong>`
  } else {
    rendered = `<em>${renderMarkdownInline(selected.match[1], depth + 1)}</em>`
  }
  return `${escapeHtml(before)}${rendered}${renderMarkdownInline(after, depth + 1)}`
}

function renderMarkdown(source) {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const output = []
  let paragraph = []
  let list
  let quote = []

  function flushParagraph() {
    if (paragraph.length > 0) {
      output.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }

  function flushList() {
    if (!list) return
    output.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`)
    list = undefined
  }

  function flushQuote() {
    if (quote.length > 0) {
      output.push(`<blockquote>${renderMarkdownInline(quote.join(' '))}</blockquote>`)
      quote = []
    }
  }

  function flushFlow() {
    flushParagraph()
    flushList()
    flushQuote()
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = /^```([A-Za-z0-9_-]{0,64})\s*$/u.exec(line.trim())
    if (fence) {
      flushFlow()
      const code = []
      index += 1
      while (index < lines.length && lines[index].trim() !== '```') {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const language = fence[1] || 'text'
      output.push(`<figure class="code-block"><figcaption>${escapeHtml(language)}</figcaption><pre><code>${escapeHtml(code.join('\n'))}</code></pre></figure>`)
      continue
    }

    if (line.trim().length === 0) {
      flushFlow()
      index += 1
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading) {
      flushFlow()
      const level = Math.max(2, heading[1].length)
      output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    const quoteLine = /^>\s?(.*)$/u.exec(line)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1])
      index += 1
      continue
    }

    const listItem = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.+)$/u.exec(line)
    if (listItem) {
      flushParagraph()
      flushQuote()
      const tag = listItem[3] ? 'ol' : 'ul'
      if (list && list.tag !== tag) flushList()
      list ??= {tag, items: []}
      const level = Math.min(10, Math.floor(listItem[1].replaceAll('\t', '  ').length / 2) + 1)
      list.items.push(`<li class="list-level-${level}">${renderMarkdownInline(listItem[4])}</li>`)
      index += 1
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line.trim())
    index += 1
  }
  flushFlow()
  return output.join('\n')
}

function localAssetUrl(source, localAssets) {
  if (!source || typeof source !== 'object' || !('path' in source)) return undefined
  return localAssets.get(source.path)
}

function localAssetPath(articlePath, source) {
  if (!source || typeof source !== 'object' || !('path' in source)) return undefined
  const filename = source.path.slice('./assets/'.length)
  return path.join(path.dirname(articlePath), 'assets', filename)
}

function renderSpans(block) {
  const definitions = new Map(
    (block.markDefs ?? [])
      .filter((definition) => definition?._key)
      .map((definition) => [definition._key, definition]),
  )
  return block.children
    .map((child) => {
      let rendered = escapeHtml(child.text)
      for (const mark of child.marks ?? []) {
        if (mark === 'strong') {
          rendered = `<strong>${rendered}</strong>`
        } else if (mark === 'em') {
          rendered = `<em>${rendered}</em>`
        } else if (mark === 'code') {
          rendered = `<code>${rendered}</code>`
        } else {
          const definition = definitions.get(mark)
          if (definition?._type === 'link') {
            rendered = `<a href="${escapeHtml(definition.href)}" target="_blank" rel="noopener noreferrer">${rendered}</a>`
          }
        }
      }
      return rendered
    })
    .join('')
}

function renderImage(item, localAssets) {
  const sourceUrl = localAssetUrl(item.source, localAssets)
  if (!sourceUrl) {
    return `<figure class="asset-placeholder" role="img" aria-label="${escapeHtml(item.alt)}">
      <div class="asset-placeholder__icon">◇</div>
      <strong>Remote Sanity image</strong>
      <span>${escapeHtml(item.alt)}</span>
    </figure>`
  }
  return `<figure class="body-image">
    <img src="${sourceUrl}" alt="${escapeHtml(item.alt)}">
    <figcaption>${escapeHtml(item.alt)}</figcaption>
  </figure>`
}

function renderCode(item) {
  const language = item.language ? escapeHtml(item.language) : 'text'
  return `<figure class="code-block">
    <figcaption>${language}</figcaption>
    <pre><code>${escapeHtml(item.code)}</code></pre>
  </figure>`
}

function renderStandaloneItem(item, localAssets) {
  if (item._type === 'image') return renderImage(item, localAssets)
  if (item._type === 'code') return renderCode(item)
  const content = renderSpans(item)
  if (item.style === 'h2') return `<h2>${content}</h2>`
  if (item.style === 'h3') return `<h3>${content}</h3>`
  if (item.style === 'blockquote') return `<blockquote>${content}</blockquote>`
  return `<p>${content}</p>`
}

function renderPortableText(items, localAssets) {
  const output = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item._type !== 'block' || !item.listItem) {
      output.push(renderStandaloneItem(item, localAssets))
      index += 1
      continue
    }

    const listItem = item.listItem
    const tag = listItem === 'number' ? 'ol' : 'ul'
    const entries = []
    while (
      index < items.length &&
      items[index]._type === 'block' &&
      items[index].listItem === listItem
    ) {
      const current = items[index]
      const level = current.level ?? 1
      entries.push(
        `<li class="list-level-${level}">${renderSpans(current)}</li>`,
      )
      index += 1
    }
    output.push(`<${tag}>${entries.join('')}</${tag}>`)
  }
  return output.join('\n')
}

function renderCover(article, localAssets) {
  const sourceUrl = localAssetUrl(article.coverImage.source, localAssets)
  const alt = `${article.coverImage.alt.en} / ${article.coverImage.alt.zh}`
  if (!sourceUrl) {
    return `<div class="cover-placeholder" role="img" aria-label="${escapeHtml(alt)}">
      <span>Remote cover image</span>
      <strong>${escapeHtml(article.title.en)}</strong>
    </div>`
  }
  return `<img class="cover" src="${sourceUrl}" alt="${escapeHtml(alt)}">`
}

function renderLocale(article, locale, label, localAssets) {
  const title = article.title[locale]
  const excerpt = article.excerpt[locale]
  return `<article class="article" id="${locale}" lang="${locale}">
    <header class="article-header">
      <span class="language-label">${escapeHtml(label)}</span>
      <h1>${escapeHtml(title)}</h1>
      <p class="excerpt">${escapeHtml(excerpt)}</p>
    </header>
    <div class="prose">${renderPortableText(article.body[locale], localAssets)}</div>
    <aside class="seo-card" aria-label="SEO preview">
      <span>SEO preview</span>
      <strong>${escapeHtml(article.seo.title[locale])}</strong>
      <p>${escapeHtml(article.seo.description[locale])}</p>
    </aside>
  </article>`
}

function countRemoteImages(article) {
  let count = 'assetRef' in article.coverImage.source ? 1 : 0
  for (const locale of ['en', 'zh']) {
    for (const item of article.body[locale]) {
      if (item._type === 'image' && 'assetRef' in item.source) count += 1
    }
  }
  return count
}

function renderHtml(article, markdownSource, previewRevision, localAssets) {
  const published = article.publishedAt
    ? `<span>Published timestamp: ${escapeHtml(article.publishedAt)}</span>`
    : '<span>Draft without a fixed publication timestamp</span>'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">
  <title>${escapeHtml(article.title.en)} — local preview</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f1ea; --paper: #fffdf8; --ink: #17201d; --muted: #66706c; --line: #d9d3c8; --accent: #0f766e; --soft: #dff4ef; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.7; }
    a { color: var(--accent); text-underline-offset: .18em; }
    .shell { width: min(1120px, calc(100% - 32px)); margin: 28px auto 72px; }
    .preview-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--paper) 88%, transparent); font-size: 14px; color: var(--muted); }
    .preview-bar strong { color: var(--ink); }
    .preview-bar nav { display: flex; gap: 8px; }
    .preview-bar a { padding: 5px 10px; border-radius: 999px; background: var(--soft); text-decoration: none; font-weight: 700; }
    .hero { overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 20px 55px rgba(28, 40, 35, .09); }
    .cover, .cover-placeholder { display: block; width: 100%; aspect-ratio: 1200 / 630; object-fit: cover; background: linear-gradient(135deg, #0f766e, #34d399); }
    .cover-placeholder { display: grid; place-content: center; gap: 8px; padding: 32px; color: white; text-align: center; }
    .cover-placeholder span { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
    .cover-placeholder strong { font-size: clamp(24px, 5vw, 58px); line-height: 1.08; }
    .hero-meta { padding: 18px 24px; display: flex; flex-wrap: wrap; gap: 10px 18px; color: var(--muted); font-size: 14px; }
    .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; align-items: start; }
    .article { min-width: 0; padding: clamp(24px, 4vw, 54px); border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 18px 44px rgba(28, 40, 35, .07); }
    .language-label { display: inline-block; margin-bottom: 14px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(36px, 5vw, 62px); line-height: 1.03; letter-spacing: -.035em; }
    .excerpt { margin: 22px 0 0; color: var(--muted); font-size: 19px; line-height: 1.55; }
    .prose { margin-top: 38px; font-family: Georgia, "Times New Roman", serif; font-size: 18px; }
    .prose h2 { margin: 2.2em 0 .7em; font-size: 30px; line-height: 1.2; }
    .prose h3 { margin: 1.8em 0 .6em; font-size: 23px; line-height: 1.3; }
    .prose p { margin: 1.15em 0; }
    .prose blockquote { margin: 1.6em 0; padding: 8px 0 8px 22px; border-left: 4px solid var(--accent); color: var(--muted); font-style: italic; }
    .prose code { padding: .12em .35em; border-radius: 5px; background: color-mix(in srgb, var(--soft) 72%, transparent); font-family: "SFMono-Regular", Consolas, monospace; font-size: .88em; }
    .prose ul, .prose ol { padding-left: 1.45em; }
    .list-level-2 { margin-left: 1.2em; }
    .list-level-3 { margin-left: 2.4em; }
    .body-image { margin: 30px 0; }
    .body-image img { display: block; width: 100%; height: auto; border-radius: 14px; }
    figcaption { margin-top: 8px; color: var(--muted); font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder { min-height: 220px; display: grid; place-content: center; gap: 8px; padding: 26px; border: 1px dashed var(--line); border-radius: 16px; background: color-mix(in srgb, var(--soft) 38%, var(--paper)); text-align: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder__icon { color: var(--accent); font-size: 42px; }
    .code-block { margin: 28px 0; overflow: hidden; border-radius: 14px; background: #111827; color: #e5e7eb; }
    .code-block figcaption { margin: 0; padding: 9px 14px; background: #1f2937; color: #9ca3af; }
    .code-block pre { margin: 0; padding: 18px; overflow: auto; }
    .code-block code { padding: 0; background: none; color: inherit; }
    .seo-card { margin-top: 46px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--soft) 46%, var(--paper)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .seo-card span { display: block; margin-bottom: 8px; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .seo-card strong { display: block; color: #1558d6; font-size: 18px; line-height: 1.35; }
    .seo-card p { margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .markdown-card { margin-top: 18px; padding: clamp(22px, 4vw, 44px); border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 18px 44px rgba(28, 40, 35, .07); }
    .markdown-card summary { cursor: pointer; color: var(--ink); font-size: 21px; font-weight: 800; }
    .markdown-note { margin-top: 12px; padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--soft) 52%, var(--paper)); color: var(--muted); font-size: 14px; }
    .markdown-prose { width: min(760px, 100%); margin: 34px auto 0; }
    .unsafe-link { text-decoration: line-through; text-decoration-color: #dc2626; cursor: not-allowed; }
    footer { margin-top: 18px; color: var(--muted); text-align: center; font-size: 13px; }
    @media (max-width: 840px) { .columns { grid-template-columns: 1fr; } .article { padding: 28px 22px; } h1 { font-size: 42px; } }
    @media (prefers-color-scheme: dark) { :root { --bg: #101512; --paper: #171d1a; --ink: #edf4ef; --muted: #a3ada7; --line: #344039; --accent: #5eead4; --soft: #183d36; } .hero, .article { box-shadow: none; } .seo-card strong { color: #8ab4ff; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="preview-bar">
      <span><strong>Local draft preview</strong> · approximate production appearance</span>
      <nav aria-label="Languages"><a href="#en">English</a><a href="#zh">中文</a></nav>
    </div>
    <section class="hero">
      ${renderCover(article, localAssets)}
      <div class="hero-meta"><span>/${escapeHtml(article.slug)}</span>${published}<span>Source: validated article JSON</span><span>Preview revision: ${escapeHtml(previewRevision.slice(0, 12))}</span></div>
    </section>
    <section class="columns">
      ${renderLocale(article, 'en', 'English', localAssets)}
      ${renderLocale(article, 'zh', '中文', localAssets)}
    </section>
    <details class="markdown-card" open>
      <summary>Markdown visual preview</summary>
      <div class="markdown-note">This pane safely renders the sibling Markdown source. Compare it with the JSON payload preview above before publishing.</div>
      <div class="prose markdown-prose">${renderMarkdown(markdownSource)}</div>
    </details>
    <footer>The upper panes render the validated JSON payload; the expandable lower pane renders the sibling Markdown source. Final site typography and components may differ.</footer>
  </main>
</body>
</html>
`
}

async function assertReplaceablePreview(previewPath) {
  try {
    const info = await lstat(previewPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      fail(
        'PREVIEW_PATH_UNSAFE',
        'The preview target exists but is not an ordinary file.',
      )
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return
    if (error instanceof PreviewError) throw error
    fail('PREVIEW_WRITE_FAILED', 'Unable to inspect the local preview target.')
  }
}

async function writePreview(previewPath, source) {
  const bytes = Buffer.byteLength(source)
  if (bytes <= 0 || bytes > MAX_PREVIEW_BYTES) {
    fail('PREVIEW_SIZE_INVALID', 'The generated preview exceeds the 32 MiB limit.')
  }
  await assertReplaceablePreview(previewPath)

  const temporaryPath = path.join(
    path.dirname(previewPath),
    `.${path.basename(previewPath)}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(temporaryPath, 'wx', FILE_MODE)
    await handle.writeFile(source, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, previewPath)
    try {
      await chmod(previewPath, FILE_MODE)
    } catch {
      if (process.platform !== 'win32') {
        fail('PREVIEW_WRITE_FAILED', 'Unable to restrict the local preview file permissions.')
      }
    }
  } catch (error) {
    if (error instanceof PreviewError) throw error
    fail('PREVIEW_WRITE_FAILED', 'Unable to write the local HTML preview.')
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporaryPath, {force: true}).catch(() => {})
  }
}

export async function renderArticlePreview(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !snapshot.article ||
    typeof snapshot.articlePath !== 'string' ||
    typeof snapshot.slug !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.contentSha256)
  ) {
    fail('PREVIEW_SNAPSHOT_INVALID', 'The validated article snapshot is invalid.')
  }

  const {
    markdownPath,
    source: markdownSource,
    sha256: markdownSha256,
  } = await inspectMarkdown(
    snapshot.articlePath,
    snapshot.slug,
  )
  const previewPath = path.join(
    path.dirname(snapshot.articlePath),
    `${snapshot.slug}.preview.html`,
  )
  const previewRevision = createHash('sha256')
    .update('content\0')
    .update(snapshot.contentSha256)
    .update('\0markdown\0')
    .update(markdownSha256)
    .digest('hex')
  const localAssets = new Map(
    materializeArticlePreviewAssets(snapshot).map((asset) => [
      asset.sourcePath,
      `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`,
    ]),
  )
  const source = renderHtml(
    snapshot.article,
    markdownSource,
    previewRevision,
    localAssets,
  )
  await writePreview(previewPath, source)

  const remoteImageCount = countRemoteImages(snapshot.article)
  const warnings = [
    'This is an approximate local preview; the production site theme and components may differ.',
    'The preview shows both the validated article JSON payload and a safe rendering of the sibling Markdown; publishing uses the JSON payload.',
  ]
  if (remoteImageCount > 0) {
    warnings.push(
      `${remoteImageCount} remote Sanity image${remoteImageCount === 1 ? ' is' : 's are'} shown as a placeholder.`,
    )
  }

  const coverPath = localAssetPath(snapshot.articlePath, snapshot.article.coverImage.source)
  return {
    ok: true,
    approximate: true,
    source: 'article-json',
    markdownRendered: true,
    previewRevision,
    slug: snapshot.slug,
    articlePath: snapshot.articlePath,
    markdownPath,
    ...(coverPath ? {coverPath} : {}),
    previewPath,
    previewUrl: pathToFileURL(previewPath).href,
    locales: ['en', 'zh'],
    warnings,
  }
}
