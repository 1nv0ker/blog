import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkConfig,
  checkContentConfig,
  getConfigPaths,
  initializeConfig,
  validateConfigObject,
} from '../src/config.mjs'
import {
  contentConfigurationSetupSummary,
  createConfigurationSetupLauncher,
} from '../src/config-setup.mjs'
import {DEFAULT_PUBLIC_SITE_ORIGIN} from '../src/constants.mjs'

const noopAcl = async () => {}

function input(overrides = {}) {
  return {
    publisherApiOrigin: 'https://publisher.example.test',
    projectId: 'exampleproject',
    dataset: 'production',
    sanityToken: 'secret-token',
    ...overrides,
  }
}

test('content configuration defaults publicSiteOrigin without changing blog summaries', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sanity-content-config-'))
  t.after(() => rm(homeDir, {recursive: true, force: true}))

  const validated = validateConfigObject(input(), {homeDir})
  assert.equal(validated.publicSiteOrigin, DEFAULT_PUBLIC_SITE_ORIGIN)

  await initializeConfig(input(), {homeDir, platform: 'win32', acl: noopAcl})
  const disk = JSON.parse(await readFile(getConfigPaths(homeDir).configPath, 'utf8'))
  assert.equal(Object.hasOwn(disk, 'publicSiteOrigin'), false)

  const blogSummary = await checkConfig({homeDir, platform: 'win32', acl: noopAcl})
  assert.equal(Object.hasOwn(blogSummary, 'publicSiteOrigin'), false)
  const contentSummary = await checkContentConfig({
    homeDir,
    platform: 'win32',
    acl: noopAcl,
  })
  assert.equal(contentSummary.publicSiteOrigin, DEFAULT_PUBLIC_SITE_ORIGIN)
  assert.equal(JSON.stringify(contentSummary).includes('secret-token'), false)
})

test('content configuration persists and validates a custom public site origin', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sanity-content-origin-'))
  t.after(() => rm(homeDir, {recursive: true, force: true}))

  await initializeConfig(input({publicSiteOrigin: 'https://content.example.test'}), {
    homeDir,
    platform: 'win32',
    acl: noopAcl,
  })
  const summary = await checkContentConfig({
    homeDir,
    platform: 'win32',
    acl: noopAcl,
  })
  assert.equal(summary.publicSiteOrigin, 'https://content.example.test')

  for (const publicSiteOrigin of [
    'http://content.example.test',
    'https://content.example.test/path',
    'https://user:pass@content.example.test',
    'https://content.example.test/',
  ]) {
    assert.throws(
      () => validateConfigObject(input({publicSiteOrigin}), {homeDir}),
      (error) => error.code === 'INVALID_CONFIG',
    )
  }
})

test('content setup has a distinct five-field command and safe summary', async () => {
  const launcher = createConfigurationSetupLauncher({
    platform: 'linux',
    execPath: '/usr/bin/node',
    cliPath: '/plugin/dist/cli.mjs',
    homeDir: '/tmp/home',
    setupMode: 'content',
  })
  const launched = await launcher.start()
  assert.deepEqual(launched.manualCommand, {
    command: '/usr/bin/node',
    args: ['/plugin/dist/cli.mjs', '--init-content'],
  })

  const summary = contentConfigurationSetupSummary(launched)
  assert.equal(summary.configurationFieldCount, 5)
  assert.deepEqual(summary.configurationFields, [
    'publisherApiOrigin',
    'projectId',
    'dataset',
    'sanityToken',
    'publicSiteOrigin',
  ])
  assert.equal(summary.defaults.publicSiteOrigin, DEFAULT_PUBLIC_SITE_ORIGIN)
  assert.equal(JSON.stringify(summary).toLowerCase().includes('token-value'), false)
})
