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

import {materializeContentPreviewAssets} from './content-article.mjs'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BYTES = 384 * 1024 * 1024
const FILE_MODE = 0o600
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export class ContentPreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContentPreviewError'
    this.category = 'preview'
    this.code = code
    this.retryable = false
    this.resultUnknown = false
  }
}

function fail(code, message) {
  throw new ContentPreviewError(code, message)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeLinkHref(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith('//') ||
    value.startsWith('\\\\')
  ) {
    return false
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value)
  if (!scheme) return true
  const protocol = scheme[1].toLowerCase()
  if (!['http', 'https', 'mailto', 'tel'].includes(protocol)) return false
  if (protocol === 'mailto' || protocol === 'tel') {
    return value.slice(scheme[0].length).trim().length > 0
  }
  try {
    const url = new URL(value)
    return url.protocol === `${protocol}:` && Boolean(url.hostname)
  } catch {
    return false
  }
}

function safeExternalVideoHref(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function localized(value, locale, fallback = '') {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return fallback
  if (typeof value[locale] === 'string') return value[locale]
  if (typeof value.en === 'string') return value.en
  if (typeof value.zh === 'string') return value.zh
  return fallback
}

function localizedKeywords(value, locale) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (!value || typeof value !== 'object') return []
  return Array.isArray(value[locale])
    ? value[locale].filter((item) => typeof item === 'string')
    : []
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
      'CONTENT_PREVIEW_MARKDOWN_INVALID',
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
      'CONTENT_PREVIEW_MARKDOWN_INVALID',
      'The sibling Markdown source must be a regular non-empty file no larger than 2 MiB.',
    )
  }

  let handle
  let bytes
  let source
  try {
    handle = await open(markdownPath, 'r')
    const before = await handle.stat({bigint: true})
    if (!before.isFile() || !sameFileSnapshot(pathInfo, before)) {
      fail(
        'CONTENT_PREVIEW_MARKDOWN_CHANGED',
        'The Markdown source changed while it was inspected.',
      )
    }
    bytes = await handle.readFile()
    const after = await handle.stat({bigint: true})
    if (
      !sameFileSnapshot(before, after) ||
      bytes.length !== Number(before.size) ||
      bytes.length > MAX_MARKDOWN_BYTES
    ) {
      fail(
        'CONTENT_PREVIEW_MARKDOWN_CHANGED',
        'The Markdown source changed while it was inspected.',
      )
    }
    try {
      source = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    } catch {
      fail(
        'CONTENT_PREVIEW_MARKDOWN_INVALID',
        'The sibling Markdown source must be valid UTF-8 text.',
      )
    }
    if (source.trim().length === 0) {
      fail(
        'CONTENT_PREVIEW_MARKDOWN_INVALID',
        'The sibling Markdown source must not be blank.',
      )
    }
  } finally {
    await handle?.close().catch(() => {})
  }

  return {
    bytes: Buffer.from(bytes),
    markdownPath,
    source,
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
    if (paragraph.length === 0) return
    output.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  function flushList() {
    if (!list) return
    output.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`)
    list = undefined
  }

  function flushQuote() {
    if (quote.length === 0) return
    output.push(`<blockquote>${renderMarkdownInline(quote.join(' '))}</blockquote>`)
    quote = []
  }

  function flushFlow() {
    flushParagraph()
    flushList()
    flushQuote()
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = /^```([A-Za-z0-9_+-]{0,64})\s*$/u.exec(line.trim())
    if (fence) {
      flushFlow()
      const code = []
      index += 1
      while (index < lines.length && lines[index].trim() !== '```') {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      output.push(
        `<figure class="code-block"><figcaption>${escapeHtml(fence[1] || 'text')}</figcaption><pre><code>${escapeHtml(code.join('\n'))}</code></pre></figure>`,
      )
      continue
    }

    if (line.trim().length === 0) {
      flushFlow()
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      flushFlow()
      const level = Math.min(6, Math.max(2, heading[1].length))
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
      const indentation = listItem[1].replaceAll('\t', '  ').length
      const level = Math.min(10, Math.floor(indentation / 2) + 1)
      list.items.push(
        `<li class="list-level-${level}">${renderMarkdownInline(listItem[4])}</li>`,
      )
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

function sourcePath(source) {
  return source && typeof source === 'object' && typeof source.path === 'string'
    ? source.path
    : undefined
}

function sourceReference(source) {
  if (!source || typeof source !== 'object') return 'Unspecified asset'
  if (typeof source.assetRef === 'string') return source.assetRef
  if (typeof source.path === 'string') return path.basename(source.path)
  return 'Unspecified asset'
}

function inspectPreviewAssets(snapshot) {
  let materialized
  try {
    materialized = materializeContentPreviewAssets(snapshot)
  } catch (error) {
    if (error?.code === 'CONTENT_SNAPSHOT_INVALID') throw error
    fail(
      'CONTENT_PREVIEW_ASSETS_INVALID',
      'The validated content assets could not be materialized.',
    )
  }
  if (!Array.isArray(materialized)) {
    fail(
      'CONTENT_PREVIEW_ASSETS_INVALID',
      'The validated content assets are unavailable.',
    )
  }

  const assets = []
  const keys = new Set()
  for (const candidate of materialized) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !['image', 'video', 'attachment'].includes(candidate.kind) ||
      typeof candidate.sourcePath !== 'string' ||
      typeof candidate.filename !== 'string' ||
      typeof candidate.mimeType !== 'string' ||
      !Buffer.isBuffer(candidate.bytes) ||
      !SHA256_PATTERN.test(candidate.sha256)
    ) {
      fail(
        'CONTENT_PREVIEW_ASSETS_INVALID',
        'A validated content asset has invalid preview metadata.',
      )
    }
    const sha256 = createHash('sha256').update(candidate.bytes).digest('hex')
    if (
      sha256 !== candidate.sha256 ||
      candidate.size !== candidate.bytes.length ||
      keys.has(candidate.sourcePath)
    ) {
      fail(
        'CONTENT_PREVIEW_ASSETS_INVALID',
        'A validated content asset changed before preview rendering.',
      )
    }
    keys.add(candidate.sourcePath)
    assets.push({
      kind: candidate.kind,
      sourcePath: candidate.sourcePath,
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      size: candidate.bytes.length,
      sha256,
      bytes: Buffer.from(candidate.bytes),
    })
  }
  return assets.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.kind.localeCompare(right.kind),
  )
}

function previewRevision(snapshot, markdownBytes, assets) {
  const hash = createHash('sha256')

  function bind(label, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    hash.update(`${label}\0${bytes.length}\0`, 'utf8')
    hash.update(bytes)
    hash.update('\0', 'utf8')
  }

  bind('content-preview-version', '1')
  bind('content-type', snapshot.contentType)
  bind('exact-content-sha256', snapshot.contentSha256)
  bind('normalized-article-json', JSON.stringify(snapshot.article))
  bind('markdown', markdownBytes)
  for (const asset of assets) {
    bind('asset-kind', asset.kind)
    bind('asset-source-path', asset.sourcePath)
    bind('asset-filename', asset.filename)
    bind('asset-mime-type', asset.mimeType)
    bind('asset-bytes', asset.bytes)
  }
  return hash.digest('hex')
}

function assetContext(assets) {
  const byPath = new Map(assets.map((asset) => [asset.sourcePath, asset]))
  const counts = {
    externalVideos: 0,
    localAttachments: 0,
    localVideos: 0,
    remoteImages: 0,
    remoteMedia: 0,
  }
  return {assets, byPath, counts}
}

function estimatePreviewBytes(article, markdownBytes, assets) {
  const byPath = new Map(assets.map((asset) => [asset.sourcePath, asset]))
  const imageSources = []
  if (article.coverImage?.source) imageSources.push(article.coverImage.source)
  if (article.seo?.openGraph?.image?.source) {
    // The localized SEO card renders once in each language column.
    imageSources.push(
      article.seo.openGraph.image.source,
      article.seo.openGraph.image.source,
    )
  }
  for (const locale of ['en', 'zh']) {
    for (const item of article.body[locale]) {
      if (item._type === 'image') imageSources.push(item.source)
      if (item._type === 'video' && item.poster?.source) {
        imageSources.push(item.poster.source)
      }
    }
  }

  let embeddedImageBytes = 0
  for (const source of imageSources) {
    const localPath = sourcePath(source)
    const asset = localPath ? byPath.get(localPath) : undefined
    if (!asset || asset.kind !== 'image') continue
    embeddedImageBytes +=
      `data:${asset.mimeType};base64,`.length +
      Math.ceil(asset.bytes.length / 3) * 4
  }
  const normalizedArticleBytes = Buffer.byteLength(JSON.stringify(article))
  return (
    embeddedImageBytes +
    normalizedArticleBytes * 6 +
    markdownBytes.length * 6 +
    256 * 1024
  )
}

function imageDataUrl(source, context) {
  const localPath = sourcePath(source)
  if (!localPath) return undefined
  const asset = context.byPath.get(localPath)
  if (
    !asset ||
    asset.kind !== 'image' ||
    !SAFE_IMAGE_MIME_TYPES.has(asset.mimeType)
  ) {
    return undefined
  }
  return `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`
}

function renderSpans(block) {
  const definitions = new Map(
    (block.markDefs ?? [])
      .filter((definition) => definition?._key)
      .map((definition) => [definition._key, definition]),
  )
  return (block.children ?? [])
    .map((child) => {
      let rendered = escapeHtml(child?.text)
      for (const mark of child?.marks ?? []) {
        if (mark === 'strong') {
          rendered = `<strong>${rendered}</strong>`
        } else if (mark === 'em') {
          rendered = `<em>${rendered}</em>`
        } else if (mark === 'underline') {
          rendered = `<u>${rendered}</u>`
        } else if (mark === 'strike-through') {
          rendered = `<s>${rendered}</s>`
        } else if (mark === 'code') {
          rendered = `<code>${rendered}</code>`
        } else {
          const definition = definitions.get(mark)
          if (definition?._type !== 'link') continue
          if (safeLinkHref(definition.href)) {
            rendered = `<a href="${escapeHtml(definition.href)}" target="_blank" rel="noopener noreferrer">${rendered}</a>`
          } else {
            rendered = `<span class="unsafe-link" title="Unsupported link omitted">${rendered}</span>`
          }
        }
      }
      return rendered
    })
    .join('')
}

function renderBlock(block) {
  const content = renderSpans(block)
  if (/^h[2-6]$/u.test(block.style)) {
    return `<${block.style}>${content}</${block.style}>`
  }
  if (block.style === 'blockquote') return `<blockquote>${content}</blockquote>`
  return `<p>${content}</p>`
}

function renderBasicBlocks(blocks) {
  return (blocks ?? []).map((block) => renderBlock(block)).join('')
}

function renderImage(item, locale, context, className = 'body-image') {
  const alt = localized(item.alt, locale, 'Image')
  const caption = localized(item.caption, locale)
  const dataUrl = imageDataUrl(item.source, context)
  if (!dataUrl) {
    context.counts.remoteImages += 1
    return `<figure class="asset-placeholder ${className}" role="img" aria-label="${escapeHtml(alt)}">
      <div class="asset-placeholder__icon" aria-hidden="true">◇</div>
      <strong>Remote image placeholder</strong>
      <span>${escapeHtml(alt)}</span>
      ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}
    </figure>`
  }
  return `<figure class="${className}">
    <img src="${dataUrl}" alt="${escapeHtml(alt)}">
    ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}
  </figure>`
}

function renderCode(item) {
  return `<figure class="code-block">
    <figcaption>${escapeHtml(item.language || 'javascript')}</figcaption>
    <pre><code>${escapeHtml(item.code)}</code></pre>
  </figure>`
}

function renderPoster(poster, locale, context) {
  if (!poster) return ''
  const dataUrl = imageDataUrl(poster.source ?? poster, context)
  const alt = localized(poster.alt, locale, 'Video poster')
  if (dataUrl) {
    return `<img class="media-poster" src="${dataUrl}" alt="${escapeHtml(alt)}">`
  }
  context.counts.remoteImages += 1
  return `<div class="media-poster media-poster--placeholder" role="img" aria-label="${escapeHtml(alt)}">Remote poster image</div>`
}

function renderVideo(item, locale, context) {
  const title = localized(item.title, locale, 'Video')
  const caption = localized(item.caption, locale)
  const poster = renderPoster(item.poster, locale, context)
  if (item.sourceType === 'external') {
    context.counts.externalVideos += 1
    const link = safeExternalVideoHref(item.url)
      ? `<a class="media-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open external video</a>`
      : '<span class="unsafe-link">External video URL omitted</span>'
    return `<figure class="media-card media-card--video">
      ${poster}
      <div class="media-card__body">
        <span class="eyebrow">External video · safe link only</span>
        <strong>${escapeHtml(title)}</strong>
        ${caption ? `<p>${escapeHtml(caption)}</p>` : ''}
        ${link}
      </div>
    </figure>`
  }

  const localPath = sourcePath(item.source)
  const asset = localPath ? context.byPath.get(localPath) : undefined
  if (asset) context.counts.localVideos += 1
  else context.counts.remoteMedia += 1
  return `<figure class="media-card media-card--video">
    ${poster}
    <div class="media-card__body">
      <span class="eyebrow">Uploaded video · metadata only</span>
      <strong>${escapeHtml(title)}</strong>
      ${caption ? `<p>${escapeHtml(caption)}</p>` : ''}
      <dl class="asset-meta">
        <div><dt>Asset</dt><dd>${escapeHtml(asset?.filename ?? sourceReference(item.source))}</dd></div>
        ${asset ? `<div><dt>Type</dt><dd>${escapeHtml(asset.mimeType)}</dd></div><div><dt>Size</dt><dd>${escapeHtml(formatBytes(asset.size))}</dd></div>` : ''}
      </dl>
    </div>
  </figure>`
}

function renderAttachment(item, locale, context) {
  const title = localized(item.title, locale, 'Attachment')
  const localPath = sourcePath(item.source)
  const asset = localPath ? context.byPath.get(localPath) : undefined
  if (asset) context.counts.localAttachments += 1
  else context.counts.remoteMedia += 1
  return `<aside class="media-card media-card--attachment">
    <div class="attachment-icon" aria-hidden="true">DOC</div>
    <div class="media-card__body">
      <span class="eyebrow">Attachment · metadata only</span>
      <strong>${escapeHtml(title)}</strong>
      <dl class="asset-meta">
        <div><dt>Asset</dt><dd>${escapeHtml(asset?.filename ?? sourceReference(item.source))}</dd></div>
        ${asset ? `<div><dt>Type</dt><dd>${escapeHtml(asset.mimeType)}</dd></div><div><dt>Size</dt><dd>${escapeHtml(formatBytes(asset.size))}</dd></div>` : ''}
      </dl>
    </div>
  </aside>`
}

function renderCallout(item, locale) {
  const tones = new Set(['info', 'success', 'warning', 'error'])
  const tone = tones.has(item.tone) ? item.tone : 'info'
  const title = localized(item.title, locale)
  return `<aside class="callout callout--${tone}">
    <span class="eyebrow">${escapeHtml(tone)} callout</span>
    ${title ? `<strong>${escapeHtml(title)}</strong>` : ''}
    <div class="callout__body">${renderBasicBlocks(item.body)}</div>
  </aside>`
}

function renderTable(item) {
  const rows = Array.isArray(item.rows) ? item.rows : []
  const headerRows = Math.max(0, Math.min(rows.length, Number(item.headerRows) || 0))

  function renderRows(selected, cellTag) {
    return selected
      .map(
        (row) => `<tr>${(row.cells ?? [])
          .map((cell) => `<${cellTag}>${renderBasicBlocks(cell.value)}</${cellTag}>`)
          .join('')}</tr>`,
      )
      .join('')
  }

  return `<div class="table-scroll" role="region" aria-label="Content table" tabindex="0">
    <table>
      ${headerRows > 0 ? `<thead>${renderRows(rows.slice(0, headerRows), 'th')}</thead>` : ''}
      <tbody>${renderRows(rows.slice(headerRows), 'td')}</tbody>
    </table>
  </div>`
}

function renderStandaloneItem(item, locale, context) {
  if (item._type === 'block') return renderBlock(item)
  if (item._type === 'image') return renderImage(item, locale, context)
  if (item._type === 'code') return renderCode(item)
  if (item._type === 'video') return renderVideo(item, locale, context)
  if (item._type === 'attachment') return renderAttachment(item, locale, context)
  if (item._type === 'callout') return renderCallout(item, locale)
  if (item._type === 'table') return renderTable(item)
  return '<aside class="asset-placeholder">Unsupported content item omitted.</aside>'
}

function renderRichBody(items, locale, context) {
  const output = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item._type !== 'block' || !item.listItem) {
      output.push(renderStandaloneItem(item, locale, context))
      index += 1
      continue
    }

    const tag = item.listItem === 'number' ? 'ol' : 'ul'
    const entries = []
    while (
      index < items.length &&
      items[index]._type === 'block' &&
      items[index].listItem === item.listItem
    ) {
      const current = items[index]
      const level = Math.min(10, Math.max(1, Number(current.level) || 1))
      entries.push(
        `<li class="list-level-${level}">${renderSpans(current)}</li>`,
      )
      index += 1
    }
    output.push(`<${tag}>${entries.join('')}</${tag}>`)
  }
  return output.join('\n')
}

