import {
  materializeContentRequest,
} from './content-article.mjs'
import {requireContentType} from './content-types.mjs'

const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 180_000
const MAX_ASSETS = 10
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
const SAFE_RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_IMAGE_ASSET_ID =
  /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-(?:jpg|jpeg|png|gif|webp|avif)$/iu
const SAFE_FILE_ASSET_ID =
  /^file-[A-Za-z0-9]+-(?:mp4|webm|pdf|txt|csv|docx|xlsx|pptx)$/iu

export class ContentPublisherApiError extends Error {
  constructor({
    statusCode,
    code = 'API_REQUEST_FAILED',
    requestId,
    uploadedAssetIds = [],
    resultUnknown = false,
  }) {
    super('The content publisher API request did not return a confirmed safe result.')
    this.name = 'ContentPublisherApiError'
    this.category = 'api'
    this.code = code
    this.retryable = false
    this.resultUnknown = Boolean(resultUnknown)
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
      this.statusCode = statusCode
    }
    if (requestId) this.requestId = requestId
    if (uploadedAssetIds.length > 0) this.uploadedAssetIds = uploadedAssetIds
  }
}

function doesNotContainSecret(value, token) {
  return typeof value === 'string' && !value.includes(token)
}

function validRequestId(value, token) {
  return (
    typeof value === 'string' &&
    SAFE_REQUEST_ID.test(value) &&
    doesNotContainSecret(value, token)
  )
}

function validResultId(value, token) {
  return (
    typeof value === 'string' &&
    SAFE_RESULT_ID.test(value) &&
    doesNotContainSecret(value, token)
  )
}

function validAssetId(value, token) {
  return (
    typeof value === 'string' &&
    (SAFE_IMAGE_ASSET_ID.test(value) || SAFE_FILE_ASSET_ID.test(value)) &&
    doesNotContainSecret(value, token)
  )
}

function validUploadedAssetIds(value, token) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ASSETS &&
    new Set(value).size === value.length &&
    value.every((assetId) => validAssetId(assetId, token))
  )
}

function safeUploadedAssetIds(payload, token) {
  const candidate = payload?.error?.details?.uploadedAssetIds
  if (!Array.isArray(candidate)) return []
  const sanitized = []
  for (const assetId of candidate) {
    if (
      validAssetId(assetId, token) &&
      !sanitized.includes(assetId)
    ) {
      sanitized.push(assetId)
    }
    if (sanitized.length === MAX_ASSETS) break
  }
  return sanitized
}

function safeErrorCode(value, token) {
  return (
    typeof value === 'string' &&
    SAFE_ERROR_CODE.test(value) &&
    doesNotContainSecret(value, token)
  )
    ? value
    : 'API_REQUEST_FAILED'
}

function normalizeOrigin(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    value.trim() !== value
  ) {
    throw new ContentPublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ContentPublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new ContentPublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
  }
  return url.origin
}

function endpoint(operation, config, contentType, slug) {
  const origin = normalizeOrigin(config.publisherApiOrigin)
  const encodedType = encodeURIComponent(requireContentType(contentType))
  if (operation === 'create-dry-run') {
    return `${origin}/v1/contents/${encodedType}?dryRun=true`
  }
  if (operation === 'create') return `${origin}/v1/contents/${encodedType}`
  const encodedSlug = encodeURIComponent(slug)
  if (operation === 'update-dry-run') {
    return `${origin}/v1/contents/${encodedType}/${encodedSlug}?dryRun=true`
  }
  if (operation === 'update') {
    return `${origin}/v1/contents/${encodedType}/${encodedSlug}`
  }
  throw new ContentPublisherApiError({code: 'OPERATION_INVALID'})
}

function targetFromConfig(config) {
  return {
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
  }
}

function targetMatches(candidate, expected) {
  return (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    candidate.projectId === expected.projectId &&
    candidate.dataset === expected.dataset &&
    candidate.apiVersion === expected.apiVersion
  )
}

