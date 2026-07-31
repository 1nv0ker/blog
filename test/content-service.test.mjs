import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {ContentPublisherApiError} from '../src/content-api.mjs'
import {createContentService} from '../src/content-service.mjs'
import {CONTENT_TYPE_IDS} from '../src/content-types.mjs'

const ACCEPTED_PREVIEW_REVISION = 'a'.repeat(64)
const STALE_PREVIEW_REVISION = 'b'.repeat(64)
const RESERVATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const TARGET = Object.freeze({
  projectId: 'exampleproject',
  dataset: 'production',
  apiVersion: '2026-07-05',
})

function block(text) {
  return {
    _type: 'block',
    style: 'normal',
    markDefs: [],
    children: [{_type: 'span', text, marks: []}],
  }
}

function articleFor(contentType, slug = 'service-example') {
  return {
    title: {en: 'Service example', zh: '服务示例'},
    slug,
    excerpt: {en: 'A service integration example.', zh: '服务集成示例。'},
    coverImage: null,
    body: {
      en: [block('English content.')],
      zh: [block('中文内容。')],
    },
    seo:
      contentType === 'blog-en'
        ? {
            title: {en: 'Service SEO', zh: '服务 SEO'},
            description: {
              en: 'Service SEO description.',
              zh: '服务 SEO 描述。',
            },
            canonicalUrl: {
              en: `https://miyaip.com/en/blog/${slug}`,
              zh: `https://miyaip.com/zh/blog/${slug}`,
            },
          }
        : null,
  }
}

async function contentFixture(t, contentType = 'guide') {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sanity-content-service-'),
  )
  t.after(() => rm(workspaceRoot, {recursive: true, force: true}))
  const slug = 'service-example'
  const bundlePath = path.join(
    workspaceRoot,
    'contents',
    contentType,
    slug,
  )
  await mkdir(path.join(bundlePath, 'assets'), {recursive: true})
  const articlePath = path.join(bundlePath, `${slug}.json`)
  await writeFile(
    articlePath,
    `${JSON.stringify(articleFor(contentType, slug))}\n`,
    'utf8',
  )
  const config = {
    publisherApiOrigin: 'https://publisher.example.test',
    publicSiteOrigin: 'https://miyaip.com',
    workspaceRoot,
    ...TARGET,
  }
  Object.defineProperty(config, 'sanityToken', {value: 'secret-token'})
  return {articlePath, config, contentType, slug, workspaceRoot}
}

function resultFor(operation, snapshot, overrides = {}) {
  const updateProbe = operation === 'update-dry-run'
  const finalMutation = operation === 'create' || operation === 'update'
  const result = {
    status: finalMutation ? 'published' : 'dry-run',
    contentType: snapshot.contentType,
    slug: snapshot.slug,
    requestId: `${operation}-request`,
    uploadedAssetIds: [],
    target: {...TARGET},
    ...(updateProbe || finalMutation
      ? {
          id: 'document-1',
          revision: finalMutation ? 'revision-after' : 'revision-before',
        }
      : {}),
    ...overrides,
  }
  if (!finalMutation) {
    result.mode = operation === 'create-dry-run' ? 'create' : 'update'
  }
  return {article: snapshot.article, result}
}

function setupService(
  fixture,
  {
    requestImpl,
    previewRevision = ACCEPTED_PREVIEW_REVISION,
    records = [],
    clock = () => new Date('2026-07-31T00:00:00.000Z'),
  } = {},
) {
  return {
    records,
    service: createContentService({
      loadConfigImpl: async () => fixture.config,
      previewRenderer: async (snapshot) => ({
        ok: true,
        contentType: snapshot.contentType,
        slug: snapshot.slug,
        previewRevision,
      }),
      requestImpl:
        requestImpl ??
        (async (operation, snapshot) => resultFor(operation, snapshot)),
      recordWriter: async (entry) => {
        records.push(entry)
        return {
          recordPath: path.join(
            fixture.workspaceRoot,
            'published',
            entry.contentType,
            `${entry.result.slug}.json`,
          ),
        }
      },
      clock,
    }),
  }
}

