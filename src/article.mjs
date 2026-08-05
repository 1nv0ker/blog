import {createHash} from 'node:crypto'
import {lstat, readFile, realpath} from 'node:fs/promises'
import path from 'node:path'

import {z} from 'zod'

import {
  MAX_ATTACHMENT_BYTES as BLOG_MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LOCAL_ASSETS,
  MAX_TOTAL_ASSET_BYTES,
  MAX_VIDEO_BYTES as BLOG_MAX_VIDEO_BYTES,
  SAFE_ATTACHMENT_ASSET_REF,
  SAFE_IMAGE_ASSET_REF,
  SAFE_LEGACY_IMAGE_ASSET_REF,
  SAFE_LOCAL_ASSET_PATH,
  SAFE_VIDEO_ASSET_REF,
  assetDefinitionForFilename,
  collectBlogAssetSources,
  countAssetsByKind,
  hasAssetSignature,
} from './blog-assets.mjs'
import {
  BLOG_TEMPLATE_IDS,
  resolveBlogTemplate,
  validateBlogTemplate,
} from './blog-templates.mjs'
import {DEFAULT_PUBLIC_SITE_ORIGIN} from './constants.mjs'

export const MAX_ARTICLE_BYTES = 2 * 1024 * 1024
export const MAX_ASSET_BYTES = MAX_IMAGE_BYTES
export const MAX_VIDEO_BYTES = BLOG_MAX_VIDEO_BYTES
export const MAX_ATTACHMENT_BYTES = BLOG_MAX_ATTACHMENT_BYTES
export const MAX_ASSETS = MAX_LOCAL_ASSETS
export const MAX_TOTAL_BYTES = MAX_TOTAL_ASSET_BYTES
export const MAX_RESPONSE_BYTES = 1024 * 1024
export const REQUEST_TIMEOUT_MS = 180_000

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_KEY = /^[A-Za-z0-9_-]+$/u
const ROOT_MARKS = new Set(['strong', 'em', 'code'])
const NESTED_MARKS = new Set(['strong', 'em', 'underline', 'strike-through', 'code'])

const snapshotState = new WeakMap()

export class ArticleValidationError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ArticleValidationError'
    this.category = 'validation'
    this.code = code
    this.retryable = false
    this.resultUnknown = false
    if (details !== undefined) this.details = details
  }
}

function nonBlank(maxLength) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, 'must not be blank')
}

const localizedString = (maxLength) =>
  z
    .object({
      en: nonBlank(maxLength),
      zh: nonBlank(maxLength),
    })
    .strict()

function trimmedNonBlank(maxLength) {
  let schema = z.string().trim().min(1, 'must not be blank')
  if (maxLength !== undefined) schema = schema.max(maxLength)
  return schema
}

const localizedTrimmedString = (maxLength) =>
  z
    .object({
      en: trimmedNonBlank(maxLength),
      zh: trimmedNonBlank(maxLength),
    })
    .strict()

const portableTextKey = z.string().min(1).max(128).regex(SAFE_KEY)

function safeLinkHref(value) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
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

const legacyImageSource = z.union([
  z.object({path: z.string().regex(SAFE_LOCAL_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_LEGACY_IMAGE_ASSET_REF)}).strict(),
])

const supportedImageSource = z.union([
  z.object({path: z.string().regex(SAFE_LOCAL_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_IMAGE_ASSET_REF)}).strict(),
])

const videoSource = z.union([
  z.object({path: z.string().regex(SAFE_LOCAL_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_VIDEO_ASSET_REF)}).strict(),
])

const attachmentSource = z.union([
  z.object({path: z.string().regex(SAFE_LOCAL_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_ATTACHMENT_ASSET_REF)}).strict(),
])

const imageCrop = z
  .object({
    _type: z.literal('sanity.imageCrop').optional(),
    top: z.number().min(0).max(1),
    bottom: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
  })
  .strict()

const imageHotspot = z
  .object({
    _type: z.literal('sanity.imageHotspot').optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
  })
  .strict()

