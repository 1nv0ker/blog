import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {prepareContentSnapshot} from '../src/content-article.mjs'
import {
  ContentPublisherApiError,
  isContentPublishConflict,
  requestContent,
} from '../src/content-api.mjs'

function block(text) {
  return {
    _type: 'block',
    children: [{_type: 'span', text, marks: []}],
    markDefs: [],
  }
}

async function fixture(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'sanity-content-api-'))
  t.after(() => rm(workspaceRoot, {recursive: true, force: true}))
  const slug = 'api-example'
  const bundle = path.join(workspaceRoot, 'contents', 'guide', slug)
  await mkdir(path.join(bundle, 'assets'), {recursive: true})
  const articlePath = path.join(bundle, `${slug}.json`)
  await writeFile(
    articlePath,
    `${JSON.stringify({
      title: {en: 'API example', zh: '接口示例'},
      slug,
      excerpt: {en: 'An API example.', zh: '一个接口示例。'},
      body: {en: [block('English')], zh: [block('中文')]},
    })}\n`,
  )
  const config = {
    publisherApiOrigin: 'https://publisher.example.test',
    publicSiteOrigin: 'https://miyaip.com',
    workspaceRoot,
    projectId: 'exampleproject',
    dataset: 'production',
    apiVersion: '2026-07-05',
  }
  Object.defineProperty(config, 'sanityToken', {value: 'secret-token'})
  const snapshot = await prepareContentSnapshot('guide', articlePath, {config})
  return {config, snapshot}
}

function response({
  status = 200,
  contentType = 'guide',
  mode = 'create',
  state = status === 201 ? 'published' : 'dry-run',
  id,
  revision,
  uploadedAssetIds = [],
  requestId = 'request-1',
  errorCode,
  target = {
    projectId: 'exampleproject',
    dataset: 'production',
    apiVersion: '2026-07-05',
  },
} = {}) {
  const payload = errorCode
    ? {
        error: {
          code: errorCode,
          message: 'safe',
          details: {uploadedAssetIds},
        },
        requestId,
      }
    : {
        data: {
          status: state,
          mode,
          slug: 'api-example',
          contentType,
          ...(id ? {id} : {}),
          ...(revision ? {revision} : {}),
          uploadedAssetIds,
          target,
        },
        requestId,
      }
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

test('content request uses only generic create routes and validates contentType', async (t) => {
  const {config, snapshot} = await fixture(t)
  const calls = []
  const responses = [
    response({mode: 'create'}),
    response({
      status: 201,
      state: 'published',
      mode: 'created',
      id: 'document-id',
      revision: 'revision-1',
      uploadedAssetIds: ['file-uploaded-pdf'],
    }),
  ]
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    return responses.shift()
  }

  const dry = await requestContent('create-dry-run', snapshot, {
    config,
    fetchImpl,
    createPublishedAt: '2026-07-31T00:00:00.000Z',
  })
  const final = await requestContent('create', snapshot, {
    config,
    fetchImpl,
    createPublishedAt: '2026-07-31T00:00:00.000Z',
  })

  assert.equal(dry.result.contentType, 'guide')
  assert.equal(final.result.contentType, 'guide')
  assert.deepEqual(final.result.uploadedAssetIds, ['file-uploaded-pdf'])
  assert.deepEqual(calls.map(({url}) => url), [
    'https://publisher.example.test/v1/contents/guide?dryRun=true',
    'https://publisher.example.test/v1/contents/guide',
  ])
  assert.deepEqual(calls.map(({options}) => options.method), ['POST', 'POST'])
  assert.ok(calls.every(({options}) => options.redirect === 'error'))
  assert.ok(calls.every(({options}) => options.headers['X-Sanity-Token'] === 'secret-token'))
})