function renderCover(article, context) {
  if (!article.coverImage) {
    return `<div class="cover-placeholder">
      <span>Optional cover not supplied</span>
      <strong>${escapeHtml(localized(article.title, 'en', article.slug))}</strong>
    </div>`
  }
  const dataUrl = imageDataUrl(article.coverImage.source, context)
  const alt = [
    localized(article.coverImage.alt, 'en', 'Cover image'),
    localized(article.coverImage.alt, 'zh'),
  ].filter(Boolean).join(' / ')
  if (!dataUrl) {
    context.counts.remoteImages += 1
    return `<div class="cover-placeholder" role="img" aria-label="${escapeHtml(alt)}">
      <span>Remote cover image placeholder</span>
      <strong>${escapeHtml(localized(article.title, 'en', article.slug))}</strong>
    </div>`
  }
  return `<img class="cover" src="${dataUrl}" alt="${escapeHtml(alt)}">`
}

function renderSeoImage(openGraph, locale, context) {
  if (!openGraph?.image) return ''
  return `<div class="seo-og-image">
    <span>Open Graph image</span>
    ${renderImage(openGraph.image, locale, context, 'seo-image')}
  </div>`
}

function renderRobots(robots) {
  if (!robots) return 'Not specified'
  if (typeof robots === 'string') return robots
  if (Array.isArray(robots)) return robots.join(', ')
  if (typeof robots === 'object') {
    return Object.entries(robots)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(' · ')
  }
  return String(robots)
}