const portableTextLink = z
  .object({
    _type: z.literal('link'),
    _key: portableTextKey.optional(),
    href: z.string().min(1).max(2048).refine(safeLinkHref, 'unsupported link protocol'),
    openInNewTab: z.boolean().default(true),
  })
  .strict()

const portableTextSpan = z
  .object({
    _type: z.literal('span'),
    _key: portableTextKey.optional(),
    text: z.string(),
    marks: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict()

function createBlockSchema(styles) {
  return z
    .object({
      _type: z.literal('block'),
      _key: portableTextKey.optional(),
      style: z.enum(styles).default('normal'),
      listItem: z.enum(['bullet', 'number']).optional(),
      level: z.number().int().min(1).max(10).optional(),
      markDefs: z.array(portableTextLink).default([]),
      children: z.array(portableTextSpan).min(1),
    })
    .strict()
    .superRefine((block, context) => {
      if (block.level !== undefined && block.listItem === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['level'],
          message: 'level requires listItem',
        })
      }
    })
}

const portableTextBlock = createBlockSchema(['normal', 'h2', 'h3', 'blockquote'])
const nestedTextBlock = createBlockSchema(['normal'])

function hasMeaningfulNestedContent(items) {
  return items.some((item) => {
    if (item?._type === 'code') return item.code.trim().length > 0
    return (
      item?._type === 'block' &&
      item.children.some((span) => span.text.trim().length > 0)
    )
  })
}

function meaningfulContent(itemSchema, minimumMessage, contentMessage) {
  return z
    .array(itemSchema)
    .min(1, minimumMessage)
    .refine(hasMeaningfulNestedContent, contentMessage)
}

