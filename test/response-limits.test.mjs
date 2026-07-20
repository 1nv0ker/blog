import assert from 'node:assert/strict'
import {rm} from 'node:fs/promises'
import test from 'node:test'

import {MAX_RESPONSE_BYTES} from '../src/article.mjs'
import {createBlogService} from '../src/service.mjs'
import {createArticleFixture} from './helpers.mjs'

const PREVIEW_REVISION = 'a'.repeat(64)

test('oversized API responses are rejected once without exposing their body', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const calls = []
  const oversized = JSON.stringify({data: 'x'.repeat(MAX_RESPONSE_BYTES + 1)})
  const service = createBlogService({
    loadConfigImpl: async () => fixture.config,
    previewRenderer: async () => ({previewRevision: PREVIEW_REVISION}),
    fetchImpl: async (url, options) => {
      calls.push({url, options})
      return new Response(oversized, {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    },
  })

  await assert.rejects(
    service.probeUpdate(fixture.articlePath, PREVIEW_REVISION),
    (error) =>
      error.code === 'API_RESPONSE_INVALID' &&
      !JSON.stringify(error).includes('xxxxx'),
  )
  assert.equal(calls.length, 1)
})
