import assert from 'node:assert/strict'
import {rm, writeFile} from 'node:fs/promises'
import test from 'node:test'

import {createBlogService} from '../src/service.mjs'
import {createArticleFixture, makeArticle, responsePayload} from './helpers.mjs'

const ACCEPTED_PREVIEW_REVISION = 'a'.repeat(64)

function queuedFetch(responses, calls) {
  return async (url, options) => {
    calls.push({url, options})
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(url, options)
    if (!next) throw new Error('Unexpected fetch call')
    return next
  }
}

function serviceFor(fixture, {
  responses,
  calls = [],
  records = [],
  recordError,
  realPreview = false,
} = {}) {
  const previewRenderer = async () => ({
    ok: true,
    previewRevision: ACCEPTED_PREVIEW_REVISION,
  })
  return {
    calls,
    records,
    service: createBlogService({
      loadConfigImpl: async () => fixture.config,
      checkConfigImpl: async () => ({configured: true}),
      fetchImpl: queuedFetch(responses, calls),
      ...(realPreview ? {} : {previewRenderer}),
      clock: () => new Date('2026-07-18T12:00:00.000Z'),
      recordWriter: async (entry) => {
        if (recordError) throw recordError
        records.push(entry)
        return {recordPath: `C:\\records\\${entry.result.slug}.json`}
      },
    }),
  }
}

test('publish creates with one dry-run and one final POST from one timestamped snapshot', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {
    responses: [
      responsePayload({mode: 'create', requestId: 'dry-create'}),
      responsePayload({
        status: 201,
        mode: 'created',
        id: 'document-1',
        revision: 'revision-1',
        requestId: 'final-create',
      }),
    ],
  })

  const result = await setup.service.publish(
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )
  assert.equal(result.operation, 'created')
  assert.equal(result.recordPath, 'C:\\records\\example-post.json')
  assert.equal(setup.calls.length, 2)
  assert.deepEqual(setup.calls.map((call) => call.options.method), ['POST', 'POST'])
  assert.deepEqual(setup.calls.map((call) => call.url), [
    'https://publisher.example.test/v1/blog-posts?dryRun=true',
    'https://publisher.example.test/v1/blog-posts',
  ])
  const dryArticle = JSON.parse(setup.calls[0].options.body.toString('utf8'))
  const finalArticle = JSON.parse(setup.calls[1].options.body.toString('utf8'))
  assert.equal(dryArticle.publishedAt, '2026-07-18T12:00:00.000Z')
  assert.deepEqual(finalArticle, dryArticle)
  assert.equal(setup.records.length, 1)
  assert.deepEqual(setup.records[0].article, finalArticle)
  assert.equal(setup.records[0].operation, 'created')
})

test('request layer rejects non-canonical publisher origins before fetch', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  for (const publisherApiOrigin of [
    'http://publisher.example.test',
    'https://publisher.example.test/',
    'https://publisher.example.test:443',
    'https://USER@publisher.example.test',
  ]) {
    const calls = []
    const service = createBlogService({
      loadConfigImpl: async () => ({...fixture.config, publisherApiOrigin}),
      previewRenderer: async () => ({previewRevision: ACCEPTED_PREVIEW_REVISION}),
      fetchImpl: async (url, options) => {
        calls.push({url, options})
        throw new Error('fetch must not run')
      },
    })
    await assert.rejects(
      service.probePublish(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
      (error) => error.code === 'PUBLISHER_ORIGIN_INVALID',
    )
    assert.equal(calls.length, 0)
  }
})

test('publish falls back only after a sanitized conflict and binds update id/revision', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {
    responses: [
      responsePayload({status: 409, errorCode: 'PUBLISH_CONFLICT'}),
      responsePayload({
        mode: 'update',
        id: 'document-1',
        revision: 'revision-1',
        requestId: 'dry-update',
      }),
      responsePayload({
        mode: 'updated',
        id: 'document-1',
        revision: 'revision-2',
        requestId: 'final-update',
      }),
    ],
  })

  const result = await setup.service.publish(
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )
  assert.equal(result.operation, 'updated')
  assert.deepEqual(setup.calls.map((call) => call.options.method), ['POST', 'PUT', 'PUT'])
  assert.equal(
    setup.calls[2].options.headers['X-Sanity-If-Revision-Id'],
    'revision-1',
  )
  const dryUpdateArticle = JSON.parse(setup.calls[1].options.body.toString('utf8'))
  const finalUpdateArticle = JSON.parse(setup.calls[2].options.body.toString('utf8'))
  assert.equal('publishedAt' in dryUpdateArticle, false)
  assert.deepEqual(finalUpdateArticle, dryUpdateArticle)
  assert.equal(setup.records[0].operation, 'updated')
  assert.equal('publishedAt' in setup.records[0].article, false)
})

test('strict update performs only PUT dry-run plus one guarded PUT and never creates', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {
    responses: [
      responsePayload({
        mode: 'update',
        id: 'document-2',
        revision: 'revision-before',
      }),
      responsePayload({
        mode: 'updated',
        id: 'document-2',
        revision: 'revision-after',
      }),
    ],
  })

  const result = await setup.service.update(
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )
  assert.equal(result.operation, 'updated')
  assert.deepEqual(setup.calls.map((call) => call.options.method), ['PUT', 'PUT'])
  assert.ok(setup.calls.every((call) => call.url.includes('/v1/blog-posts/example-post')))
  assert.equal(
    setup.calls[1].options.headers['X-Sanity-If-Revision-Id'],
    'revision-before',
  )
})

