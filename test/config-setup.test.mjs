import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

import {
  CONFIGURATION_FIELDS,
  REQUIRED_CONFIGURATION_FIELDS,
  configurationSetupSummary,
  createConfigurationSetupLauncher,
  isReinitializableConfigurationError,
} from '../src/config-setup.mjs'
import {SafeError} from '../src/errors.mjs'
import {createBlogService} from '../src/service.mjs'

function configurationError(code) {
  return new SafeError({
    category: 'configuration',
    code,
    retryable: false,
    resultUnknown: false,
    safeMessage: 'Configuration requires attention.',
  })
}

test('configuration setup exposes four persisted fields and only reinitializes safe errors', () => {
  assert.deepEqual(CONFIGURATION_FIELDS, [
    'publisherApiOrigin',
    'projectId',
    'dataset',
    'sanityToken',
  ])
  assert.deepEqual(REQUIRED_CONFIGURATION_FIELDS, ['projectId', 'sanityToken'])

  for (const code of [
    'CONFIG_NOT_FOUND',
    'INVALID_CONFIG',
    'LEGACY_CONFIG_REQUIRES_REINIT',
  ]) {
    assert.equal(isReinitializableConfigurationError(configurationError(code)), true)
  }
  for (const code of [
    'UNSAFE_CONFIG_PATH',
    'UNSAFE_PERMISSIONS',
    'CONFIG_READ_FAILED',
    'CONFIG_TOO_LARGE',
  ]) {
    assert.equal(isReinitializableConfigurationError(configurationError(code)), false)
  }
})

test('Windows setup launches a separate PowerShell with a minimal environment', async () => {
  const calls = []
  let now = 1_000
  const secret = 'must-not-reach-setup-launcher'
  const unrelatedSecret = 'must-not-reach-child-environment'
  const launcher = createConfigurationSetupLauncher({
    platform: 'win32',
    execPath: 'C:\\plugin\\runtime\\node.exe',
    cliPath: 'C:\\plugin\\dist\\cli.mjs',
    homeDir: 'C:\\Users\\current-user',
    environment: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      NODE_OPTIONS: '--require C:\\malicious\\hook.cjs',
      OPENAI_API_KEY: unrelatedSecret,
      SANITY_BLOG_TOKEN: secret,
      SANITY_BLOG_PROJECT_ID: 'prefilled-project',
      SANITY_BLOG_SETUP_COMMAND: 'untrusted-existing-value',
    },
    clock: () => now,
    cooldownMs: 60_000,
    execFileImpl(command, args, options, callback) {
      calls.push({command, args, options})
      callback(null, '', '')
    },
  })

  assert.deepEqual(await launcher.start(), {setupStarted: true})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.timeout, 10_000)
  assert.equal(calls[0].options.env.SANITY_BLOG_TOKEN, undefined)
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined)
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined)
  assert.equal(calls[0].options.env.PATH, undefined)
  assert.equal(calls[0].options.env.SANITY_BLOG_SETUP_NODE, 'C:\\plugin\\runtime\\node.exe')
  assert.equal(calls[0].options.env.SANITY_BLOG_SETUP_CLI, 'C:\\plugin\\dist\\cli.mjs')
  assert.equal(calls[0].options.env.SANITY_BLOG_SETUP_CWD, 'C:\\plugin\\dist')
  assert.equal(calls[0].options.env.HOME, 'C:\\Users\\current-user')
  assert.equal(calls[0].options.env.USERPROFILE, 'C:\\Users\\current-user')
  assert.equal(calls[0].options.env.SANITY_BLOG_PROJECT_ID, undefined)

  const serializedCall = JSON.stringify(calls[0])
  assert.doesNotMatch(serializedCall, new RegExp(secret, 'u'))
  assert.doesNotMatch(serializedCall, new RegExp(unrelatedSecret, 'u'))
  const outerScript = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  const innerScript = Buffer.from(
    calls[0].options.env.SANITY_BLOG_SETUP_COMMAND,
    'base64',
  ).toString('utf16le')
  assert.match(outerScript, /Start-Process/u)
  assert.match(innerScript, /--init/u)
  assert.match(innerScript, /token input is hidden/u)

  assert.deepEqual(await launcher.start(), {
    setupStarted: false,
    setupAlreadyRunning: true,
    retryAfterSeconds: 60,
  })
  assert.equal(calls.length, 1)

  now += 60_000
  assert.deepEqual(await launcher.start(), {setupStarted: true})
  assert.equal(calls.length, 2)
})

test('non-Windows setup returns an interactive manual command without spawning', async () => {
  let execCount = 0
  const launcher = createConfigurationSetupLauncher({
    platform: 'linux',
    execPath: '/opt/sanityblog/node',
    cliPath: '/opt/sanityblog/dist/cli.mjs',
    homeDir: '/home/current-user',
    execFileImpl() {
      execCount += 1
    },
  })

  assert.deepEqual(await launcher.start(), {
    setupStarted: false,
    manualSetupRequired: true,
    reason: 'INTERACTIVE_TERMINAL_REQUIRED',
    manualCommand: {
      command: '/opt/sanityblog/node',
      args: ['/opt/sanityblog/dist/cli.mjs', '--init'],
    },
  })
  assert.equal(execCount, 0)
})

