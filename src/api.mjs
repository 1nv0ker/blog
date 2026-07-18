import {
  MAX_ASSETS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  materializeArticleRequest,
} from './article.mjs'

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
const SAFE_RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_ASSET_ID = /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-[A-Za-z0-9]+$/u

export class PublisherApiError extends Error {
  constructor({
    statusCode,
    code = 'API_REQUEST_FAILED',
    requestId,
    uploadedAssetIds = [],
    resultUnknown = false,
  }) {
    super('The publisher API request did not return a confirmed safe result.')
    this.name = 'PublisherApiError'
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

function validUploadedAssetIds(value, token) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ASSETS &&
    value.every(
      (assetId) =>
        typeof assetId === 'string' &&
        SAFE_ASSET_ID.test(assetId) &&
        doesNotContainSecret(assetId, token),
    )
  )
}

function safeUploadedAssetIds(payload, token) {
  const candidate = payload?.error?.details?.uploadedAssetIds
  if (!Array.isArray(candidate)) return []
  return candidate
    .filter(
      (assetId) =>
        typeof assetId === 'string' &&
        SAFE_ASSET_ID.test(assetId) &&
        doesNotContainSecret(assetId, token),
    )
    .slice(0, MAX_ASSETS)
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
    throw new PublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new PublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
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
    throw new PublisherApiError({code: 'PUBLISHER_ORIGIN_INVALID'})
  }
  return url.origin
}

function endpoint(operation, config, slug) {
  const origin = normalizeOrigin(config.publisherApiOrigin)
  if (operation === 'create-dry-run') return `${origin}/v1/blog-posts?dryRun=true`
  if (operation === 'create') return `${origin}/v1/blog-posts`
  if (operation === 'update-dry-run') {
    return `${origin}/v1/blog-posts/${encodeURIComponent(slug)}?dryRun=true`
  }
  if (operation === 'update') return `${origin}/v1/blog-posts/${encodeURIComponent(slug)}`
  throw new PublisherApiError({code: 'OPERATION_INVALID'})
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
    candidate.projectId === expected.projectId &&
    candidate.dataset === expected.dataset &&
    candidate.apiVersion === expected.apiVersion
  )
}

async function readLimitedResponse(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new PublisherApiError({
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
        throw new PublisherApiError({
          statusCode: response.status,
          code: 'API_RESPONSE_INVALID',
        })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof PublisherApiError) throw error
    throw new PublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
  if (total === 0) {
    throw new PublisherApiError({
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
    throw new PublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
    })
  }
}

function sanitizeSuccess({
  operation,
  payload,
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
    id: data.id,
    revision: data.revision,
    slug: expectedSlug,
    requestId: payload.requestId,
    uploadedAssetIds: [...data.uploadedAssetIds],
    target: {...expectedTarget},
  }
}

export async function requestArticle(
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
    throw new PublisherApiError({code: 'FETCH_UNAVAILABLE'})
  }
  const forUpdate = operation === 'update-dry-run' || operation === 'update'
  const request = materializeArticleRequest(snapshot, {forUpdate, createPublishedAt})
  const url = endpoint(operation, config, request.article.slug)
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
      throw new PublisherApiError({code: 'SANITY_REVISION_REQUIRED'})
    }
    if (!validResultId(expectedId, config.sanityToken)) {
      throw new PublisherApiError({code: 'SANITY_ID_REQUIRED'})
    }
    headers['X-Sanity-If-Revision-Id'] = expectedRevision
  } else if (expectedRevision !== undefined || expectedId !== undefined) {
    throw new PublisherApiError({code: 'SANITY_PRECONDITION_INVALID'})
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
    throw new PublisherApiError({
      code: finalMutation ? 'NETWORK_RESULT_UNKNOWN' : 'NETWORK_REQUEST_FAILED',
      resultUnknown: finalMutation,
    })
  }

  const payload = await parseResponse(response)
  if (!response.ok) {
    throw new PublisherApiError({
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
    expectedSlug: request.article.slug,
    expectedTarget: target,
    expectedId,
    token: config.sanityToken,
  })
  if (response.status !== expectedStatus || !sanitized) {
    throw new PublisherApiError({
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

export function isPublishConflict(error) {
  return (
    error instanceof PublisherApiError &&
    error.statusCode === 409 &&
    error.code === 'PUBLISH_CONFLICT' &&
    error.resultUnknown === false
  )
}
