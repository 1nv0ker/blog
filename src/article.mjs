import {createHash} from 'node:crypto'
import {lstat, readFile, realpath} from 'node:fs/promises'
import path from 'node:path'

import {z} from 'zod'

import {DEFAULT_PUBLIC_SITE_ORIGIN} from './constants.mjs'

export const MAX_ARTICLE_BYTES = 2 * 1024 * 1024
export const MAX_ASSET_BYTES = 20 * 1024 * 1024
export const MAX_ASSETS = 10
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 1024 * 1024
export const REQUEST_TIMEOUT_MS = 180_000

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_ASSET_PATH = /^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SAFE_ASSET_REF = /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-[A-Za-z0-9]+$/u
const SAFE_SUPPORTED_IMAGE_ASSET_REF =
  /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-(?:jpg|jpeg|png|gif|webp|avif)$/iu
const SAFE_KEY = /^[A-Za-z0-9_-]+$/u
const BUILTIN_MARKS = new Set(['strong', 'em', 'code'])

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

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
  if (value.startsWith('/') && !value.startsWith('//')) return true
  if (value.startsWith('#') || value.startsWith('./') || value.startsWith('../')) return true
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)
  } catch {
    return false
  }
}

const legacyImageSource = z.union([
  z.object({path: z.string().regex(SAFE_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_ASSET_REF)}).strict(),
])

const supportedImageSource = z.union([
  z.object({path: z.string().regex(SAFE_ASSET_PATH)}).strict(),
  z.object({assetRef: z.string().regex(SAFE_SUPPORTED_IMAGE_ASSET_REF)}).strict(),
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
    openInNewTab: z.boolean().optional(),
  })
  .strict()

const portableTextSpan = z
  .object({
    _type: z.literal('span'),
    _key: portableTextKey.optional(),
    text: z.string(),
    marks: z.array(z.string().min(1).max(128)).optional(),
  })
  .strict()

const portableTextBlock = z
  .object({
    _type: z.literal('block'),
    _key: portableTextKey.optional(),
    style: z.enum(['normal', 'h2', 'h3', 'blockquote']).optional(),
    listItem: z.enum(['bullet', 'number']).optional(),
    level: z.number().int().min(1).max(10).optional(),
    markDefs: z.array(portableTextLink).optional(),
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
    const markKeys = new Set((block.markDefs ?? []).map((definition) => definition._key).filter(Boolean))
    if (markKeys.size !== (block.markDefs ?? []).filter((definition) => definition._key).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['markDefs'],
        message: 'mark definition keys must be unique',
      })
    }
    for (const [childIndex, child] of block.children.entries()) {
      for (const mark of child.marks ?? []) {
        if (!BUILTIN_MARKS.has(mark) && !markKeys.has(mark)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['children', childIndex, 'marks'],
            message: 'mark must be built-in or reference markDefs',
          })
        }
      }
    }
  })

const portableTextImage = z
  .object({
    _type: z.literal('image'),
    _key: portableTextKey.optional(),
    source: legacyImageSource,
    alt: nonBlank(500),
    crop: imageCrop.optional(),
    hotspot: imageHotspot.optional(),
  })
  .strict()

const portableTextCode = z
  .object({
    _type: z.literal('code'),
    _key: portableTextKey.optional(),
    language: nonBlank(64).optional(),
    code: z.string(),
    highlightedLines: z.array(z.number().int().min(1)).max(10_000).optional(),
  })
  .strict()