test('content update binds the dry-run revision to one guarded PUT', async (t) => {
  const {config, snapshot} = await fixture(t)
  const calls = []
  const responses = [
    response({mode: 'update', id: 'document-id', revision: 'revision-1'}),
    response({
      state: 'published',
      mode: 'updated',
      id: 'document-id',
      revision: 'revision-2',
    }),
  ]
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    return responses.shift()
  }

  const dry = await requestContent('update-dry-run', snapshot, {config, fetchImpl})
  await requestContent('update', snapshot, {
    config,
    fetchImpl,
    expectedId: dry.result.id,
    expectedRevision: dry.result.revision,
  })

  assert.deepEqual(calls.map(({url}) => url), [
    'https://publisher.example.test/v1/contents/guide/api-example?dryRun=true',
    'https://publisher.example.test/v1/contents/guide/api-example',
  ])
  assert.ok(calls.every(({options}) => options.method === 'PUT'))
  assert.equal(calls[0].options.headers['X-Sanity-If-Revision-Id'], undefined)
  assert.equal(calls[1].options.headers['X-Sanity-If-Revision-Id'], 'revision-1')
})

test('mismatched response types and unsafe final responses never become success', async (t) => {
  const {config, snapshot} = await fixture(t)
  await assert.rejects(
    requestContent('create', snapshot, {
      config,
      createPublishedAt: '2026-07-31T00:00:00.000Z',
      fetchImpl: async () =>
        response({
          status: 201,
          state: 'published',
          mode: 'created',
          contentType: 'tutorial',
          id: 'document-id',
          revision: 'revision-1',
        }),
    }),
    (error) =>
      error instanceof ContentPublisherApiError &&
      error.code === 'API_RESPONSE_INVALID' &&
      error.resultUnknown === true,
  )
})

test('an unreadable successful final response is unknown while a dry-run remains known', async (t) => {
  const {config, snapshot} = await fixture(t)
  await assert.rejects(
    requestContent('create', snapshot, {
      config,
      createPublishedAt: '2026-07-31T00:00:00.000Z',
      fetchImpl: async () =>
        new Response('{not-json', {
          status: 201,
          headers: {'content-type': 'application/json'},
        }),
    }),
    (error) =>
      error instanceof ContentPublisherApiError &&
      error.code === 'API_RESPONSE_INVALID' &&
      error.resultUnknown === true,
  )
  await assert.rejects(
    requestContent('create-dry-run', snapshot, {
      config,
      fetchImpl: async () =>
        new Response('{not-json', {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    }),
    (error) =>
      error instanceof ContentPublisherApiError &&
      error.code === 'API_RESPONSE_INVALID' &&
      error.resultUnknown === false,
  )
})

test('success receipts reject unsupported or duplicate uploaded asset IDs', async (t) => {
  const {config, snapshot} = await fixture(t)
  for (const uploadedAssetIds of [
    ['file-uploaded-exe'],
    ['file-uploaded-pdf', 'file-uploaded-pdf'],
    ['image-uploaded-1200x630-svg'],
  ]) {
    await assert.rejects(
      requestContent('create', snapshot, {
        config,
        createPublishedAt: '2026-07-31T00:00:00.000Z',
        fetchImpl: async () =>
          response({
            status: 201,
            state: 'published',
            mode: 'created',
            id: 'document-id',
            revision: 'revision-1',
            uploadedAssetIds,
          }),
      }),
      (error) =>
        error instanceof ContentPublisherApiError &&
        error.code === 'API_RESPONSE_INVALID' &&
        error.resultUnknown === true,
    )
  }
})

test('only a sanitized publish conflict enables conflict handling', async (t) => {
  const {config, snapshot} = await fixture(t)
  let caught
  try {
    await requestContent('create-dry-run', snapshot, {
      config,
      fetchImpl: async () =>
        response({
          status: 409,
          errorCode: 'PUBLISH_CONFLICT',
          requestId: 'conflict-request',
          uploadedAssetIds: ['file-retained-pdf', 'not-safe'],
        }),
    })
  } catch (error) {
    caught = error
  }
  assert.equal(isContentPublishConflict(caught), true)
  assert.deepEqual(caught.uploadedAssetIds, ['file-retained-pdf'])
  assert.equal(
    isContentPublishConflict(
      new ContentPublisherApiError({
        statusCode: 409,
        code: 'REVISION_CONFLICT',
      }),
    ),
    false,
  )
})