function renderSeo(article, locale, context) {
  if (!article.seo) {
    return `<aside class="seo-card">
      <span class="eyebrow">SEO metadata</span>
      <strong>Optional SEO metadata not supplied</strong>
    </aside>`
  }
  const seo = article.seo
  const title = localized(seo.title, locale)
  const description = localized(seo.description, locale)
  const keywords = localizedKeywords(seo.keywords, locale)
  const canonical = localized(seo.canonicalUrl, locale)
  const openGraph = seo.openGraph
  const ogTitle = localized(openGraph?.title, locale, title)
  const ogDescription = localized(openGraph?.description, locale, description)
  return `<aside class="seo-card" aria-label="Full SEO preview">
    <span class="eyebrow">Full SEO preview</span>
    <section>
      <h3>Search result</h3>
      <strong class="search-title">${escapeHtml(title || 'No localized SEO title')}</strong>
      ${canonical ? `<div class="canonical">${escapeHtml(canonical)}</div>` : ''}
      <p>${escapeHtml(description || 'No localized SEO description')}</p>
    </section>
    <dl class="seo-fields">
      <div><dt>Keywords</dt><dd>${keywords.length > 0 ? keywords.map(escapeHtml).join(', ') : 'Not specified'}</dd></div>
      <div><dt>Canonical URL</dt><dd>${canonical ? escapeHtml(canonical) : 'Not specified'}</dd></div>
      <div><dt>Robots</dt><dd>${escapeHtml(renderRobots(seo.robots))}</dd></div>
      <div><dt>Open Graph title</dt><dd>${escapeHtml(ogTitle || 'Not specified')}</dd></div>
      <div><dt>Open Graph description</dt><dd>${escapeHtml(ogDescription || 'Not specified')}</dd></div>
    </dl>
    ${renderSeoImage(openGraph, locale, context)}
  </aside>`
}