const portableTextImage = z
  .object({
    _type: z.literal('image'),
    _key: portableTextKey.optional(),
    source: legacyImageSource,
    alt: nonBlank(500),
    caption: trimmedNonBlank(500).optional(),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

const portableTextCode = z
  .object({
    _type: z.literal('code'),
    _key: portableTextKey.optional(),
    language: nonBlank(64).default('javascript'),
    code: z.string(),
    highlightedLines: z.array(z.number().int().min(1)).max(10_000).optional(),
  })
  .strict()

const embeddedImage = z
  .object({
    source: legacyImageSource,
    alt: nonBlank(500),
    caption: trimmedNonBlank(500).optional(),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

const videoPoster = z
  .object({
    source: legacyImageSource,
    alt: nonBlank(500),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

function isAllowedExternalVideoUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return false
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    const hosts = [
      'youtube.com',
      'youtube-nocookie.com',
      'vimeo.com',
      'bilibili.com',
      'youtu.be',
      'b23.tv',
    ]
    if (hosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
      return true
    }
    return /\.(?:mp4|webm)$/iu.test(url.pathname)
  } catch {
    return false
  }
}

const uploadVideo = z
  .object({
    _type: z.literal('video'),
    _key: portableTextKey.optional(),
    sourceType: z.literal('upload'),
    source: videoSource,
    title: nonBlank(240),
    caption: trimmedNonBlank(500).optional(),
    poster: videoPoster.optional(),
  })
  .strict()

const externalVideo = z
  .object({
    _type: z.literal('video'),
    _key: portableTextKey.optional(),
    sourceType: z.literal('external'),
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine(isAllowedExternalVideoUrl, 'unsupported external video URL'),
    title: nonBlank(240),
    caption: trimmedNonBlank(500).optional(),
    poster: videoPoster.optional(),
  })
  .strict()

const video = z.discriminatedUnion('sourceType', [uploadVideo, externalVideo])

const attachment = z
  .object({
    _type: z.literal('attachment'),
    _key: portableTextKey.optional(),
    source: attachmentSource,
    title: nonBlank(240),
  })
  .strict()

const callout = z
  .object({
    _type: z.literal('callout'),
    _key: portableTextKey.optional(),
    tone: z.enum(['info', 'success', 'warning', 'error']).default('info'),
    title: trimmedNonBlank(240).optional(),
    body: meaningfulContent(
      nestedTextBlock,
      'A callout requires at least one text block.',
      'A callout requires non-empty text.',
    ),
  })
  .strict()

const tableCell = z
  .object({
    _type: z.literal('cell').default('cell'),
    _key: portableTextKey.optional(),
    value: meaningfulContent(
      nestedTextBlock,
      'A table cell requires at least one text block.',
      'A table cell requires non-empty text.',
    ),
  })
  .strict()

const tableRow = z
  .object({
    _type: z.literal('row').default('row'),
    _key: portableTextKey.optional(),
    cells: z.array(tableCell).min(1, 'A table row requires at least one cell.'),
  })
  .strict()

const table = z
  .object({
    _type: z.literal('table'),
    _key: portableTextKey.optional(),
    headerRows: z.number().int().min(0).max(1).default(1),
    rows: z.array(tableRow).min(1, 'A table requires at least one row.'),
  })
  .strict()
  .superRefine((value, context) => {
    const width = value.rows[0]?.cells.length
    value.rows.forEach((row, index) => {
      if (row.cells.length !== width) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', index, 'cells'],
          message: 'Every table row must contain the same number of cells.',
        })
      }
    })
  })

const mediaText = z
  .object({
    _type: z.literal('mediaText'),
    _key: portableTextKey.optional(),
    eyebrow: trimmedNonBlank(120).optional(),
    heading: nonBlank(240),
    body: meaningfulContent(
      nestedTextBlock,
      'Media text requires at least one text block.',
      'Media text requires non-empty text.',
    ),
    image: embeddedImage,
    mediaPosition: z.enum(['auto', 'left', 'right']).default('auto'),
  })
  .strict()

const faqItem = z
  .object({
    _type: z.literal('faqItem').default('faqItem'),
    _key: portableTextKey.optional(),
    question: nonBlank(300),
    answer: meaningfulContent(
      nestedTextBlock,
      'An FAQ answer requires at least one text block.',
      'An FAQ answer requires non-empty text.',
    ),
  })
  .strict()

const faqSection = z
  .object({
    _type: z.literal('faqSection'),
    _key: portableTextKey.optional(),
    heading: trimmedNonBlank(240).optional(),
    items: z.array(faqItem).min(1, 'An FAQ section requires at least one item.'),
  })
  .strict()

const tutorialStepBodyItem = z.union([nestedTextBlock, portableTextCode])
const tutorialStep = z
  .object({
    _type: z.literal('tutorialStep').default('tutorialStep'),
    _key: portableTextKey.optional(),
    title: nonBlank(240),
    body: meaningfulContent(
      tutorialStepBodyItem,
      'A tutorial step requires at least one content block.',
      'A tutorial step requires non-empty text or code.',
    ),
    image: embeddedImage.optional(),
  })
  .strict()

const tutorialSteps = z
  .object({
    _type: z.literal('tutorialSteps'),
    _key: portableTextKey.optional(),
    heading: trimmedNonBlank(240).optional(),
    steps: z.array(tutorialStep).min(1, 'Tutorial steps requires at least one step.'),
  })
  .strict()

const ctaAction = z
  .object({
    _type: z.literal('ctaAction').default('ctaAction'),
    label: nonBlank(120),
    href: z.string().min(1).max(2048).refine(safeLinkHref, 'unsupported CTA link'),
    openInNewTab: z.boolean().default(true),
  })
  .strict()

const cta = z
  .object({
    _type: z.literal('cta'),
    _key: portableTextKey.optional(),
    eyebrow: trimmedNonBlank(120).optional(),
    heading: nonBlank(240),
    body: meaningfulContent(
      nestedTextBlock,
      'CTA body requires at least one text block.',
      'CTA body requires non-empty text.',
    ).optional(),
    primaryAction: ctaAction,
    secondaryAction: ctaAction.optional(),
    theme: z.enum(['dark', 'brand', 'light']).default('dark'),
  })
  .strict()

const portableTextItem = z.union([
  portableTextBlock,
  portableTextImage,
  portableTextCode,
  video,
  attachment,
  callout,
  table,
  mediaText,
  faqSection,
  tutorialSteps,
  cta,
])

const coverImage = z
  .object({
    source: legacyImageSource,
    alt: localizedString(500),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

const author = z.union([
  z.null(),
  z.object({id: nonBlank(256)}).strict(),
  z.object({slug: z.string().min(1).max(96).regex(SLUG_PATTERN)}).strict(),
])

const localizedKeywords = z
  .object({
    en: z
      .array(trimmedNonBlank(100))
      .min(1)
      .max(50)
      .refine((values) => new Set(values).size === values.length, 'SEO keywords must be unique'),
    zh: z
      .array(trimmedNonBlank(100))
      .min(1)
      .max(50)
      .refine((values) => new Set(values).size === values.length, 'SEO keywords must be unique'),
  })
  .strict()

const canonicalUrl = trimmedNonBlank(2048).refine((value) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}, 'must be an absolute HTTPS URL without credentials or a fragment')

const localizedCanonicalUrl = z
  .object({
    en: canonicalUrl,
    zh: canonicalUrl,
  })
  .strict()
  .superRefine((value, context) => {
    let englishUrl
    let chineseUrl
    try {
      englishUrl = new URL(value.en)
      chineseUrl = new URL(value.zh)
    } catch {
      return
    }
    if (englishUrl.href === chineseUrl.href) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zh'],
        message: 'English and Chinese canonical URLs must be different',
      })
    }
  })

