import path from 'node:path'
import {TextDecoder} from 'node:util'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_LOCAL_ASSETS = 10
export const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024

export const SAFE_LOCAL_ASSET_PATH =
  /^\.\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u
export const SAFE_LEGACY_IMAGE_ASSET_REF =
  /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-[A-Za-z0-9]+$/u
export const SAFE_IMAGE_ASSET_REF =
  /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-(?:jpg|jpeg|png|gif|webp|avif)$/iu
export const SAFE_VIDEO_ASSET_REF =
  /^file-[A-Za-z0-9]+-(?:mp4|webm)$/iu
export const SAFE_ATTACHMENT_ASSET_REF =
  /^file-[A-Za-z0-9]+-(?:pdf|txt|csv|docx|xlsx|pptx)$/iu
export const SAFE_UPLOADED_ASSET_ID =
  /^(?:image-[A-Za-z0-9]+-[0-9]+x[0-9]+-[A-Za-z0-9]+|file-[A-Za-z0-9]+-(?:mp4|webm|pdf|txt|csv|docx|xlsx|pptx))$/iu

const FORMATS = new Map([
  ['.avif', {kind: 'image', format: 'avif', mimeType: 'image/avif'}],
  ['.gif', {kind: 'image', format: 'gif', mimeType: 'image/gif'}],
  ['.jpeg', {kind: 'image', format: 'jpeg', mimeType: 'image/jpeg'}],
  ['.jpg', {kind: 'image', format: 'jpeg', mimeType: 'image/jpeg'}],
  ['.png', {kind: 'image', format: 'png', mimeType: 'image/png'}],
  ['.webp', {kind: 'image', format: 'webp', mimeType: 'image/webp'}],
  ['.mp4', {kind: 'video', format: 'mp4', mimeType: 'video/mp4'}],
  ['.webm', {kind: 'video', format: 'webm', mimeType: 'video/webm'}],
  ['.pdf', {kind: 'attachment', format: 'pdf', mimeType: 'application/pdf'}],
  ['.txt', {kind: 'attachment', format: 'txt', mimeType: 'text/plain'}],
  ['.csv', {kind: 'attachment', format: 'csv', mimeType: 'text/csv'}],
  [
    '.docx',
    {
      kind: 'attachment',
      format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ],
  [
    '.xlsx',
    {
      kind: 'attachment',
      format: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  ],
  [
    '.pptx',
    {
      kind: 'attachment',
      format: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  ],
])

const LIMITS = Object.freeze({
  image: MAX_IMAGE_BYTES,
  video: MAX_VIDEO_BYTES,
  attachment: MAX_ATTACHMENT_BYTES,
})

export function assetDefinitionForFilename(filename) {
  const definition = FORMATS.get(path.extname(filename).toLowerCase())
  return definition
    ? Object.freeze({...definition, maxBytes: LIMITS[definition.kind]})
    : undefined
}

function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    return true
  } catch {
    return false
  }
}

function hasImageSignature(bytes, format) {
  if (format === 'png') {
    return bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  }
  if (format === 'jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  const ascii = bytes.subarray(0, 64).toString('ascii')
  if (format === 'gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')
  if (format === 'webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
  if (format === 'avif') {
    return ascii.slice(4, 8) === 'ftyp' && /avif|avis/u.test(ascii.slice(8))
  }
  return false
}

function hasVideoSignature(bytes, format) {
  if (format === 'mp4') {
    if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false
    return new Set([
      'isom',
      'iso2',
      'iso3',
      'iso4',
      'iso5',
      'iso6',
      'iso8',
      'iso9',
      'mp41',
      'mp42',
      'avc1',
      'dash',
      'MSNV',
    ]).has(bytes.subarray(8, 12).toString('ascii'))
  }
  return (
    format === 'webm' &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, 4096).toString('latin1').toLowerCase().includes('webm')
  )
}

function hasAttachmentSignature(bytes, format) {
  if (format === 'pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  if (format === 'txt' || format === 'csv') return isUtf8Text(bytes)
  const zipSignature = bytes.subarray(0, 4)
  if (
    !zipSignature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    !zipSignature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  ) {
    return false
  }
  const archiveIndex = bytes.toString('latin1')
  if (!archiveIndex.includes('[Content_Types].xml')) return false
  if (format === 'docx') return archiveIndex.includes('word/')
  if (format === 'xlsx') return archiveIndex.includes('xl/')
  if (format === 'pptx') return archiveIndex.includes('ppt/')
  return false
}

export function hasAssetSignature(bytes, definition) {
  if (definition?.kind === 'image') return hasImageSignature(bytes, definition.format)
  if (definition?.kind === 'video') return hasVideoSignature(bytes, definition.format)
  if (definition?.kind === 'attachment') {
    return hasAttachmentSignature(bytes, definition.format)
  }
  return false
}

function appendSource(values, kind, source, location) {
  if (source && (typeof source.path === 'string' || typeof source.assetRef === 'string')) {
    values.push({kind, source, location})
  }
}

export function collectBlogAssetSources(article) {
  const values = []
  appendSource(values, 'image', article?.coverImage?.source, 'coverImage.source')

  for (const locale of ['en', 'zh']) {
    for (const [index, item] of (article?.body?.[locale] ?? []).entries()) {
      const location = `body.${locale}.${index}`
      if (item?._type === 'image') {
        appendSource(values, 'image', item.source, `${location}.source`)
      } else if (item?._type === 'video') {
        if (item.sourceType === 'upload') {
          appendSource(values, 'video', item.source, `${location}.source`)
        }
        appendSource(values, 'image', item.poster?.source, `${location}.poster.source`)
      } else if (item?._type === 'attachment') {
        appendSource(values, 'attachment', item.source, `${location}.source`)
      } else if (item?._type === 'mediaText') {
        appendSource(values, 'image', item.image?.source, `${location}.image.source`)
      } else if (item?._type === 'tutorialSteps') {
        for (const [stepIndex, step] of (item.steps ?? []).entries()) {
          appendSource(
            values,
            'image',
            step?.image?.source,
            `${location}.steps.${stepIndex}.image.source`,
          )
        }
      }
    }
  }

  appendSource(
    values,
    'image',
    article?.seo?.openGraph?.image?.source,
    'seo.openGraph.image.source',
  )
  return values
}

export function countAssetsByKind(assets) {
  const counts = {image: 0, video: 0, attachment: 0}
  for (const asset of assets) {
    if (Object.hasOwn(counts, asset.kind)) counts[asset.kind] += 1
  }
  return Object.freeze(counts)
}