test('setup reports success only after the launcher exits successfully', async () => {
  let finishLaunch
  const launcher = createConfigurationSetupLauncher({
    platform: 'win32',
    execPath: 'C:\\plugin\\runtime\\node.exe',
    cliPath: 'C:\\plugin\\dist\\cli.mjs',
    homeDir: 'C:\\Users\\current-user',
    environment: {SystemRoot: 'C:\\Windows'},
    execFileImpl(_command, _args, _options, callback) {
      finishLaunch = callback
    },
  })

  const pending = launcher.start()
  const concurrent = launcher.start()
  finishLaunch(new Error('launcher failed before opening a window'))
  const expectedFailure = {
    setupStarted: false,
    manualSetupRequired: true,
    reason: 'SETUP_LAUNCH_FAILED',
    manualCommand: {
      command: 'C:\\plugin\\runtime\\node.exe',
      args: ['C:\\plugin\\dist\\cli.mjs', '--init'],
    },
  }
  assert.deepEqual(await pending, expectedFailure)
  assert.deepEqual(await concurrent, expectedFailure)
})

test(
  'generated Windows setup scripts parse as PowerShell',
  {skip: process.platform !== 'win32'},
  async () => {
    let capturedCall
    const launcher = createConfigurationSetupLauncher({
      platform: 'win32',
      execPath: 'C:\\plugin\\runtime\\node.exe',
      cliPath: 'C:\\plugin\\dist\\cli.mjs',
      homeDir: 'C:\\Users\\current-user',
      environment: {SystemRoot: 'C:\\Windows'},
      execFileImpl(command, args, options, callback) {
        capturedCall = {command, args, options}
        callback(null, '', '')
      },
    })
    await launcher.start()

    const sources = [
      Buffer.from(capturedCall.args.at(-1), 'base64').toString('utf16le'),
      Buffer.from(
        capturedCall.options.env.SANITY_BLOG_SETUP_COMMAND,
        'base64',
      ).toString('utf16le'),
    ]
    const parserScript = [
      '$tokens=$null;',
      '$errors=$null;',
      '[System.Management.Automation.Language.Parser]::ParseInput(',
      '$env:SANITYBLOG_SETUP_PARSE_SOURCE,',
      '[ref]$tokens,',
      '[ref]$errors',
      ') | Out-Null;',
      'if ($errors.Count -ne 0) {',
      '$errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) };',
      'exit 1',
      '}',
    ].join(' ')
    const encodedParser = Buffer.from(parserScript, 'utf16le').toString('base64')

    for (const source of sources) {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedParser],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SANITYBLOG_SETUP_PARSE_SOURCE: source,
          },
        },
      )
      assert.equal(result.status, 0, result.stderr)
    }
  },
)

test('setup summary reports defaults without exposing a token value', () => {
  const summary = configurationSetupSummary({setupStarted: true})
  assert.equal(summary.configurationFieldCount, 4)
  assert.deepEqual(summary.requiredFields, ['projectId', 'sanityToken'])
  assert.deepEqual(summary.defaults, {
    publisherApiOrigin: 'https://publish.miyaip.com',
    dataset: 'production',
  })
  assert.equal(Object.hasOwn(summary.defaults, 'sanityToken'), false)
})

test('service starts setup only for a reinitializable configuration error', async () => {
  let launchCount = 0
  const service = createBlogService({
    checkConfigImpl: async () => {
      throw configurationError('CONFIG_NOT_FOUND')
    },
    configurationSetupLauncher: {
      async start() {
        launchCount += 1
        return {setupStarted: true}
      },
    },
  })

  const result = await service.startConfigSetup()
  assert.equal(result.ok, true)
  assert.equal(result.configured, false)
  assert.equal(result.setupStarted, true)
  assert.equal(result.configurationFieldCount, 4)
  assert.equal(launchCount, 1)
})

test('service does not launch setup for unsafe configuration paths', async () => {
  let launchCount = 0
  const service = createBlogService({
    checkConfigImpl: async () => {
      throw configurationError('UNSAFE_CONFIG_PATH')
    },
    configurationSetupLauncher: {
      async start() {
        launchCount += 1
        return {setupStarted: true}
      },
    },
  })

  await assert.rejects(
    service.startConfigSetup(),
    (error) => error.code === 'UNSAFE_CONFIG_PATH',
  )
  assert.equal(launchCount, 0)
})

test('service skips setup when configuration is already valid', async () => {
  let launchCount = 0
  const service = createBlogService({
    checkConfigImpl: async () => ({
      configured: true,
      publisherApiOrigin: 'https://publisher.example.test',
      target: {
        projectId: 'project-id',
        dataset: 'production',
        apiVersion: '2026-07-05',
      },
    }),
    configurationSetupLauncher: {
      async start() {
        launchCount += 1
        return {setupStarted: true}
      },
    },
  })

  const result = await service.startConfigSetup()
  assert.equal(result.ok, true)
  assert.equal(result.configured, true)
  assert.equal(result.setupStarted, false)
  assert.equal(launchCount, 0)
})