test('content service accepts exactly all six API 1.1 content types locally', async (t) => {
  for (const contentType of CONTENT_TYPE_IDS) {
    const fixture = await contentFixture(t, contentType)
    let remoteCalls = 0
    const service = createContentService({
      loadConfigImpl: async () => fixture.config,
      requestImpl: async () => {
        remoteCalls += 1
        throw new Error('validate must not make a remote request')
      },
    })

    const result = await service.validate(contentType, fixture.articlePath)
    assert.equal(result.ok, true)
    assert.equal(result.valid, true)
    assert.equal(result.contentType, contentType)
    assert.equal(result.slug, fixture.slug)
    assert.equal(remoteCalls, 0)
  }
})

test('unsupported content types are rejected before config, workspace, or network I/O', async () => {
  let configReads = 0
  let workspaceCalls = 0
  let remoteCalls = 0
  const workspace = {
    prepareContentPublish: async () => {
      workspaceCalls += 1
    },
    prepareContentUpdate: async () => {
      workspaceCalls += 1
    },
    commitContentReservation: async () => {
      workspaceCalls += 1
    },
    releaseContentReservation: async () => {
      workspaceCalls += 1
    },
  }
  const service = createContentService({
    loadConfigImpl: async () => {
      configReads += 1
      throw new Error('configuration must not be read')
    },
    requestImpl: async () => {
      remoteCalls += 1
      throw new Error('network must not be reached')
    },
    workspace,
  })
  const missingPath = path.resolve('contents', 'missing', 'missing.json')
  const operations = [
    (contentType) => service.preparePublish(contentType, 'service-example'),
    (contentType) => service.prepareUpdate(contentType, 'service-example'),
    (contentType) =>
      service.commit(contentType, 'service-example', RESERVATION_ID),
    (contentType) =>
      service.release(contentType, 'service-example', RESERVATION_ID),
    (contentType) => service.validate(contentType, missingPath),
    (contentType) => service.preview(contentType, missingPath),
    (contentType) =>
      service.probePublish(
        contentType,
        missingPath,
        ACCEPTED_PREVIEW_REVISION,
      ),
    (contentType) =>
      service.probeUpdate(
        contentType,
        missingPath,
        ACCEPTED_PREVIEW_REVISION,
      ),
    (contentType) =>
      service.publish(contentType, missingPath, ACCEPTED_PREVIEW_REVISION),
    (contentType) =>
      service.update(contentType, missingPath, ACCEPTED_PREVIEW_REVISION),
  ]

  for (const contentType of ['blog-post', 'unknown']) {
    for (const operation of operations) {
      await assert.rejects(
        operation(contentType),
        (error) =>
          error.code === 'CONTENT_TYPE_UNSUPPORTED' &&
          error.category === 'validation',
      )
    }
  }
  assert.equal(configReads, 0)
  assert.equal(workspaceCalls, 0)
  assert.equal(remoteCalls, 0)
})

test('publish performs one POST dry-run and one final POST with one create timestamp', async (t) => {
  const fixture = await contentFixture(t)
  const calls = []
  const setup = setupService(fixture, {
    requestImpl: async (operation, snapshot, options) => {
      calls.push({operation, options})
      return resultFor(operation, snapshot)
    },
  })

  const result = await setup.service.publish(
    fixture.contentType,
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )

  assert.equal(result.operation, 'created')
  assert.equal(result.contentType, fixture.contentType)
  assert.deepEqual(
    calls.map(({operation}) => operation),
    ['create-dry-run', 'create'],
  )
  assert.equal(
    calls[0].options.createPublishedAt,
    '2026-07-31T00:00:00.000Z',
  )
  assert.equal(
    calls[1].options.createPublishedAt,
    calls[0].options.createPublishedAt,
  )
  assert.equal(calls[1].options.expectedRevision, undefined)
  assert.equal(setup.records.length, 1)
  assert.equal(setup.records[0].contentType, fixture.contentType)
  assert.equal(setup.records[0].operation, 'created')
})

