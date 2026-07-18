import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEGACY_DEFAULT_WORKSPACE_ROOT,
  validateConfigObject,
} from '../src/config.mjs'
import {
  DEFAULT_PUBLISHER_API_ORIGIN,
  DEFAULT_SANITY_API_VERSION,
} from '../src/constants.mjs'
import {SafeError} from '../src/errors.mjs'

const legacyConfig = {
  publisherApiOrigin: DEFAULT_PUBLISHER_API_ORIGIN,
  projectId: 'project1',
  dataset: 'production',
  apiVersion: DEFAULT_SANITY_API_VERSION,
  sanityToken: 'secret-token',
}

test('legacy five-field configuration receives the original MIYA workspace default', () => {
  const config = validateConfigObject(legacyConfig)
  assert.equal(config.workspaceRoot, LEGACY_DEFAULT_WORKSPACE_ROOT)
  assert.equal(config.sanityToken, 'secret-token')
  assert.equal(Object.keys(config).includes('sanityToken'), false)
})

test('legacy managed overrides require reinitialization', () => {
  for (const candidate of [
    {...legacyConfig, publisherApiOrigin: 'https://unsupported.example.test'},
    {...legacyConfig, apiVersion: '2025-01-01'},
    {
      projectId: 'project1',
      dataset: 'production',
      sanityToken: 'secret-token',
      workspaceRoot: LEGACY_DEFAULT_WORKSPACE_ROOT,
    },
  ]) {
    assert.throws(
      () => validateConfigObject(candidate),
      (error) => error instanceof SafeError && error.code === 'LEGACY_CONFIG_REQUIRES_REINIT',
    )
  }
})