async function readLimitedResponse(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ContentPublisherApiError({
          statusCode: response.status,
          code: 'API_RESPONSE_INVALID',
        })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof ContentPublisherApiError) throw error
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
  if (total === 0) {
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function parseResponse(response) {
  const text = await readLimitedResponse(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
}

function sanitizeSuccess({
  operation,
  payload,
  expectedContentType,
  expectedSlug,
  expectedTarget,
  expectedId,
  token,
}) {
  if (!payload || typeof payload !== 'object' || !validRequestId(payload.requestId, token)) {
    return undefined
  }
  const data = payload.data
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.contentType !== expectedContentType ||
    data.slug !== expectedSlug ||
    !targetMatches(data.target, expectedTarget) ||
    !validUploadedAssetIds(data.uploadedAssetIds, token)
  ) {
    return undefined
  }

  if (operation === 'create-dry-run') {
    if (data.status !== 'dry-run' || data.mode !== 'create') return undefined
    return {
      status: 'dry-run',
      mode: 'create',
      contentType: expectedContentType,
      slug: expectedSlug,
      requestId: payload.requestId,
      uploadedAssetIds: [...data.uploadedAssetIds],
      target: {...expectedTarget},
    }
  }

  if (operation === 'update-dry-run') {
    if (
      data.status !== 'dry-run' ||
      data.mode !== 'update' ||
      !validResultId(data.id, token) ||
      !validResultId(data.revision, token)
    ) {
      return undefined
    }
    return {
      status: 'dry-run',
      mode: 'update',
      contentType: expectedContentType,
      id: data.id,
      revision: data.revision,
      slug: expectedSlug,
      requestId: payload.requestId,
      uploadedAssetIds: [...data.uploadedAssetIds],
      target: {...expectedTarget},
    }
  }

  const expectedMode = operation === 'create' ? 'created' : 'updated'
  if (
    data.status !== 'published' ||
    data.mode !== expectedMode ||
    !validResultId(data.id, token) ||
    !validResultId(data.revision, token) ||
    (expectedId !== undefined && data.id !== expectedId)
  ) {
    return undefined
  }
  return {
    status: 'published',
    contentType: expectedContentType,
    id: data.id,
    revision: data.revision,
    slug: expectedSlug,
    requestId: payload.requestId,
    uploadedAssetIds: [...data.uploadedAssetIds],
    target: {...expectedTarget},
  }
}

export async function requestContent(
  operation,
  snapshot,
  {
    config,
    expectedRevision,
    expectedId,
    createPublishedAt,
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new ContentPublisherApiError({code: 'FETCH_UNAVAILABLE'})
  }
  const contentType = requireContentType(snapshot?.contentType)
  const request = materializeContentRequest(snapshot, {createPublishedAt})
  const slug = request.article.slug
  const forUpdate = operation === 'update-dry-run' || operation === 'update'
  const url = endpoint(operation, config, contentType, slug)
  const target = targetFromConfig(config)
  const headers = {
    ...request.headers,
    'X-Sanity-Project-Id': target.projectId,
    'X-Sanity-Dataset': target.dataset,
    'X-Sanity-Api-Version': target.apiVersion,
    'X-Sanity-Token': config.sanityToken,
  }
  if (operation === 'update') {
    if (
      typeof expectedRevision !== 'string' ||
      !SAFE_RESULT_ID.test(expectedRevision) ||
      !doesNotContainSecret(expectedRevision, config.sanityToken)
    ) {
      throw new ContentPublisherApiError({code: 'SANITY_REVISION_REQUIRED'})
    }
    if (!validResultId(expectedId, config.sanityToken)) {
      throw new ContentPublisherApiError({code: 'SANITY_ID_REQUIRED'})
    }
    headers['X-Sanity-If-Revision-Id'] = expectedRevision
  } else if (expectedRevision !== undefined || expectedId !== undefined) {
    throw new ContentPublisherApiError({code: 'SANITY_PRECONDITION_INVALID'})
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: forUpdate ? 'PUT' : 'POST',
      headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    const finalMutation = operation === 'create' || operation === 'update'
    throw new ContentPublisherApiError({
      code: finalMutation ? 'NETWORK_RESULT_UNKNOWN' : 'NETWORK_REQUEST_FAILED',
      resultUnknown: finalMutation,
    })
  }

  let payload
  try {
    payload = await parseResponse(response)
  } catch (error) {
    const finalMutation = operation === 'create' || operation === 'update'
    if (
      finalMutation &&
      response.ok &&
      error instanceof ContentPublisherApiError
    ) {
      throw new ContentPublisherApiError({
        statusCode: response.status,
        code: 'API_RESPONSE_INVALID',
        resultUnknown: true,
      })
    }
    throw error
  }
  if (!response.ok) {
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: safeErrorCode(payload?.error?.code, config.sanityToken),
      requestId: validRequestId(payload?.requestId, config.sanityToken)
        ? payload.requestId
        : undefined,
      uploadedAssetIds: safeUploadedAssetIds(payload, config.sanityToken),
      resultUnknown: false,
    })
  }

  const expectedStatus = operation === 'create' ? 201 : 200
  const sanitized = sanitizeSuccess({
    operation,
    payload,
    expectedContentType: contentType,
    expectedSlug: slug,
    expectedTarget: target,
    expectedId,
    token: config.sanityToken,
  })
  if (response.status !== expectedStatus || !sanitized) {
    throw new ContentPublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
      requestId: validRequestId(payload?.requestId, config.sanityToken)
        ? payload.requestId
        : undefined,
      resultUnknown: operation === 'create' || operation === 'update',
    })
  }
  return {article: request.article, result: sanitized}
}

export function isContentPublishConflict(error) {
  return (
    error instanceof ContentPublisherApiError &&
    error.statusCode === 409 &&
    error.code === 'PUBLISH_CONFLICT' &&
    error.resultUnknown === false
  )
}
