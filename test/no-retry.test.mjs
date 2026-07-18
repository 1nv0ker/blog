import assert from 'node:assert/strict'
import {rm} from 'node:fs/promises'
import test from 'node:test'

import {createBlogService} from '../src/service.mjs'
import {createArticleFixture, responsePayload} from './helpers.mjs'

test('5xx and non-whitelisted 409 responses never retry or switch methods', async (t) => {
  const fixture = await createArticleFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  for (const response of [
    responsePayload({status: 503, errorCode: 'UPSTREAM_UNAVAILABLE'}),
    responsePayload({status: 409, errorCode: 'REVISION_CONFLICT'}),
  ]) {
    const calls = []
    const service = createBlogService({
      loadConfigImpl: async () => fixture.config,
      fetchImpl: async (url, options) => {
        calls.push({url, options})
        return response
      },
    })
    await assert.rejects(service.probePublish(fixture.articlePath))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.method, 'POST')
  }
})