const portableTextItem = z.union([
  portableTextBlock,
  portableTextImage,
  portableTextCode,
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

function hasImageSignature(bytes, extension) {
  if (extension === '.png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (extension === '.gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  if (extension === '.webp') {
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }
  if (extension === '.avif') {
    const box = bytes.subarray(0, 32).toString('ascii')
    return box.slice(4, 8) === 'ftyp' && /avif|avis/u.test(box.slice(8))
  }
  return false
}

function collectLocalAssetPaths(article) {
  const sources = [article.coverImage.source]
  for (const locale of ['en', 'zh']) {
    for (const item of article.body[locale]) {
      if (item._type === 'image') sources.push(item.source)
    }
  }
  if (article.seo.openGraph?.image) sources.push(article.seo.openGraph.image.source)
  const localPaths = new Map()
  for (const source of sources) {
    if (!('path' in source)) continue
    const identity = source.path.toLowerCase()
    const existing = localPaths.get(identity)
    if (existing !== undefined && existing !== source.path) {
      throw new ArticleValidationError(
        'ASSET_PATH_COLLISION',
        'Local image paths must be unique without case distinctions.',
      )
    }
    localPaths.set(identity, source.path)
  }
  if (localPaths.size > MAX_ASSETS) {
    throw new ArticleValidationError(
      'ASSET_COUNT_EXCEEDED',
      `An article may reference at most ${MAX_ASSETS} local images.`,
    )
  }
  return [...localPaths.values()]
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
  validateCanonicalOrigin(parsed.data, config)
  if (path.basename(resolvedArticle, '.json') !== parsed.data.slug) {
    throw new ArticleValidationError(
      'ARTICLE_SLUG_MISMATCH',
      'The article slug must match the JSON filename.',
    )
  }
  return {article: parsed.data, articleBytes, articlePath: resolvedArticle, blogRoot}
}

async function inspectAssets(articleInfo) {
  const localPaths = collectLocalAssetPaths(articleInfo.article)
  if (localPaths.length === 0) return []

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
  for (const relativePath of localPaths) {
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
        `A referenced local image is missing or unsafe: ${filename}`,
      )
    }
    if (!isInside(assetRoot, resolved) || resolved !== candidate) {
      throw new ArticleValidationError(
        'ASSET_PATH_INVALID',
        `A referenced local image escapes the assets directory: ${filename}`,
      )
    }
    if (info.size <= 0 || info.size > MAX_ASSET_BYTES) {
      throw new ArticleValidationError(
        'ASSET_SIZE_INVALID',
        `A local image is empty or exceeds ${MAX_ASSET_BYTES} bytes: ${filename}`,
      )
    }
    const extension = path.extname(filename).toLowerCase()
    const mimeType = MIME_TYPES.get(extension)
    if (!mimeType) {
      throw new ArticleValidationError(
        'ASSET_FORMAT_INVALID',
        `Unsupported local image extension: ${filename}`,
      )
    }
    const bytes = await readFile(resolved)
    if (bytes.length !== info.size || bytes.length > MAX_ASSET_BYTES) {
      throw new ArticleValidationError('ASSET_CHANGED', `A local image changed: ${filename}`)
    }
    if (!hasImageSignature(bytes, extension)) {
      throw new ArticleValidationError(
        'ASSET_FORMAT_INVALID',
        `Image bytes do not match the extension: ${filename}`,
      )
    }
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) {
      throw new ArticleValidationError(
        'REQUEST_SIZE_EXCEEDED',
        `The local images exceed ${MAX_TOTAL_BYTES} bytes.`,
      )
    }
    assets.push({
      filename,
      mimeType,
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
    sha256: createHash('sha256').update(articleInfo.articleBytes).digest('hex'),
    contentSha256,
    localImageCount: assets.length,
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
  const articleBytes = forUpdate || createPublishedAt !== undefined
    ? Buffer.from(`${JSON.stringify(requestArticle)}\n`, 'utf8')
    : Buffer.from(state.articleBytes)
  const immutableArticle = deepFreeze(requestArticle)
  if (state.assets.length === 0) {
    return {
      article: immutableArticle,
      body: articleBytes,
      headers: {'Content-Type': 'application/json'},
      localImageCount: 0,
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
    localImageCount: state.assets.length,
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
    localImageCount: snapshot.localImageCount,
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
    mimeType: asset.mimeType,
    bytes: Buffer.from(asset.bytes),
    sha256: asset.sha256,
  }))
}
