import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WORKSPACE_ROOT,
  validateConfigObject,
} from '../src/config.mjs'

test('legacy five-field configuration receives the MIYA workspace default', () => {
  const config = validateConfigObject({
    publisherApiOrigin: 'https://publisher.example.test',
    projectId: 'project1',
    dataset: 'production',
    apiVersion: '2026-07-05',
    sanityToken: 'secret-token',
  })
  assert.equal(config.workspaceRoot, DEFAULT_WORKSPACE_ROOT)
  assert.equal(config.sanityToken, 'secret-token')
  assert.equal(Object.keys(config).includes('sanityToken'), false)
})