const openGraphImage = z
  .object({
    source: supportedImageSource,
    alt: localizedTrimmedString(),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

const openGraph = z
  .object({
    title: localizedTrimmedString().optional(),
    description: localizedTrimmedString(180).optional(),
    image: openGraphImage.optional(),
  })
  .strict()

const robots = z
  .object({
    index: z.boolean().optional(),
    follow: z.boolean().optional(),
  })
  .strict()

const sitemap = z
  .object({
    include: z.boolean().optional(),
  })
  .strict()

export const articleSchema = z
  .object({
    title: localizedString(240),
    slug: z.string().min(1).max(96).regex(SLUG_PATTERN),
    template: z.enum(BLOG_TEMPLATE_IDS).optional(),
    publishedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
      .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid UTC timestamp')
      .optional(),
    excerpt: localizedString(240),
    author: author.optional(),
    coverImage,
    body: z
      .object({
        en: z.array(portableTextItem).min(1),
        zh: z.array(portableTextItem).min(1),
      })
      .strict(),
    seo: z
      .object({
        title: localizedString(240),
        description: localizedString(180),
        keywords: localizedKeywords.optional(),
        canonicalUrl: localizedCanonicalUrl.optional(),
        openGraph: openGraph.optional(),
        robots: robots.optional(),
        sitemap: sitemap.optional(),
      })
      .strict(),
  })
  .strict()

function stableKey(scope, value) {
  const cleanValue = {...value}
  delete cleanValue._key
  return `k_${createHash('sha256')
    .update(`${scope}:${JSON.stringify(cleanValue)}`)
    .digest('hex')
    .slice(0, 16)}`
}

function assignKeys(items, scope, issues) {
  const used = new Set()
  items.forEach((item, index) => {
    const key = item._key || stableKey(`${scope}.${index}`, item)
    if (used.has(key)) {
      issues.push({
        path: [...scope.split('.'), index, '_key'],
        code: 'custom',
        message: `_key "${key}" is duplicated.`,
      })
    }
    used.add(key)
    item._key = key
  })
}

function normalizeBlocks(items, scope, allowedMarks, issues) {
  assignKeys(items, scope, issues)
  items.forEach((block, blockIndex) => {
    const blockScope = `${scope}.${blockIndex}`
    assignKeys(block.markDefs, `${blockScope}.markDefs`, issues)
    assignKeys(block.children, `${blockScope}.children`, issues)
    const annotations = new Set(block.markDefs.map((definition) => definition._key))
    block.children.forEach((span, spanIndex) => {
      span.marks.forEach((mark, markIndex) => {
        if (allowedMarks.has(mark) || annotations.has(mark)) return
        issues.push({
          path: [
            ...scope.split('.'),
            blockIndex,
            'children',
            spanIndex,
            'marks',
            markIndex,
          ],
          code: 'custom',
          message: `mark "${mark}" has no matching link markDef.`,
        })
      })
    })
  })
}

function normalizeNestedContent(items, scope, issues) {
  assignKeys(items, scope, issues)
  items.forEach((item, index) => {
    if (item._type !== 'block') return
    normalizeBlocks([item], `${scope}.${index}.block`, NESTED_MARKS, issues)
  })
}

function normalizePortableText(items, locale, issues) {
  const scope = `body.${locale}`
  assignKeys(items, scope, issues)
  items.forEach((item, itemIndex) => {
    const itemScope = `${scope}.${itemIndex}`
    if (item._type === 'block') {
      normalizeBlocks([item], `${itemScope}.block`, ROOT_MARKS, issues)
    } else if (item._type === 'callout') {
      normalizeBlocks(item.body, `${itemScope}.body`, NESTED_MARKS, issues)
    } else if (item._type === 'table') {
      assignKeys(item.rows, `${itemScope}.rows`, issues)
      item.rows.forEach((row, rowIndex) => {
        const rowScope = `${itemScope}.rows.${rowIndex}`
        assignKeys(row.cells, `${rowScope}.cells`, issues)
        row.cells.forEach((cell, cellIndex) => {
          normalizeBlocks(
            cell.value,
            `${rowScope}.cells.${cellIndex}.value`,
            NESTED_MARKS,
            issues,
          )
        })
      })
    } else if (item._type === 'mediaText') {
      normalizeBlocks(item.body, `${itemScope}.body`, NESTED_MARKS, issues)
    } else if (item._type === 'faqSection') {
      assignKeys(item.items, `${itemScope}.items`, issues)
      item.items.forEach((faq, faqIndex) => {
        normalizeBlocks(
          faq.answer,
          `${itemScope}.items.${faqIndex}.answer`,
          NESTED_MARKS,
          issues,
        )
      })
    } else if (item._type === 'tutorialSteps') {
      assignKeys(item.steps, `${itemScope}.steps`, issues)
      item.steps.forEach((step, stepIndex) => {
        normalizeNestedContent(
          step.body,
          `${itemScope}.steps.${stepIndex}.body`,
          issues,
        )
      })
    } else if (item._type === 'cta' && item.body) {
      normalizeBlocks(item.body, `${itemScope}.body`, NESTED_MARKS, issues)
    }
  })
}

function normalizeAndValidateArticle(article) {
  const issues = []
  normalizePortableText(article.body.en, 'en', issues)
  normalizePortableText(article.body.zh, 'zh', issues)
  issues.push(...validateBlogTemplate(article).map((issue) => ({...issue, code: 'custom'})))
  if (issues.length > 0) {
    throw new ArticleValidationError(
      'ARTICLE_SCHEMA_INVALID',
      'The article does not satisfy the built-in contract.',
      {
        issues: issues.slice(0, 20).map((issue) => ({
          ...issue,
          path: Array.isArray(issue.path) ? issue.path.join('.') : issue.path,
        })),
      },
    )
  }
  return article
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function publicSiteOrigin(config) {
  const value = config.publicSiteOrigin ?? DEFAULT_PUBLIC_SITE_ORIGIN
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ArticleValidationError(
      'PUBLIC_SITE_ORIGIN_INVALID',
      'config.publicSiteOrigin must be a non-empty HTTPS origin.',
    )
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new ArticleValidationError(
      'PUBLIC_SITE_ORIGIN_INVALID',
      'config.publicSiteOrigin must be a valid absolute HTTPS origin.',
    )
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new ArticleValidationError(
      'PUBLIC_SITE_ORIGIN_INVALID',
      'config.publicSiteOrigin must be an HTTPS origin without credentials, path, query, or fragment.',
    )
  }
  return url.origin
}

function validateCanonicalOrigin(article, config) {
  if (!article.seo.canonicalUrl) return
  const expectedOrigin = publicSiteOrigin(config)
  const issues = []
  for (const locale of ['en', 'zh']) {
    const value = article.seo.canonicalUrl[locale]
    if (new URL(value).origin !== expectedOrigin) {
      issues.push({
        path: `seo.canonicalUrl.${locale}`,
        code: 'custom',
        message: `Canonical URL must use the configured public site origin ${expectedOrigin}.`,
      })
    }
  }
  if (issues.length > 0) {
    throw new ArticleValidationError(
      'ARTICLE_SCHEMA_INVALID',
      'The article does not satisfy the built-in contract.',
      {issues},
    )
  }
}

function collectLocalAssetReferences(article) {
  const references = new Map()
  for (const reference of collectBlogAssetSources(article)) {
    if (!('path' in reference.source)) continue
    const identity = reference.source.path.toLowerCase()
    const existing = references.get(identity)
    if (
      existing &&
      (existing.relativePath !== reference.source.path || existing.kind !== reference.kind)
    ) {
      throw new ArticleValidationError(
        'ASSET_PATH_COLLISION',
        'Local asset paths must be unique without case distinctions and cannot serve multiple asset kinds.',
      )
    }
    references.set(identity, {
      kind: reference.kind,
      relativePath: reference.source.path,
      location: reference.location,
    })
  }
  if (references.size > MAX_ASSETS) {
    throw new ArticleValidationError(
      'ASSET_COUNT_EXCEEDED',
      `An article may reference at most ${MAX_ASSETS} local assets.`,
    )
  }
  return [...references.values()]
}

async function canonicalBlogRoot(config) {
  const requested = path.resolve(config.workspaceRoot, 'blog')
  try {
    const info = await lstat(requested)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory')
    const resolved = await realpath(requested)
    if (resolved !== requested) throw new Error('redirected directory')
    return resolved
  } catch {
    throw new ArticleValidationError(
      'BLOG_DIRECTORY_INVALID',
      'The configured workspace blog directory is missing or unsafe.',
    )
  }
}

async function inspectArticleFile(articlePath, config) {
  const blogRoot = await canonicalBlogRoot(config)
  const requested = path.resolve(articlePath)
  let info
  let resolvedArticle
  try {
    info = await lstat(requested)
    if (!info.isFile() || info.isSymbolicLink() || path.extname(requested).toLowerCase() !== '.json') {
      throw new Error('unsafe article')
    }
    resolvedArticle = await realpath(requested)
  } catch {
    throw new ArticleValidationError(
      'ARTICLE_INVALID',
      'The article JSON is missing or is not a regular non-symbolic-link file.',
    )
  }
  if (!isInside(blogRoot, resolvedArticle) || resolvedArticle !== requested) {
    throw new ArticleValidationError(
      'ARTICLE_LOCATION_INVALID',
      'The article JSON must be located inside the configured blog directory.',
    )
  }
  if (info.size <= 0 || info.size > MAX_ARTICLE_BYTES) {
    throw new ArticleValidationError(
      'ARTICLE_SIZE_INVALID',
      `The article JSON must be non-empty and no larger than ${MAX_ARTICLE_BYTES} bytes.`,
    )
  }
  const articleBytes = await readFile(resolvedArticle)
  if (articleBytes.length !== info.size || articleBytes.length > MAX_ARTICLE_BYTES) {
    throw new ArticleValidationError('ARTICLE_CHANGED', 'The article changed while it was inspected.')
  }
  let candidate
  try {
    candidate = JSON.parse(articleBytes.toString('utf8'))
  } catch {
    throw new ArticleValidationError('ARTICLE_JSON_INVALID', 'The article is not valid UTF-8 JSON.')
  }
  const parsed = articleSchema.safeParse(candidate)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }))
    throw new ArticleValidationError(
      'ARTICLE_SCHEMA_INVALID',
      'The article does not satisfy the built-in contract.',
      {issues},
    )
  }
  const article = normalizeAndValidateArticle(parsed.data)
  validateCanonicalOrigin(article, config)
  if (path.basename(resolvedArticle, '.json') !== article.slug) {
    throw new ArticleValidationError(
      'ARTICLE_SLUG_MISMATCH',
      'The article slug must match the JSON filename.',
    )
  }
  return {article, articleBytes, articlePath: resolvedArticle, blogRoot}
}

