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
import {
  SAFE_LOCAL_ASSET_PATH,
  assetDefinitionForFilename,
  collectBlogAssetSources,
} from './blog-assets.mjs'
import {
  getBlogTemplatePreset,
  resolveBlogTemplate,
} from './blog-templates.mjs'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BYTES = 384 * 1024 * 1024
const FILE_MODE = 0o600
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

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
  return String(value ?? '')
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
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.startsWith('//') || value.startsWith('\\\\')) return false
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

function renderMarkdownInline(source, localAssets, depth = 0) {
  if (depth > 12 || source.length === 0) return escapeHtml(source)
  const patterns = [
    {
      kind: 'image',
      expression: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/u,
    },
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
  if (selected.kind === 'image') {
    const alt = selected.match[1]
    const asset = localAssets.byPath.get(selected.match[2])
    rendered = asset
      ? renderEmbeddedImage(asset, alt, 'markdown-image')
      : `<span class="unsafe-image" role="img" aria-label="${escapeHtml(alt || 'Image omitted')}">Image omitted: ${escapeHtml(alt || 'unvalidated source')}</span>`
  } else if (selected.kind === 'code') {
    rendered = `<code>${escapeHtml(selected.match[1])}</code>`
  } else if (selected.kind === 'link') {
    const label = renderMarkdownInline(selected.match[1], localAssets, depth + 1)
    const href = selected.match[2]
    rendered = safeLinkHref(href)
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="unsafe-link" title="Unsupported link omitted">${label}</span>`
  } else if (selected.kind === 'strong') {
    rendered = `<strong>${renderMarkdownInline(selected.match[1], localAssets, depth + 1)}</strong>`
  } else {
    rendered = `<em>${renderMarkdownInline(selected.match[1], localAssets, depth + 1)}</em>`
  }
  return `${escapeHtml(before)}${rendered}${renderMarkdownInline(after, localAssets, depth + 1)}`
}

function renderMarkdown(source, localAssets) {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const output = []
  let paragraph = []
  let list
  let quote = []

  function flushParagraph() {
    if (paragraph.length > 0) {
      output.push(`<p>${renderMarkdownInline(paragraph.join(' '), localAssets)}</p>`)
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
      output.push(`<blockquote>${renderMarkdownInline(quote.join(' '), localAssets)}</blockquote>`)
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
      output.push(`<h${level}>${renderMarkdownInline(heading[2], localAssets)}</h${level}>`)
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
      list.items.push(`<li class="list-level-${level}">${renderMarkdownInline(listItem[4], localAssets)}</li>`)
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

function localAsset(source, localAssets) {
  if (!source || typeof source !== 'object' || !('path' in source)) return undefined
  return localAssets.byPath.get(source.path)
}

function renderEmbeddedImage(asset, alt, className) {
  return `<img class="${className}" data-preview-asset="${asset.id}" alt="${escapeHtml(alt)}" decoding="async">`
}

function materializePreviewAssetMap(snapshot) {
  let assets
  try {
    assets = materializeArticlePreviewAssets(snapshot)
  } catch {
    fail(
      'PREVIEW_ASSETS_INVALID',
      'The validated article assets could not be materialized.',
    )
  }
  if (!Array.isArray(assets)) {
    fail('PREVIEW_ASSETS_INVALID', 'The validated article assets are unavailable.')
  }

  const byPath = new Map()
  const byDigest = new Map()
  let encodedBytes = 0
  for (const asset of assets) {
    const fileDefinition = assetDefinitionForFilename(asset?.filename ?? '')
    if (
      !asset ||
      typeof asset !== 'object' ||
      typeof asset.sourcePath !== 'string' ||
      !SAFE_LOCAL_ASSET_PATH.test(asset.sourcePath) ||
      typeof asset.filename !== 'string' ||
      !fileDefinition ||
      asset.kind !== fileDefinition.kind ||
      typeof asset.mimeType !== 'string' ||
      asset.mimeType !== fileDefinition.mimeType ||
      !Buffer.isBuffer(asset.bytes) ||
      asset.size !== asset.bytes.length ||
      !SHA256_PATTERN.test(asset.sha256) ||
      byPath.has(asset.sourcePath)
    ) {
      fail(
        'PREVIEW_ASSETS_INVALID',
        'A validated article asset has invalid preview metadata.',
      )
    }
    const sha256 = createHash('sha256').update(asset.bytes).digest('hex')
    if (sha256 !== asset.sha256) {
      fail(
        'PREVIEW_ASSETS_INVALID',
        'A validated article asset changed before preview rendering.',
      )
    }
    let definition = byDigest.get(asset.sha256)
    if (
      definition &&
      (definition.mimeType !== asset.mimeType || definition.kind !== asset.kind)
    ) {
      fail(
        'PREVIEW_ASSETS_INVALID',
        'Equivalent validated article asset bytes have conflicting metadata.',
      )
    }
    const embedsBytes = asset.kind === 'image' || asset.kind === 'video'
    definition ??= Object.freeze({
      id: `preview-asset-${asset.sha256}`,
      filename: asset.filename,
      kind: asset.kind,
      mimeType: asset.mimeType,
      size: asset.size,
      ...(embedsBytes ? {base64: asset.bytes.toString('base64')} : {}),
    })
    if (!byDigest.has(asset.sha256) && embedsBytes) {
      encodedBytes += definition.base64.length
      if (encodedBytes > MAX_PREVIEW_BYTES) {
        fail('PREVIEW_SIZE_INVALID', 'The embedded preview assets exceed the preview size limit.')
      }
    }
    byDigest.set(asset.sha256, definition)
    byPath.set(asset.sourcePath, definition)
  }
  return Object.freeze({
    byPath,
    definitions: Object.freeze(
      [...byDigest.values()]
        .filter((asset) => asset.base64)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  })
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
  if (Array.isArray(value)) {
    return value.filter((keyword) => typeof keyword === 'string')
  }
  if (!value || typeof value !== 'object') return []
  return Array.isArray(value[locale])
    ? value[locale].filter((keyword) => typeof keyword === 'string')
    : []
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
        } else if (mark === 'underline') {
          rendered = `<u>${rendered}</u>`
        } else if (mark === 'strike-through') {
          rendered = `<s>${rendered}</s>`
        } else if (mark === 'code') {
          rendered = `<code>${rendered}</code>`
        } else {
          const definition = definitions.get(mark)
          if (definition?._type === 'link' && safeLinkHref(definition.href)) {
            const external = definition.openInNewTab !== false
              ? ' target="_blank" rel="noopener noreferrer"'
              : ''
            rendered = `<a href="${escapeHtml(definition.href)}"${external}>${rendered}</a>`
          }
        }
      }
      return rendered
    })
    .join('')
}

function renderImage(item, localAssets) {
  const asset = localAsset(item.source, localAssets)
  const caption = item.caption || item.alt
  if (!asset) {
    return `<figure class="asset-placeholder" role="img" aria-label="${escapeHtml(item.alt)}">
      <div class="asset-placeholder__icon">◇</div>
      <strong>Remote Sanity image</strong>
      <span>${escapeHtml(item.alt)}</span>
    </figure>`
  }
  return `<figure class="body-image">
    ${renderEmbeddedImage(asset, item.alt, 'body-image__visual')}
    <figcaption>${escapeHtml(caption)}</figcaption>
  </figure>`
}

function renderCode(item) {
  const language = item.language ? escapeHtml(item.language) : 'text'
  return `<figure class="code-block">
    <figcaption>${language}</figcaption>
    <pre><code>${escapeHtml(item.code)}</code></pre>
  </figure>`
}

function renderBlocks(items) {
  return (items ?? []).map((item) => {
    if (item._type === 'code') return renderCode(item)
    const content = renderSpans(item)
    if (item.style === 'h2') return `<h2>${content}</h2>`
    if (item.style === 'h3') return `<h3>${content}</h3>`
    if (item.style === 'blockquote') return `<blockquote>${content}</blockquote>`
    return `<p>${content}</p>`
  }).join('')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function sourceReference(source) {
  if (typeof source?.assetRef === 'string') return source.assetRef
  if (typeof source?.path === 'string') return source.path
  return 'Unknown asset'
}

function renderPoster(poster, localAssets) {
  if (!poster) return {html: '', asset: undefined}
  const asset = localAsset(poster.source, localAssets)
  if (!asset) {
    return {
      html: `<div class="media-poster media-poster--placeholder" role="img" aria-label="${escapeHtml(poster.alt)}">Remote video poster</div>`,
      asset: undefined,
    }
  }
  return {
    html: renderEmbeddedImage(asset, poster.alt, 'media-poster'),
    asset,
  }
}

function renderVideo(item, context) {
  const poster = renderPoster(item.poster, context.localAssets)
  if (item.sourceType === 'external') {
    return `<figure class="media-card media-card--video">
      ${poster.html}
      <div class="media-card__body">
        <span class="module-eyebrow">External video · safe link only</span>
        <strong>${escapeHtml(item.title)}</strong>
        ${item.caption ? `<p>${escapeHtml(item.caption)}</p>` : ''}
        <a class="media-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open external video</a>
      </div>
    </figure>`
  }

  const asset = localAsset(item.source, context.localAssets)
  if (asset?.kind === 'video') {
    return `<figure class="media-card media-card--video">
      <video class="local-video" controls preload="metadata" playsinline data-preview-asset="${asset.id}"${poster.asset ? ` data-preview-poster="${poster.asset.id}"` : ''} aria-label="${escapeHtml(item.title)}"></video>
      <div class="media-card__body">
        <span class="module-eyebrow">Validated local video</span>
        <strong>${escapeHtml(item.title)}</strong>
        ${item.caption ? `<p>${escapeHtml(item.caption)}</p>` : ''}
      </div>
    </figure>`
  }

  return `<figure class="media-card media-card--video">
    ${poster.html}
    <div class="media-card__body">
      <span class="module-eyebrow">Remote Sanity video</span>
      <strong>${escapeHtml(item.title)}</strong>
      ${item.caption ? `<p>${escapeHtml(item.caption)}</p>` : ''}
      <span class="asset-reference">${escapeHtml(sourceReference(item.source))}</span>
    </div>
  </figure>`
}

function renderAttachment(item, context) {
  const asset = localAsset(item.source, context.localAssets)
  return `<aside class="media-card media-card--attachment">
    <span class="attachment-icon" aria-hidden="true">DOC</span>
    <div class="media-card__body">
      <span class="module-eyebrow">Attachment · metadata only</span>
      <strong>${escapeHtml(item.title)}</strong>
      <dl class="asset-meta">
        <div><dt>Asset</dt><dd>${escapeHtml(asset?.filename ?? sourceReference(item.source))}</dd></div>
        ${asset ? `<div><dt>Type</dt><dd>${escapeHtml(asset.mimeType)}</dd></div><div><dt>Size</dt><dd>${escapeHtml(formatBytes(asset.size))}</dd></div>` : ''}
      </dl>
    </div>
  </aside>`
}

function renderCallout(item) {
  return `<aside class="callout callout--${escapeHtml(item.tone)}">
    <span class="module-eyebrow">${escapeHtml(item.tone)} callout</span>
    ${item.title ? `<strong>${escapeHtml(item.title)}</strong>` : ''}
    <div class="callout__body">${renderBlocks(item.body)}</div>
  </aside>`
}

function renderTable(item) {
  const headerRows = Math.min(item.headerRows, item.rows.length)
  const renderRows = (rows, tag) => rows.map(
    (row) => `<tr>${row.cells.map(
      (cell) => `<${tag}>${renderBlocks(cell.value)}</${tag}>`,
    ).join('')}</tr>`,
  ).join('')
  return `<div class="table-scroll" role="region" aria-label="Content table" tabindex="0">
    <table>
      ${headerRows > 0 ? `<thead>${renderRows(item.rows.slice(0, headerRows), 'th')}</thead>` : ''}
      <tbody>${renderRows(item.rows.slice(headerRows), 'td')}</tbody>
    </table>
  </div>`
}

function renderMediaText(item, context) {
  const autoAlternates = context.preset.mediaStyle === 'alternating'
  const position = item.mediaPosition === 'auto'
    ? autoAlternates && context.mediaIndex % 2 === 1
      ? 'left'
      : 'right'
    : item.mediaPosition
  context.mediaIndex += 1
  const image = renderImage({
    _type: 'image',
    source: item.image.source,
    alt: item.image.alt,
    caption: item.image.caption,
  }, context.localAssets)
  return `<section class="media-text media-text--${position}">
    <div class="media-text__copy">
      ${item.eyebrow ? `<span class="module-eyebrow">${escapeHtml(item.eyebrow)}</span>` : ''}
      <h2>${escapeHtml(item.heading)}</h2>
      ${renderBlocks(item.body)}
    </div>
    <div class="media-text__media">${image}</div>
  </section>`
}

function renderFaq(item) {
  return `<section class="faq-section">
    ${item.heading ? `<h2>${escapeHtml(item.heading)}</h2>` : ''}
    <div class="faq-list">${item.items.map((faq) => `<details>
      <summary>${escapeHtml(faq.question)}</summary>
      <div class="faq-answer">${renderBlocks(faq.answer)}</div>
    </details>`).join('')}</div>
  </section>`
}

function renderTutorial(item, context) {
  const steps = item.steps.map((step, index) => {
    const anchor = `${context.locale}-step-${escapeHtml(step._key)}`
    const image = step.image
      ? renderImage({
          _type: 'image',
          source: step.image.source,
          alt: step.image.alt,
          caption: step.image.caption,
        }, context.localAssets)
      : ''
    return `<section class="tutorial-step" id="${anchor}">
      <span class="step-number">${String(index + 1).padStart(2, '0')}</span>
      <div class="tutorial-step__body">
        <h3>${escapeHtml(step.title)}</h3>
        ${renderBlocks(step.body)}
        ${image}
      </div>
    </section>`
  }).join('')
  const navigation = context.preset.stepNavigation
    ? `<nav class="tutorial-nav" aria-label="Tutorial steps"><strong>${escapeHtml(item.heading || 'Steps')}</strong>${item.steps.map((step, index) => `<a href="#${context.locale}-step-${escapeHtml(step._key)}">${index + 1}. ${escapeHtml(step.title)}</a>`).join('')}</nav>`
    : ''
  return `<section class="tutorial-module">
    ${item.heading ? `<h2>${escapeHtml(item.heading)}</h2>` : ''}
    <div class="tutorial-layout">${navigation}<div class="tutorial-list">${steps}</div></div>
  </section>`
}

function renderCtaAction(action, className) {
  const external = action.openInNewTab !== false
    ? ' target="_blank" rel="noopener noreferrer"'
    : ''
  return `<a class="${className}" href="${escapeHtml(action.href)}"${external}>${escapeHtml(action.label)}</a>`
}

function renderCta(item) {
  return `<aside class="cta-card cta-card--${escapeHtml(item.theme)}">
    ${item.eyebrow ? `<span class="module-eyebrow">${escapeHtml(item.eyebrow)}</span>` : ''}
    <h2>${escapeHtml(item.heading)}</h2>
    ${item.body ? `<div class="cta-card__body">${renderBlocks(item.body)}</div>` : ''}
    <div class="cta-actions">
      ${renderCtaAction(item.primaryAction, 'cta-action cta-action--primary')}
      ${item.secondaryAction ? renderCtaAction(item.secondaryAction, 'cta-action cta-action--secondary') : ''}
    </div>
  </aside>`
}

function renderStandaloneItem(item, context) {
  if (item._type === 'image') return renderImage(item, context.localAssets)
  if (item._type === 'code') return renderCode(item)
  if (item._type === 'video') return renderVideo(item, context)
  if (item._type === 'attachment') return renderAttachment(item, context)
  if (item._type === 'callout') return renderCallout(item)
  if (item._type === 'table') return renderTable(item)
  if (item._type === 'mediaText') return renderMediaText(item, context)
  if (item._type === 'faqSection') return renderFaq(item)
  if (item._type === 'tutorialSteps') return renderTutorial(item, context)
  if (item._type === 'cta') return renderCta(item)
  const content = renderSpans(item)
  if (item.style === 'h2') return `<h2>${content}</h2>`
  if (item.style === 'h3') return `<h3>${content}</h3>`
  if (item.style === 'blockquote') return `<blockquote>${content}</blockquote>`
  return `<p>${content}</p>`
}

function renderPortableText(items, context) {
  const output = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item._type !== 'block' || !item.listItem) {
      output.push(renderStandaloneItem(item, context))
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

function renderCover(article, localAssets, locale) {
  const asset = localAsset(article.coverImage.source, localAssets)
  const alt = locale
    ? localized(article.coverImage.alt, locale, 'Cover image')
    : `${article.coverImage.alt.en} / ${article.coverImage.alt.zh}`
  if (!asset) {
    return `<div class="cover-placeholder" role="img" aria-label="${escapeHtml(alt)}">
      <span>Remote cover image</span>
      <strong>${escapeHtml(locale ? article.title[locale] : article.title.en)}</strong>
    </div>`
  }
  return renderEmbeddedImage(asset, alt, 'cover')
}

function renderSeoImage(openGraph, locale, localAssets) {
  if (!openGraph?.image) return ''
  const alt = localized(openGraph.image.alt, locale, 'Open Graph image')
  const asset = localAsset(openGraph.image.source, localAssets)
  if (!asset) {
    return `<section class="seo-og-image">
      <h3>Open Graph image</h3>
      <figure class="asset-placeholder seo-image" role="img" aria-label="${escapeHtml(alt)}">
        <div class="asset-placeholder__icon" aria-hidden="true">◇</div>
        <strong>Remote Sanity Open Graph image</strong>
        <span>${escapeHtml(alt)}</span>
      </figure>
    </section>`
  }
  return `<section class="seo-og-image">
    <h3>Open Graph image</h3>
    <figure class="seo-image">
      ${renderEmbeddedImage(asset, alt, 'seo-image__visual')}
      <figcaption>${escapeHtml(alt)}</figcaption>
    </figure>
  </section>`
}

function renderRobots(robots) {
  if (!robots) return 'Not specified (publisher defaults: index, follow)'
  const index = robots.index === undefined
    ? 'index (publisher default)'
    : robots.index
      ? 'index'
      : 'noindex'
  const follow = robots.follow === undefined
    ? 'follow (publisher default)'
    : robots.follow
      ? 'follow'
      : 'nofollow'
  return `${index}, ${follow}`
}

function renderSitemap(sitemap) {
  if (!sitemap) return 'Not specified (publisher default: included)'
  if (sitemap.include === undefined) return 'Included (publisher default)'
  return sitemap.include ? 'Included' : 'Excluded'
}

function renderSeo(article, locale, localAssets) {
  const seo = article.seo
  const title = localized(seo.title, locale)
  const description = localized(seo.description, locale)
  const keywords = localizedKeywords(seo.keywords, locale)
  const canonical = localized(seo.canonicalUrl, locale)
  const openGraph = seo.openGraph
  const openGraphTitle = localized(openGraph?.title, locale)
  const openGraphDescription = localized(openGraph?.description, locale)
  return `<aside class="seo-card" aria-label="Full SEO preview">
    <span class="seo-card__label">Full SEO preview</span>
    <section>
      <h3>Search result</h3>
      <strong class="search-title">${escapeHtml(title)}</strong>
      <div class="canonical">${canonical
        ? escapeHtml(canonical)
        : '<span class="derived-value">Derived by the publisher from the site origin and slug</span>'}</div>
      <p>${escapeHtml(description)}</p>
    </section>
    <dl class="seo-fields">
      <div><dt>Keywords</dt><dd>${keywords.length > 0
        ? keywords.map((keyword) => escapeHtml(keyword)).join(', ')
        : 'Not specified'}</dd></div>
      <div><dt>Canonical URL</dt><dd>${canonical
        ? escapeHtml(canonical)
        : '<span class="derived-value">Publisher-derived</span>'}</dd></div>
      <div><dt>Robots</dt><dd>${escapeHtml(renderRobots(seo.robots))}</dd></div>
      <div><dt>Sitemap</dt><dd>${escapeHtml(renderSitemap(seo.sitemap))}</dd></div>
      <div><dt>Open Graph title</dt><dd>${openGraphTitle
        ? escapeHtml(openGraphTitle)
        : 'Not specified'}</dd></div>
      <div><dt>Open Graph description</dt><dd>${openGraphDescription
        ? escapeHtml(openGraphDescription)
        : 'Not specified'}</dd></div>
    </dl>
    ${renderSeoImage(openGraph, locale, localAssets)}
  </aside>`
}

function renderLocale(article, locale, label, localAssets, template, preset) {
  const title = article.title[locale]
  const excerpt = article.excerpt[locale]
  const context = {locale, localAssets, template, preset, mediaIndex: 0}
  const header = template === 'default'
    ? `<header class="article-header">
      <span class="language-label">${escapeHtml(label)}</span>
      <h1>${escapeHtml(title)}</h1>
      <p class="excerpt">${escapeHtml(excerpt)}</p>
    </header>`
    : `<header class="template-hero template-hero--${preset.heroVariant}">
      <div class="template-hero__copy">
        <span class="language-label">${escapeHtml(label)} · ${escapeHtml(template)}</span>
        <h1>${escapeHtml(title)}</h1>
        <p class="excerpt">${escapeHtml(excerpt)}</p>
      </div>
      <div class="template-hero__media">${renderCover(article, localAssets, locale)}</div>
    </header>`
  return `<article class="article article--${escapeHtml(template)} article--${escapeHtml(preset.tone)}" id="${locale}" lang="${locale}" data-blog-template="${escapeHtml(template)}" data-content-width="${escapeHtml(preset.contentWidth)}">
    ${header}
    <div class="prose prose--${escapeHtml(preset.contentWidth)}">${renderPortableText(article.body[locale], context)}</div>
    ${renderSeo(article, locale, localAssets)}
  </article>`
}

function countRemoteImages(article) {
  return collectBlogAssetSources(article).filter(
    ({kind, source}) => kind === 'image' && 'assetRef' in source,
  ).length
}

function renderAssetBootstrap(localAssets, scriptNonce) {
  if (localAssets.definitions.length === 0) return ''
  const payloads = localAssets.definitions
    .map(
      (asset) => `<script class="preview-asset-payload" type="application/octet-stream" nonce="${scriptNonce}" id="${asset.id}" data-preview-mime="${escapeHtml(asset.mimeType)}">${asset.base64}</script>`,
    )
    .join('\n')
  return `<div class="preview-asset-store" hidden aria-hidden="true">
    ${payloads}
  </div>
  <script nonce="${scriptNonce}">
    (() => {
      'use strict'
      const objectUrls = []
      const sources = new Map()
      for (const payload of document.querySelectorAll('script.preview-asset-payload')) {
        const binary = atob(payload.textContent.trim())
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index)
        }
        const objectUrl = URL.createObjectURL(
          new Blob([bytes], {type: payload.dataset.previewMime}),
        )
        sources.set(payload.id, objectUrl)
        objectUrls.push(objectUrl)
        payload.remove()
      }
      for (const image of document.querySelectorAll('img[data-preview-asset]')) {
        const objectUrl = sources.get(image.dataset.previewAsset)
        if (objectUrl) image.src = objectUrl
      }
      for (const video of document.querySelectorAll('video[data-preview-asset]')) {
        const objectUrl = sources.get(video.dataset.previewAsset)
        if (objectUrl) video.src = objectUrl
        const posterUrl = sources.get(video.dataset.previewPoster)
        if (posterUrl) video.poster = posterUrl
      }
      window.addEventListener(
        'pagehide',
        () => {
          for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
        },
        {once: true},
      )
    })()
  </script>`
}

function renderHtml(article, markdownSource, previewRevision, localAssets) {
  const scriptNonce = randomUUID().replaceAll('-', '')
  const template = resolveBlogTemplate(article.template)
  const preset = getBlogTemplatePreset(template)
  const published = article.publishedAt
    ? `<span>Published timestamp: ${escapeHtml(article.publishedAt)}</span>`
    : '<span>Draft without a fixed publication timestamp</span>'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src blob:; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">
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
    .article { min-width: 0; overflow: hidden; padding: clamp(24px, 4vw, 54px); border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 18px 44px rgba(28, 40, 35, .07); container-type: inline-size; }
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
    .markdown-image { display: block; max-width: 100%; height: auto; margin: 26px auto; border-radius: 14px; }
    .unsafe-image { display: inline-block; padding: 8px 11px; border: 1px dashed #dc2626; border-radius: 8px; color: var(--muted); font: 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    figcaption { margin-top: 8px; color: var(--muted); font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder { min-height: 220px; display: grid; place-content: center; gap: 8px; padding: 26px; border: 1px dashed var(--line); border-radius: 16px; background: color-mix(in srgb, var(--soft) 38%, var(--paper)); text-align: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .asset-placeholder__icon { color: var(--accent); font-size: 42px; }
    .code-block { margin: 28px 0; overflow: hidden; border-radius: 14px; background: #111827; color: #e5e7eb; }
    .code-block figcaption { margin: 0; padding: 9px 14px; background: #1f2937; color: #9ca3af; }
    .code-block pre { margin: 0; padding: 18px; overflow: auto; }
    .code-block code { padding: 0; background: none; color: inherit; }
    .template-hero { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(220px, .92fr); gap: clamp(22px, 4vw, 48px); margin: calc(clamp(24px, 4vw, 54px) * -1); margin-bottom: 42px; padding: clamp(30px, 5vw, 64px); background: #070908; color: #fff; isolation: isolate; }
    .template-hero::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .28; background-image: linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px); background-size: 32px 32px; z-index: -1; }
    .template-hero { position: relative; }
    .template-hero__copy { align-self: center; }
    .template-hero h1 { color: #fff; }
    .template-hero .excerpt { color: #c5ccc8; }
    .template-hero .language-label { color: #76e7cc; }
    .template-hero__media { align-self: center; }
    .template-hero .cover, .template-hero .cover-placeholder { aspect-ratio: 16 / 10; border-radius: 18px; }
    .template-hero--compact { grid-template-columns: 1fr; text-align: center; }
    .template-hero--compact .template-hero__copy { width: min(720px, 100%); margin: auto; }
    .template-hero--compact .template-hero__media { width: min(780px, 100%); margin: auto; }
    .template-hero--compact .cover, .template-hero--compact .cover-placeholder { aspect-ratio: 16 / 7; }
    .template-hero--editorial { grid-template-columns: minmax(0, 1.2fr) minmax(190px, .8fr); }
    .template-hero--editorial .cover, .template-hero--editorial .cover-placeholder { aspect-ratio: 5 / 4; }
    .prose--reading { width: min(50rem, 100%); margin-inline: auto; }
    .prose--wide { width: min(54rem, 100%); margin-inline: auto; }
    .module-eyebrow { display: block; margin-bottom: 8px; color: var(--accent); font: 800 11px/1.3 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; }
    .media-text { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; gap: clamp(26px, 5vw, 58px); margin: 54px 0; }
    .media-text--left .media-text__media { order: -1; }
    .media-text__copy h2 { margin-top: 0; }
    .media-text .body-image { margin: 0; }
    .media-text .body-image img { min-height: 230px; object-fit: cover; }
    .faq-section, .tutorial-module { margin: 58px 0; }
    .faq-list { display: grid; gap: 10px; }
    .faq-list details { padding: 0 18px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--soft) 28%, var(--paper)); }
    .faq-list summary { cursor: pointer; padding: 17px 0; font: 750 17px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    .faq-answer { padding: 0 0 16px; }
    .tutorial-layout { display: grid; grid-template-columns: minmax(150px, .35fr) minmax(0, 1fr); gap: 28px; align-items: start; }
    .tutorial-nav { position: sticky; top: 18px; display: grid; gap: 8px; padding: 16px; border: 1px solid var(--line); border-radius: 14px; font: 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    .tutorial-nav a { text-decoration: none; }
    .tutorial-list { display: grid; gap: 28px; }
    .tutorial-step { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 16px; scroll-margin-top: 24px; }
    .tutorial-step h3 { margin-top: 0; }
    .step-number { display: grid; width: 42px; height: 42px; place-content: center; border-radius: 50%; background: var(--accent); color: #fff; font: 800 13px/1 Inter, ui-sans-serif, system-ui, sans-serif; }
    .callout { margin: 28px 0; padding: 20px; border: 1px solid var(--line); border-left: 5px solid var(--accent); border-radius: 12px; background: color-mix(in srgb, var(--soft) 40%, var(--paper)); }
    .callout--success { border-left-color: #16a34a; }
    .callout--warning { border-left-color: #d97706; }
    .callout--error { border-left-color: #dc2626; }
    .callout > strong { display: block; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .table-scroll { margin: 34px 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; }
    table { width: 100%; border-collapse: collapse; font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    th, td { min-width: 140px; padding: 14px 16px; border: 1px solid var(--line); vertical-align: top; text-align: left; }
    th { background: color-mix(in srgb, var(--soft) 70%, var(--paper)); }
    th p, td p { margin: 0; }
    .media-card { display: grid; grid-template-columns: minmax(150px, .45fr) minmax(0, 1fr); gap: 18px; align-items: center; margin: 30px 0; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in srgb, var(--soft) 28%, var(--paper)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .media-card__body { padding: 18px; }
    .media-card__body > strong { display: block; font-size: 18px; }
    .media-card__body p { margin: 8px 0; }
    .media-poster, .local-video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #080b0a; }
    .media-poster--placeholder { display: grid; place-content: center; min-height: 170px; color: var(--muted); }
    .media-card--attachment { grid-template-columns: auto minmax(0, 1fr); padding-left: 18px; }
    .attachment-icon { display: grid; width: 58px; height: 58px; place-content: center; border-radius: 14px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 900; }
    .asset-meta { margin: 10px 0 0; font-size: 12px; }
    .asset-meta div { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; }
    .asset-meta dt { color: var(--muted); }
    .asset-meta dd { margin: 0; overflow-wrap: anywhere; }
    .asset-reference { overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
    .cta-card { margin: 56px 0 12px; padding: clamp(26px, 5vw, 48px); border-radius: 20px; background: #101512; color: #fff; }
    .cta-card--brand { background: #0f766e; }
    .cta-card--light { border: 1px solid var(--line); background: var(--soft); color: var(--ink); }
    .cta-card h2 { margin: 0; color: inherit; }
    .cta-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .cta-action { padding: 10px 16px; border: 1px solid currentColor; border-radius: 999px; color: inherit; font: 750 14px/1.2 Inter, ui-sans-serif, system-ui, sans-serif; text-decoration: none; }
    .cta-action--primary { border-color: #fff; background: #fff; color: #101512; }
    .cta-card--light .cta-action--primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .seo-card { margin-top: 46px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--soft) 46%, var(--paper)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .seo-card__label { display: block; margin-bottom: 8px; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .seo-card h3 { margin: 18px 0 8px; font-size: 14px; }
    .seo-card strong { display: block; color: #1558d6; font-size: 18px; line-height: 1.35; }
    .seo-card p { margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .canonical { margin-top: 4px; overflow-wrap: anywhere; color: #15803d; font-size: 13px; }
    .derived-value { color: var(--muted); font-style: italic; }
    .seo-fields { display: grid; gap: 8px; margin: 18px 0 0; }
    .seo-fields div { display: grid; grid-template-columns: minmax(120px, .55fr) minmax(0, 1fr); gap: 12px; padding-top: 8px; border-top: 1px solid var(--line); }
    .seo-fields dt { color: var(--muted); font-size: 12px; font-weight: 700; }
    .seo-fields dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
    .seo-og-image { margin-top: 18px; }
    .seo-image { margin: 0; min-height: 0; }
    .seo-image img { display: block; width: 100%; height: auto; border-radius: 10px; }
    .markdown-card { margin-top: 18px; padding: clamp(22px, 4vw, 44px); border: 1px solid var(--line); border-radius: 24px; background: var(--paper); box-shadow: 0 18px 44px rgba(28, 40, 35, .07); }
    .markdown-card summary { cursor: pointer; color: var(--ink); font-size: 21px; font-weight: 800; }
    .markdown-note { margin-top: 12px; padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--soft) 52%, var(--paper)); color: var(--muted); font-size: 14px; }
    .markdown-prose { width: min(760px, 100%); margin: 34px auto 0; }
    .unsafe-link { text-decoration: line-through; text-decoration-color: #dc2626; cursor: not-allowed; }
    footer { margin-top: 18px; color: var(--muted); text-align: center; font-size: 13px; }
    @container (max-width: 620px) { .template-hero { grid-template-columns: 1fr; } .media-text { grid-template-columns: 1fr; } .media-text__media { order: -1; } .tutorial-layout { grid-template-columns: 1fr; } .tutorial-nav { position: static; } }
    @media (max-width: 840px) { .columns { grid-template-columns: 1fr; } .article { padding: 28px 22px; } h1 { font-size: 42px; } .template-hero { grid-template-columns: 1fr; margin: -28px -22px 36px; padding: 36px 22px; } .media-text { grid-template-columns: 1fr; } .media-text__media { order: -1; } .tutorial-layout { grid-template-columns: 1fr; } .tutorial-nav { position: static; } }
    @media (max-width: 560px) { .shell { width: min(100% - 18px, 1120px); } .media-card { grid-template-columns: 1fr; } .media-card--attachment { grid-template-columns: auto minmax(0, 1fr); } .tutorial-step { grid-template-columns: 38px minmax(0, 1fr); } }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
    @media (prefers-color-scheme: dark) { :root { --bg: #101512; --paper: #171d1a; --ink: #edf4ef; --muted: #a3ada7; --line: #344039; --accent: #5eead4; --soft: #183d36; } .hero, .article { box-shadow: none; } .seo-card strong { color: #8ab4ff; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="preview-bar">
      <span><strong>Local draft preview</strong> · approximate production appearance</span>
      <nav aria-label="Languages"><a href="#en">English</a><a href="#zh">中文</a></nav>
    </div>
    <section class="hero hero--${escapeHtml(template)}">
      ${template === 'default' ? renderCover(article, localAssets) : ''}
      <div class="hero-meta"><span>/${escapeHtml(article.slug)}</span><span>Template: ${escapeHtml(template)}</span>${published}<span>Source: validated article JSON</span><span>Preview revision: ${escapeHtml(previewRevision.slice(0, 12))}</span></div>
    </section>
    <section class="columns">
      ${renderLocale(article, 'en', 'English', localAssets, template, preset)}
      ${renderLocale(article, 'zh', '中文', localAssets, template, preset)}
    </section>
    <details class="markdown-card" open>
      <summary>Markdown visual preview</summary>
      <div class="markdown-note">This pane safely renders the sibling Markdown source. Compare it with the JSON payload preview above before publishing.</div>
      <div class="prose markdown-prose">${renderMarkdown(markdownSource, localAssets)}</div>
    </details>
    ${renderAssetBootstrap(localAssets, scriptNonce)}
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
    fail('PREVIEW_SIZE_INVALID', 'The generated preview exceeds the 384 MiB limit.')
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
  const localAssets = materializePreviewAssetMap(snapshot)
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
    template: snapshot.template ?? resolveBlogTemplate(snapshot.article.template),
    articlePath: snapshot.articlePath,
    markdownPath,
    ...(coverPath ? {coverPath} : {}),
    previewPath,
    previewUrl: pathToFileURL(previewPath).href,
    locales: ['en', 'zh'],
    localImageCount: snapshot.localImageCount,
    localAssetCount: snapshot.localAssetCount,
    assetCounts: snapshot.assetCounts,
    warnings,
  }
}