test('all local validation failures cause zero remote calls', async (t) => {
  const invalid = makeArticle()
  invalid.extra = 'rejected'
  const fixture = await createArticleFixture({article: invalid})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {responses: []})

  await assert.rejects(
    setup.service.publish(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) =>
      error.code === 'ARTICLE_SCHEMA_INVALID' &&
      Array.isArray(error.issues) &&
      error.issues.some((issue) => issue.code === 'unrecognized_keys'),
  )
  assert.equal(setup.calls.length, 0)
  assert.equal(setup.records.length, 0)
})

test('local preview validates and renders without any publisher API request', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(
    fixture.articlePath.replace(/\.json$/u, '.md'),
    '# English\n\nPreview body.\n\n# 中文\n\n预览正文。\n',
    'utf8',
  )
  const setup = serviceFor(fixture, {responses: [], realPreview: true})

  const result = await setup.service.preview(fixture.articlePath)

  assert.equal(result.approximate, true)
  assert.equal(result.markdownRendered, true)
  assert.equal(setup.calls.length, 0)
})

test('remote probes and mutations reject a stale accepted preview revision', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {responses: []})

  for (const operation of [
    () => setup.service.probePublish(fixture.articlePath, 'b'.repeat(64)),
    () => setup.service.probeUpdate(fixture.articlePath, 'b'.repeat(64)),
    () => setup.service.publish(fixture.articlePath, 'b'.repeat(64)),
    () => setup.service.update(fixture.articlePath, 'b'.repeat(64)),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error.code === 'PREVIEW_REVISION_MISMATCH',
    )
  }
  assert.equal(setup.calls.length, 0)
})

test('the real preview revision binds Markdown before any remote probe', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const markdownPath = fixture.articlePath.replace(/\.json$/u, '.md')
  await writeFile(markdownPath, '# Accepted\n\nOriginal preview.\n', 'utf8')
  const calls = []
  const service = createBlogService({
    loadConfigImpl: async () => fixture.config,
    fetchImpl: async (url, options) => {
      calls.push({url, options})
      throw new Error('fetch must not run for a stale preview')
    },
  })
  const accepted = await service.preview(fixture.articlePath)

  await writeFile(markdownPath, '# Changed\n\nNo longer accepted.\n', 'utf8')
  await assert.rejects(
    service.probeUpdate(fixture.articlePath, accepted.previewRevision),
    (error) => error.code === 'PREVIEW_REVISION_MISMATCH',
  )
  assert.equal(calls.length, 0)
})

test('target and document-id mismatches block records and are never retried', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const targetSetup = serviceFor(fixture, {
    responses: [
      responsePayload({mode: 'create'}),
      responsePayload({
        status: 201,
        mode: 'created',
        id: 'document-1',
        revision: 'revision-1',
        target: {
          projectId: 'wrong-project',
          dataset: 'production',
          apiVersion: '2026-07-05',
        },
      }),
    ],
  })
  await assert.rejects(
    targetSetup.service.publish(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) => error.code === 'API_RESPONSE_INVALID' && error.resultUnknown === true,
  )
  assert.equal(targetSetup.calls.length, 2)
  assert.equal(targetSetup.records.length, 0)

  const idSetup = serviceFor(fixture, {
    responses: [
      responsePayload({
        mode: 'update',
        id: 'document-expected',
        revision: 'revision-before',
      }),
      responsePayload({
        mode: 'updated',
        id: 'document-other',
        revision: 'revision-after',
      }),
    ],
  })
  await assert.rejects(
    idSetup.service.update(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) => error.code === 'API_RESPONSE_INVALID',
  )
  assert.equal(idSetup.calls.length, 2)
  assert.equal(idSetup.records.length, 0)
})

test('timeouts, rate limits, and final network uncertainty have zero automatic retries', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  const rateSetup = serviceFor(fixture, {
    responses: [responsePayload({status: 429, errorCode: 'RATE_LIMITED'})],
  })
  await assert.rejects(
    rateSetup.service.probeUpdate(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) => error.code === 'RATE_LIMITED' && error.retryable === false,
  )
  assert.equal(rateSetup.calls.length, 1)

  const unknownSetup = serviceFor(fixture, {
    responses: [
      responsePayload({mode: 'create'}),
      new Error('simulated timeout after dispatch'),
    ],
  })
  await assert.rejects(
    unknownSetup.service.publish(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) => error.code === 'NETWORK_RESULT_UNKNOWN' && error.resultUnknown === true,
  )
  assert.equal(unknownSetup.calls.length, 2)
  assert.equal(unknownSetup.records.length, 0)
})

test('confirmed remote success plus record failure reports partial success without retry', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const setup = serviceFor(fixture, {
    responses: [
      responsePayload({mode: 'create'}),
      responsePayload({
        status: 201,
        mode: 'created',
        id: 'document-1',
        revision: 'revision-1',
      }),
    ],
    recordError: new Error('simulated local disk failure'),
  })

  await assert.rejects(
    setup.service.publish(fixture.articlePath, ACCEPTED_PREVIEW_REVISION),
    (error) =>
      error.code === 'PUBLISHED_BUT_RECORD_WRITE_FAILED' &&
      error.remoteMutationSucceeded === true &&
      error.receipt?.id === 'document-1',
  )
  assert.equal(setup.calls.length, 2)
})

test('multipart requests preserve direct node fetch semantics and reject redirects', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const calls = []
  const setup = serviceFor(fixture, {
    calls,
    responses: [
      (_url, options) => {
        assert.ok(options.body instanceof FormData)
        assert.equal(options.redirect, 'error')
        assert.equal(options.headers['Content-Type'], undefined)
        return responsePayload({mode: 'create'})
      },
    ],
  })

  const result = await setup.service.probePublish(
    fixture.articlePath,
    ACCEPTED_PREVIEW_REVISION,
  )
  assert.equal(result.mode, 'create')
  assert.equal(calls.length, 1)
})