function renderLocale(article, locale, label, context) {
  const title = localized(article.title, locale, article.slug)
  const excerpt = localized(article.excerpt, locale)
  return `<article class="article" id="${locale}" lang="${locale === 'zh' ? 'zh-Hans' : 'en'}">
    <header class="article-header">
      <span class="language-label">${escapeHtml(label)}</span>
      <h1>${escapeHtml(title)}</h1>
      <p class="excerpt">${escapeHtml(excerpt)}</p>
    </header>
    <div class="prose">${renderRichBody(article.body[locale], locale, context)}</div>
    ${renderSeo(article, locale, context)}
  </article>`
}

function renderHtml(snapshot, markdownSource, revision, context) {
  const article = snapshot.article
  const published = article.publishedAt
    ? `<span>Published timestamp: ${escapeHtml(article.publishedAt)}</span>`
    : '<span>Draft without a fixed publication timestamp</span>'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; media-src 'none'">
  <title>${escapeHtml(localized(article.title, 'en', article.slug))} — local preview</title>
  <style>
    :root { color-scheme: light dark; --bg: #f3f1eb; --paper: #fffdf8; --ink: #18201e; --muted: #65706b; --line: #d9d4ca; --accent: #0f766e; --soft: #dff4ef; --info: #2563eb; --success: #15803d; --warning: #b45309; --error: #b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
    a { color: var(--accent); text-underline-offset: .18em; }
    .shell { width: min(1440px, calc(100% - 32px)); margin: 28px auto 72px; }
    .preview-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 20px; margin-bottom: 16px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--paper); color: var(--muted); font-size: 14px; }
    .preview-bar strong { color: var(--ink); }
    .preview-bar nav { display: flex; gap: 8px; }
    .preview-bar a { padding: 5px 10px; border-radius: 999px; background: var(--soft); font-weight: 700; text-decoration: none; }
    .hero { overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 20px 55px rgba(28, 40, 35, .09); }
    .cover, .cover-placeholder { display: block; width: 100%; aspect-ratio: 1200 / 630; object-fit: cover; background: linear-gradient(135deg, #0f766e, #34d399); }
    .cover-placeholder { display: grid; place-content: center; gap: 8px; padding: 32px; color: white; text-align: center; }
    .cover-placeholder span, .eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .cover-placeholder strong { font-size: clamp(24px, 5vw, 58px); line-height: 1.08; }
    .hero-meta { display: flex; flex-wrap: wrap; gap: 10px 18px; padding: 18px 24px; color: var(--muted); font-size: 14px; }
    .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; align-items: start; }
    .article, .markdown-card { min-width: 0; padding: clamp(24px, 4vw, 54px); border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 18px 44px rgba(28, 40, 35, .07); }
    .language-label { display: inline-block; margin-bottom: 14px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font: clamp(36px, 5vw, 62px)/1.03 Georgia, "Times New Roman", serif; letter-spacing: -.035em; }
    .excerpt { margin: 22px 0 0; color: var(--muted); font-size: 19px; line-height: 1.55; }
    .prose { margin-top: 38px; font: 18px/1.75 Georgia, "Times New Roman", serif; }
    .prose h2 { margin: 2.2em 0 .7em; font-size: 30px; line-height: 1.2; }
    .prose h3 { margin: 2em 0 .65em; font-size: 26px; line-height: 1.25; }
    .prose h4 { margin: 1.8em 0 .6em; font-size: 22px; line-height: 1.3; }
    .prose h5 { margin: 1.7em 0 .55em; font-size: 19px; line-height: 1.35; }
    .prose h6 { margin: 1.6em 0 .5em; font-size: 17px; line-height: 1.4; text-transform: uppercase; letter-spacing: .06em; }
    .prose p { margin: 1.05em 0; }
    .prose blockquote { margin: 1.6em 0; padding: 8px 0 8px 22px; border-left: 4px solid var(--accent); color: var(--muted); font-style: italic; }
    .prose code { padding: .12em .35em; border-radius: 5px; background: var(--soft); font-family: "SFMono-Regular", Consolas, monospace; font-size: .88em; }
    .prose ul, .prose ol { padding-left: 1.45em; }
    .list-level-2 { margin-left: 1.2em; } .list-level-3 { margin-left: 2.4em; } .list-level-4 { margin-left: 3.6em; }
    figure { margin: 30px 0; }
    .body-image img, .seo-image img, .media-poster { display: block; width: 100%; height: auto; border-radius: 14px; }
    figcaption { margin-top: 8px; color: var(--muted); font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder { min-height: 180px; display: grid; place-content: center; gap: 8px; padding: 24px; border: 1px dashed var(--line); border-radius: 16px; background: color-mix(in srgb, var(--soft) 38%, var(--paper)); text-align: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder__icon { color: var(--accent); font-size: 38px; }
    .code-block { overflow: hidden; border-radius: 14px; background: #111827; color: #e5e7eb; }
    .code-block figcaption { margin: 0; padding: 9px 14px; background: #1f2937; color: #9ca3af; }
    .code-block pre { margin: 0; padding: 18px; overflow: auto; }
    .code-block code { padding: 0; background: none; color: inherit; }
    .media-card { display: grid; grid-template-columns: minmax(92px, 160px) 1fr; gap: 18px; align-items: center; margin: 26px 0; padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in srgb, var(--soft) 36%, var(--paper)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .media-card:not(:has(.media-poster)) { grid-template-columns: 1fr; }
    .media-card__body { min-width: 0; }
    .media-card__body > strong { display: block; margin: 5px 0; font-size: 18px; }
    .media-card__body p { margin: 5px 0 10px; color: var(--muted); }
    .media-poster { aspect-ratio: 16 / 9; object-fit: cover; }
    .media-poster--placeholder { display: grid; place-content: center; padding: 12px; background: var(--line); color: var(--muted); font-size: 12px; text-align: center; }
    .attachment-icon { display: grid; width: 70px; height: 70px; place-content: center; border-radius: 14px; background: var(--accent); color: white; font-size: 13px; font-weight: 900; letter-spacing: .12em; }
    .asset-meta, .seo-fields { display: grid; gap: 5px; margin: 10px 0 0; font-size: 12px; }
    .asset-meta div, .seo-fields div { display: grid; grid-template-columns: minmax(70px, .28fr) 1fr; gap: 8px; }
    .asset-meta dt, .seo-fields dt { color: var(--muted); }
    .asset-meta dd, .seo-fields dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .callout { margin: 26px 0; padding: 18px 20px; border: 1px solid currentColor; border-left-width: 5px; border-radius: 14px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .callout--info { color: var(--info); } .callout--success { color: var(--success); } .callout--warning { color: var(--warning); } .callout--error { color: var(--error); }
    .callout > strong { display: block; margin-top: 5px; color: var(--ink); font-size: 18px; }
    .callout__body { color: var(--ink); }
    .table-scroll { margin: 28px 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; }
    table { width: 100%; border-collapse: collapse; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
    th, td { min-width: 130px; padding: 12px 14px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: var(--soft); font-weight: 800; }
    th:last-child, td:last-child { border-right: 0; } tbody tr:last-child td { border-bottom: 0; }
    th p, td p { margin: 0 0 .5em; } th p:last-child, td p:last-child { margin-bottom: 0; }
    .seo-card { margin-top: 46px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--soft) 46%, var(--paper)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .seo-card h3 { margin: 12px 0 5px; font-size: 13px; }
    .search-title { display: block; color: #1558d6; font-size: 18px; line-height: 1.35; }
    .canonical { color: var(--success); font-size: 12px; overflow-wrap: anywhere; }
    .seo-card p { margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .seo-og-image { margin-top: 16px; }
    .seo-og-image > span { color: var(--muted); font-size: 12px; font-weight: 800; }
    .seo-image { min-height: 0; margin: 8px 0 0; }
    .markdown-card { margin-top: 18px; }
    .markdown-card summary { cursor: pointer; font-size: 21px; font-weight: 800; }
    .markdown-note { margin-top: 12px; padding: 12px 14px; border-radius: 12px; background: var(--soft); color: var(--muted); font-size: 14px; }
    .markdown-prose { width: min(780px, 100%); margin: 34px auto 0; }
    .unsafe-link { text-decoration: line-through; text-decoration-color: var(--error); cursor: not-allowed; }
    footer { margin-top: 18px; color: var(--muted); text-align: center; font-size: 13px; }
    @media (max-width: 920px) { .columns { grid-template-columns: 1fr; } .article { padding: 28px 22px; } h1 { font-size: 42px; } }
    @media (max-width: 520px) { .media-card { grid-template-columns: 1fr; } .attachment-icon { width: 56px; height: 56px; } }
    @media (prefers-color-scheme: dark) { :root { --bg: #101512; --paper: #171d1a; --ink: #edf4ef; --muted: #a3ada7; --line: #344039; --accent: #5eead4; --soft: #183d36; --info: #93c5fd; --success: #86efac; --warning: #fcd34d; --error: #fca5a5; } .hero, .article, .markdown-card { box-shadow: none; } .search-title { color: #8ab4ff; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="preview-bar">
      <span><strong>Local ${escapeHtml(snapshot.contentType)} preview</strong> · validated content JSON</span>
      <nav><a href="#en">English</a><a href="#zh">中文</a></nav>
    </div>
    <section class="hero">
      ${renderCover(article, context)}
      <div class="hero-meta">
        <span>Slug: <strong>${escapeHtml(snapshot.slug)}</strong></span>
        <span>Content type: <strong>${escapeHtml(snapshot.contentType)}</strong></span>
        ${published}
        <span>Preview revision: <code>${escapeHtml(revision.slice(0, 16))}</code></span>
      </div>
    </section>
    <section class="columns">
      ${renderLocale(article, 'en', 'English', context)}
      ${renderLocale(article, 'zh', '中文', context)}
    </section>
    <details class="markdown-card" open>
      <summary>Markdown visual preview</summary>
      <div class="markdown-note">This pane safely renders the required sibling Markdown source. Compare it with the validated content JSON panes above; publishing uses JSON.</div>
      <div class="prose markdown-prose">${renderMarkdown(markdownSource)}</div>
    </details>
    <footer>This is an approximate local preview. Production typography, layout, and media components may differ.</footer>
  </main>
</body>
</html>
`
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

async function assertReplaceablePreview(previewPath) {
  try {
    const info = await lstat(previewPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      fail(
        'CONTENT_PREVIEW_PATH_UNSAFE',
        'The preview target exists but is not an ordinary file.',
      )
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return
    if (error instanceof ContentPreviewError) throw error
    fail(
      'CONTENT_PREVIEW_WRITE_FAILED',
      'Unable to inspect the local preview target.',
    )
  }
}

async function writePreview(previewPath, source) {
  const size = Buffer.byteLength(source)
  if (size <= 0 || size > MAX_PREVIEW_BYTES) {
    fail(
      'CONTENT_PREVIEW_SIZE_INVALID',
      'The generated content preview exceeds the 384 MiB limit.',
    )
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
        fail(
          'CONTENT_PREVIEW_WRITE_FAILED',
          'Unable to restrict the local preview file permissions.',
        )
      }
    }
  } catch (error) {
    if (error instanceof ContentPreviewError) throw error
    fail(
      'CONTENT_PREVIEW_WRITE_FAILED',
      'Unable to write the local HTML preview.',
    )
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporaryPath, {force: true}).catch(() => {})
  }
}

function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    typeof snapshot.contentType !== 'string' ||
    snapshot.contentType.trim().length === 0 ||
    snapshot.contentType.length > 128 ||
    typeof snapshot.slug !== 'string' ||
    !SAFE_SLUG.test(snapshot.slug) ||
    typeof snapshot.articlePath !== 'string' ||
    !path.isAbsolute(snapshot.articlePath) ||
    !snapshot.article ||
    typeof snapshot.article !== 'object' ||
    !snapshot.article.body ||
    !Array.isArray(snapshot.article.body.en) ||
    !Array.isArray(snapshot.article.body.zh) ||
    !SHA256_PATTERN.test(snapshot.contentSha256)
  ) {
    fail(
      'CONTENT_PREVIEW_SNAPSHOT_INVALID',
      'The validated content snapshot is invalid.',
    )
  }
}

export async function renderContentPreview(snapshot) {
  validateSnapshot(snapshot)
  const assets = inspectPreviewAssets(snapshot)
  const markdown = await inspectMarkdown(snapshot.articlePath, snapshot.slug)
  if (
    estimatePreviewBytes(snapshot.article, markdown.bytes, assets) >
    MAX_PREVIEW_BYTES
  ) {
    fail(
      'CONTENT_PREVIEW_SIZE_INVALID',
      'The generated content preview would exceed the 384 MiB limit.',
    )
  }
  const revision = previewRevision(snapshot, markdown.bytes, assets)
  const previewPath = path.join(
    path.dirname(path.dirname(snapshot.articlePath)),
    `${snapshot.slug}.preview.html`,
  )
  const context = assetContext(assets)
  const source = renderHtml(snapshot, markdown.source, revision, context)
  await writePreview(previewPath, source)

  const warnings = [
    'This is an approximate local preview; the production site theme and components may differ.',
    'The preview renders validated content JSON and the required sibling Markdown; publishing uses the JSON payload.',
  ]
  if (context.counts.remoteImages > 0) {
    warnings.push(
      `${context.counts.remoteImages} remote image occurrence${context.counts.remoteImages === 1 ? ' is' : 's are'} shown as a placeholder.`,
    )
  }
  if (context.counts.externalVideos > 0) {
    warnings.push(
      `${context.counts.externalVideos} external video occurrence${context.counts.externalVideos === 1 ? ' is' : 's are'} exposed as a safe HTTPS link; no iframe is embedded.`,
    )
  }
  if (context.counts.localVideos > 0) {
    warnings.push(
      `${context.counts.localVideos} local video occurrence${context.counts.localVideos === 1 ? ' is' : 's are'} represented by validated metadata only.`,
    )
  }
  if (context.counts.localAttachments > 0) {
    warnings.push(
      `${context.counts.localAttachments} local attachment occurrence${context.counts.localAttachments === 1 ? ' is' : 's are'} represented by validated metadata only.`,
    )
  }
  if (context.counts.remoteMedia > 0) {
    warnings.push(
      `${context.counts.remoteMedia} remote uploaded-media occurrence${context.counts.remoteMedia === 1 ? ' has' : 's have'} metadata only.`,
    )
  }

  const assetCounts = {image: 0, video: 0, attachment: 0}
  for (const asset of assets) assetCounts[asset.kind] += 1

  return {
    ok: true,
    approximate: true,
    source: 'content-json',
    markdownRendered: true,
    contentType: snapshot.contentType,
    slug: snapshot.slug,
    articlePath: snapshot.articlePath,
    markdownPath: markdown.markdownPath,
    previewPath,
    previewUrl: pathToFileURL(previewPath).href,
    previewRevision: revision,
    locales: ['en', 'zh'],
    bodyBlocks: {
      en: snapshot.article.body.en.length,
      zh: snapshot.article.body.zh.length,
    },
    localAssetCount: assets.length,
    totalAssetBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
    assetCounts,
    assets: assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      sha256: asset.sha256,
    })),
    warnings,
  }
}