test('publish falls back only on a sanitized conflict and guards one final update', async (t) => {
  const fixture = await contentFixture(t, 'comparison')
  const calls = []
  const setup = setupService(fixture, {
    requestImpl: async (operation, snapshot, options) => {
      calls.push({operation, options})
      if (operation === 'create-dry-run') {
        throw new ContentPublisherApiError({
          statusCode: 409,
          code: 'PUBLISH_CONFLICT',
          resultUnknown: false,
        })
      }
      return resultFor(operation, snapshot)
    },
  })

  const result = await setup.service.publish(
    fixture.contentType,
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )

  assert.equal(result.operation, 'updated')
  assert.deepEqual(
    calls.map(({operation}) => operation),
    ['create-dry-run', 'update-dry-run', 'update'],
  )
  assert.equal(calls[2].options.expectedId, 'document-1')
  assert.equal(calls[2].options.expectedRevision, 'revision-before')
  assert.equal(
    calls.filter(({operation}) => operation === 'update').length,
    1,
  )
  assert.equal(setup.records.length, 1)
  assert.equal(setup.records[0].operation, 'updated')

  const rejectedCalls = []
  const rejected = setupService(fixture, {
    requestImpl: async (operation) => {
      rejectedCalls.push(operation)
      throw new ContentPublisherApiError({
        statusCode: 409,
        code: 'REVISION_CONFLICT',
        resultUnknown: false,
      })
    },
  })
  await assert.rejects(
    rejected.service.publish(
      fixture.contentType,
      fixture.articlePath,
      ACCEPTED_PREVIEW_REVISION,
    ),
    (error) => error.code === 'REVISION_CONFLICT',
  )
  assert.deepEqual(rejectedCalls, ['create-dry-run'])
})

test('strict update is PUT-only and binds the probed id and revision', async (t) => {
  const fixture = await contentFixture(t, 'tutorial')
  const calls = []
  const setup = setupService(fixture, {
    requestImpl: async (operation, snapshot, options) => {
      calls.push({operation, options})
      return resultFor(operation, snapshot)
    },
  })

  const result = await setup.service.update(
    fixture.contentType,
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )

  assert.equal(result.operation, 'updated')
  assert.deepEqual(
    calls.map(({operation}) => operation),
    ['update-dry-run', 'update'],
  )
  assert.ok(calls.every(({operation}) => !operation.startsWith('create')))
  assert.equal(calls[1].options.expectedId, 'document-1')
  assert.equal(calls[1].options.expectedRevision, 'revision-before')
  assert.equal(
    calls.filter(({operation}) => operation === 'update').length,
    1,
  )
})

test('stale preview revisions block every remote operation before any request', async (t) => {
  const fixture = await contentFixture(t, 'alternative')
  let remoteCalls = 0
  const setup = setupService(fixture, {
    requestImpl: async () => {
      remoteCalls += 1
      throw new Error('stale previews must not reach the network')
    },
  })
  const operations = [
    () =>
      setup.service.probePublish(
        fixture.contentType,
        fixture.articlePath,
        STALE_PREVIEW_REVISION,
      ),
    () =>
      setup.service.probeUpdate(
        fixture.contentType,
        fixture.articlePath,
        STALE_PREVIEW_REVISION,
      ),
    () =>
      setup.service.publish(
        fixture.contentType,
        fixture.articlePath,
        STALE_PREVIEW_REVISION,
      ),
    () =>
      setup.service.update(
        fixture.contentType,
        fixture.articlePath,
        STALE_PREVIEW_REVISION,
      ),
  ]

  for (const operation of operations) {
    await assert.rejects(
      operation(),
      (error) => error.code === 'PREVIEW_REVISION_MISMATCH',
    )
  }
  assert.equal(remoteCalls, 0)
  assert.equal(setup.records.length, 0)
})