async function inspectAssets(articleInfo) {
  const references = collectLocalAssetReferences(articleInfo.article)
  if (references.length === 0) return []

  const assetRoot = path.join(path.dirname(articleInfo.articlePath), 'assets')
  try {
    const rootInfo = await lstat(assetRoot)
    const resolvedRoot = await realpath(assetRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || resolvedRoot !== assetRoot) {
      throw new Error('unsafe asset root')
    }
  } catch {
    throw new ArticleValidationError(
      'ASSET_DIRECTORY_INVALID',
      'The article assets directory is missing or unsafe.',
    )
  }

  const assets = []
  let total = 0
  for (const {kind, relativePath} of references) {
    const filename = relativePath.slice('./assets/'.length)
    const candidate = path.join(assetRoot, filename)
    let info
    let resolved
    try {
      info = await lstat(candidate)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe asset')
      resolved = await realpath(candidate)
    } catch {
      throw new ArticleValidationError(
        'ASSET_FILE_INVALID',
        `A referenced local asset is missing or unsafe: ${filename}`,
      )
    }
    if (!isInside(assetRoot, resolved) || resolved !== candidate) {
      throw new ArticleValidationError(
        'ASSET_PATH_INVALID',
        `A referenced local asset escapes the assets directory: ${filename}`,
      )
    }
    const definition = assetDefinitionForFilename(filename)
    if (!definition || definition.kind !== kind) {
      throw new ArticleValidationError(
        'ASSET_FORMAT_INVALID',
        `Unsupported or mismatched local ${kind} extension: ${filename}`,
      )
    }
    if (info.size <= 0 || info.size > definition.maxBytes) {
      throw new ArticleValidationError(
        'ASSET_SIZE_INVALID',
        `A local ${kind} is empty or exceeds ${definition.maxBytes} bytes: ${filename}`,
      )
    }
    const bytes = await readFile(resolved)
    if (bytes.length !== info.size || bytes.length > definition.maxBytes) {
      throw new ArticleValidationError('ASSET_CHANGED', `A local asset changed: ${filename}`)
    }
    if (!hasAssetSignature(bytes, definition)) {
      throw new ArticleValidationError(
        'ASSET_FORMAT_INVALID',
        `Asset bytes do not match the extension: ${filename}`,
      )
    }
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) {
      throw new ArticleValidationError(
        'REQUEST_SIZE_EXCEEDED',
        `The local assets exceed ${MAX_TOTAL_BYTES} bytes.`,
      )
    }
    assets.push({
      kind,
      filename,
      mimeType: definition.mimeType,
      bytes: Buffer.from(bytes),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return assets
}

export async function prepareArticleSnapshot(articlePath, {config} = {}) {
  if (!config?.workspaceRoot) {
    throw new ArticleValidationError(
      'WORKSPACE_ROOT_REQUIRED',
      'A fixed configured workspace root is required.',
    )
  }
  const articleInfo = await inspectArticleFile(articlePath, config)
  const assets = await inspectAssets(articleInfo)
  const article = deepFreeze(structuredClone(articleInfo.article))
  const contentHash = createHash('sha256')
  contentHash.update('article\0')
  contentHash.update(articleInfo.articleBytes)
  for (const asset of [...assets].sort((left, right) => left.filename.localeCompare(right.filename))) {
    contentHash.update('\0asset\0')
    contentHash.update(asset.filename)
    contentHash.update('\0')
    contentHash.update(asset.sha256)
  }
  const contentSha256 = contentHash.digest('hex')
  const assetCounts = countAssetsByKind(assets)
  const state = {
    article,
    articleBytes: Buffer.from(articleInfo.articleBytes),
    articlePath: articleInfo.articlePath,
    assets,
  }
  const snapshot = Object.freeze({
    article,
    articlePath: articleInfo.articlePath,
    slug: article.slug,
    template: resolveBlogTemplate(article.template),
    sha256: createHash('sha256').update(articleInfo.articleBytes).digest('hex'),
    contentSha256,
    localImageCount: assetCounts.image,
    localAssetCount: assets.length,
    assetCounts,
    totalAssetBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
  })
  snapshotState.set(snapshot, state)
  return snapshot
}

export function materializeArticleRequest(
  snapshot,
  {forUpdate = false, createPublishedAt} = {},
) {
  const state = snapshotState.get(snapshot)
  if (!state) {
    throw new ArticleValidationError('ARTICLE_SNAPSHOT_INVALID', 'The article snapshot is invalid.')
  }
  const requestArticle = structuredClone(state.article)
  if (forUpdate) delete requestArticle.publishedAt
  if (createPublishedAt !== undefined) {
    if (
      typeof createPublishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createPublishedAt) ||
      Number.isNaN(Date.parse(createPublishedAt))
    ) {
      throw new ArticleValidationError(
        'ARTICLE_PUBLISHED_AT_INVALID',
        'The create publication timestamp must be a valid ISO UTC timestamp.',
      )
    }
    requestArticle.publishedAt = createPublishedAt
  }
  const articleBytes = Buffer.from(`${JSON.stringify(requestArticle)}\n`, 'utf8')
  const immutableArticle = deepFreeze(requestArticle)
  if (state.assets.length === 0) {
    return {
      article: immutableArticle,
      body: articleBytes,
      headers: {'Content-Type': 'application/json'},
      localImageCount: 0,
      localAssetCount: 0,
      assetCounts: countAssetsByKind([]),
    }
  }
  const body = new FormData()
  body.append(
    'article',
    new Blob([articleBytes], {type: 'application/json'}),
    path.basename(state.articlePath),
  )
  for (const asset of state.assets) {
    body.append('assets', new Blob([asset.bytes], {type: asset.mimeType}), asset.filename)
  }
  return {
    article: immutableArticle,
    body,
    headers: {},
    localImageCount: snapshot.localImageCount,
    localAssetCount: snapshot.localAssetCount,
    assetCounts: snapshot.assetCounts,
  }
}

export function describeArticleSnapshot(snapshot) {
  const state = snapshotState.get(snapshot)
  if (!state) {
    throw new ArticleValidationError('ARTICLE_SNAPSHOT_INVALID', 'The article snapshot is invalid.')
  }
  return {
    ok: true,
    valid: true,
    slug: snapshot.slug,
    articlePath: snapshot.articlePath,
    sha256: snapshot.sha256,
    contentSha256: snapshot.contentSha256,
    bodyBlocks: {
      en: snapshot.article.body.en.length,
      zh: snapshot.article.body.zh.length,
    },
    template: snapshot.template,
    localImageCount: snapshot.localImageCount,
    localAssetCount: snapshot.localAssetCount,
    assetCounts: snapshot.assetCounts,
    totalAssetBytes: snapshot.totalAssetBytes,
  }
}

export function cloneRequestArticle(snapshot, {forUpdate = false, createPublishedAt} = {}) {
  return structuredClone(
    materializeArticleRequest(snapshot, {forUpdate, createPublishedAt}).article,
  )
}

export function materializeArticlePreviewAssets(snapshot) {
  const state = snapshotState.get(snapshot)
  if (!state) {
    throw new ArticleValidationError('ARTICLE_SNAPSHOT_INVALID', 'The article snapshot is invalid.')
  }
  return state.assets.map((asset) => Object.freeze({
    sourcePath: `./assets/${asset.filename}`,
    filename: asset.filename,
    kind: asset.kind,
    mimeType: asset.mimeType,
    bytes: Buffer.from(asset.bytes),
    size: asset.size,
    sha256: asset.sha256,
  }))
}