test('a mismatched response contentType is rejected by the integrated request layer', async (t) => {
  const fixture = await contentFixture(t, 'guide')
  const calls = []
  const service = createContentService({
    loadConfigImpl: async () => fixture.config,
    previewRenderer: async () => ({
      ok: true,
      previewRevision: ACCEPTED_PREVIEW_REVISION,
    }),
    fetchImpl: async (url, options) => {
      calls.push({url, options})
      return new Response(
        JSON.stringify({
          data: {
            status: 'dry-run',
            mode: 'update',
            contentType: 'tutorial',
            slug: fixture.slug,
            id: 'document-1',
            revision: 'revision-before',
            uploadedAssetIds: [],
            target: {...TARGET},
          },
          requestId: 'mismatch-request',
        }),
        {
          status: 200,
          headers: {'content-type': 'application/json'},
        },
      )
    },
  })

  await assert.rejects(
    service.probeUpdate(
      fixture.contentType,
      fixture.articlePath,
      ACCEPTED_PREVIEW_REVISION,
    ),
    (error) =>
      error.code === 'API_RESPONSE_INVALID' &&
      error.category === 'api' &&
      error.resultUnknown === false,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'PUT')
  assert.match(calls[0].url, /\/v1\/contents\/guide\/service-example\?dryRun=true$/u)
})

test('final partial failure exposes only safe uploaded asset IDs and is never retried', async (t) => {
  const fixture = await contentFixture(t, 'solution')
  const calls = []
  const setup = setupService(fixture, {
    requestImpl: async (operation, snapshot) => {
      calls.push(operation)
      if (operation === 'create') {
        throw new ContentPublisherApiError({
          statusCode: 502,
          code: 'SANITY_OPERATION_FAILED',
          uploadedAssetIds: ['file-retained-pdf'],
          resultUnknown: false,
        })
      }
      return resultFor(operation, snapshot)
    },
  })

  await assert.rejects(
    setup.service.publish(
      fixture.contentType,
      fixture.articlePath,
      ACCEPTED_PREVIEW_REVISION,
    ),
    (error) =>
      error.code === 'SANITY_OPERATION_FAILED' &&
      error.resultUnknown === false &&
      error.uploadedAssetIds?.[0] === 'file-retained-pdf',
  )
  assert.deepEqual(calls, ['create-dry-run', 'create'])
  assert.equal(setup.records.length, 0)
})

test('confirmed remote success plus record failure returns a typed safe receipt without retry', async (t) => {
  const fixture = await contentFixture(t, 'alternative')
  const calls = []
  const service = createContentService({
    loadConfigImpl: async () => fixture.config,
    previewRenderer: async () => ({
      ok: true,
      previewRevision: ACCEPTED_PREVIEW_REVISION,
    }),
    requestImpl: async (operation, snapshot) => {
      calls.push(operation)
      return resultFor(operation, snapshot)
    },
    recordWriter: async () => {
      throw new Error('record storage unavailable')
    },
    clock: () => new Date('2026-07-31T00:00:00.000Z'),
  })

  await assert.rejects(
    service.publish(
      fixture.contentType,
      fixture.articlePath,
      ACCEPTED_PREVIEW_REVISION,
    ),
    (error) =>
      error.code === 'PUBLISHED_BUT_RECORD_WRITE_FAILED' &&
      error.remoteMutationSucceeded === true &&
      error.resultUnknown === false &&
      error.receipt?.contentType === fixture.contentType &&
      error.receipt?.operation === 'created',
  )
  assert.deepEqual(calls, ['create-dry-run', 'create'])
})
