import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'

import {SafeError} from '../src/errors.mjs'
import {ArticleValidationError} from '../src/article.mjs'
import {createMcpServer} from '../src/server.mjs'
import {WorkspaceError} from '../src/workspace.mjs'

const EXPECTED_TOOLS = [
  'sanity_blog_check_config',
  'sanity_blog_start_config_setup',
  'sanity_blog_prepare_publish',
  'sanity_blog_prepare_update',
  'sanity_blog_validate',
  'sanity_blog_preview',
  'sanity_blog_probe_publish',
  'sanity_blog_probe_update',
  'sanity_blog_commit',
  'sanity_blog_release',
  'sanity_blog_publish',
  'sanity_blog_update',
]

function stubService(overrides = {}) {
  return {
    checkConfig: async () => ({
      ok: true,
      configured: true,
      publisherApiOrigin: 'https://publisher.example.test',
    }),
    startConfigSetup: async () => ({
      ok: true,
      configured: false,
      setupStarted: true,
      configurationFieldCount: 4,
    }),
    preparePublish: async (baseSlug) => ({ok: true, slug: baseSlug}),
    prepareUpdate: async (slug) => ({ok: true, slug}),
    validate: async () => ({ok: true, valid: true}),
    preview: async () => ({ok: true, approximate: true}),
    probePublish: async () => ({ok: true, mode: 'create'}),
    probeUpdate: async () => ({ok: true, mode: 'update'}),
    commit: async (slug) => ({ok: true, slug}),
    release: async (slug) => ({ok: true, slug, released: true}),
    publish: async () => ({ok: true, operation: 'created'}),
    update: async () => ({ok: true, operation: 'updated'}),
    ...overrides,
  }
}

async function connectedPair(service = stubService()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({service})
  const client = new Client(
    {name: 'sanityblog-test-client', version: '1.0.0'},
    {capabilities: {}},
  )
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {client, server}
}

test('MCP initializes and lists all strict tool schemas with annotations', async (t) => {
  const {client, server} = await connectedPair()
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const listed = await client.listTools()
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  )
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean')
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean')
    assert.equal(typeof tool.annotations?.idempotentHint, 'boolean')
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean')
  }
  const update = listed.tools.find((tool) => tool.name === 'sanity_blog_update')
  assert.equal(update.annotations.destructiveHint, true)
  assert.equal(update.annotations.openWorldHint, true)
  const setup = listed.tools.find((tool) => tool.name === 'sanity_blog_start_config_setup')
  assert.equal(setup.annotations.readOnlyHint, false)
  assert.equal(setup.annotations.destructiveHint, false)
  assert.equal(setup.annotations.openWorldHint, false)
  const preview = listed.tools.find((tool) => tool.name === 'sanity_blog_preview')
  assert.equal(preview.annotations.readOnlyHint, false)
  assert.equal(preview.annotations.destructiveHint, false)
  assert.equal(preview.annotations.idempotentHint, true)
  assert.equal(preview.annotations.openWorldHint, false)
  for (const name of [
    'sanity_blog_probe_publish',
    'sanity_blog_probe_update',
    'sanity_blog_publish',
    'sanity_blog_update',
  ]) {
    const tool = listed.tools.find((candidate) => candidate.name === name)
    assert.deepEqual(tool.inputSchema.required, ['articlePath', 'previewRevision'])
    assert.match(tool.inputSchema.properties.previewRevision.pattern, /\{64\}/u)
  }
})

test('MCP forwards the accepted preview revision to remote tools', async (t) => {
  const previewRevision = 'a'.repeat(64)
  let received
  const {client, server} = await connectedPair(
    stubService({
      probePublish: async (articlePath, revision) => {
        received = {articlePath, revision}
        return {ok: true, mode: 'create', previewRevision: revision}
      },
    }),
  )
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const articlePath = 'C:\\workspace\\blog\\example-post.json'
  const result = await client.callTool({
    name: 'sanity_blog_probe_publish',
    arguments: {articlePath, previewRevision},
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(received, {articlePath, revision: previewRevision})
})

test('MCP configuration setup returns structured launch state without token input', async (t) => {
  const {client, server} = await connectedPair()
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_start_config_setup',
    arguments: {},
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    configured: false,
    setupStarted: true,
    configurationFieldCount: 4,
  })
  assert.doesNotMatch(result.content[0].text, /token\s*[:=]\s*[^,}\s]+/iu)
})

test('MCP tool results contain equivalent structuredContent and JSON text', async (t) => {
  const {client, server} = await connectedPair()
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_check_config',
    arguments: {},
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  assert.deepEqual(result.structuredContent, {
    ok: true,
    configured: true,
    publisherApiOrigin: 'https://publisher.example.test',
  })
})

test('MCP tool errors are sanitized, dual-format, and marked isError', async (t) => {
  const {client, server} = await connectedPair(
    stubService({
      checkConfig: async () => {
        throw new SafeError({
          category: 'configuration',
          code: 'CONFIG_NOT_FOUND',
          safeMessage: 'Configuration is missing.',
          cause: new Error('secret token and stack must not escape'),
        })
      },
    }),
  )
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_check_config',
    arguments: {},
  })
  assert.equal(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  assert.equal(result.structuredContent.error.code, 'CONFIG_NOT_FOUND')
  assert.doesNotMatch(result.content[0].text, /secret token|stack/u)
})

test('MCP validation errors expose only actionable schema issue paths', async (t) => {
  const {client, server} = await connectedPair(
    stubService({
      validate: async () => {
        throw new ArticleValidationError(
          'ARTICLE_SCHEMA_INVALID',
          'Unsafe internal validation context must not escape.',
          {
            issues: [
              {
                path: 'body.en.0.children',
                code: 'too_small',
                message: 'Array must contain at least 1 element(s)',
              },
            ],
          },
        )
      },
    }),
  )
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_validate',
    arguments: {articlePath: 'C:\\workspace\\blog\\example-post.json'},
  })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent.error.issues, [
    {
      path: 'body.en.0.children',
      code: 'too_small',
      message: 'Array must contain at least 1 element(s)',
    },
  ])
  assert.doesNotMatch(result.content[0].text, /Unsafe internal validation context/u)
})

test('MCP preserves an explicit committed receipt when reservation cleanup fails', async (t) => {
  const reservationId = '123e4567-e89b-42d3-a456-426614174000'
  const receipt = {
    committed: true,
    slug: 'example-post',
    reservationId,
    mode: 'create',
    markdownPath: 'C:\\workspace\\blog\\example-post.md',
    articlePath: 'C:\\workspace\\blog\\example-post.json',
    coverPath: 'C:\\workspace\\blog\\assets\\example-post-cover.png',
  }
  const {client, server} = await connectedPair(
    stubService({
      commit: async () => {
        throw new WorkspaceError(
          'COMMIT_CLEANUP_FAILED',
          'Internal cleanup detail must not escape.',
          receipt,
        )
      },
    }),
  )
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_commit',
    arguments: {slug: 'example-post', reservationId},
  })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.committed, true)
  assert.deepEqual(result.structuredContent.error.commitReceipt, receipt)
  assert.doesNotMatch(result.content[0].text, /Internal cleanup detail/u)
})

test('stdio stdout contains JSON-RPC only', async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const pluginRoot = path.resolve(testDirectory, '..')
  const child = spawn(process.execPath, ['dist/server.mjs'], {
    cwd: pluginRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = []
  let buffered = ''
  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdio MCP test timed out')), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n')
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch (error) {
          clearTimeout(timer)
          reject(error)
          return
        }
        stdout.push(message)
        if (message.id === 2) {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (!stdout.some((message) => message.id === 2)) {
        clearTimeout(timer)
        reject(new Error(`stdio server exited early with code ${code}`))
      }
    })
  })

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: {name: 'raw-test', version: '1.0.0'},
      },
    })}\n`,
  )
  child.stdin.write(
    `${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`,
  )
  child.stdin.write(
    `${JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}})}\n`,
  )

  try {
    await complete
    assert.ok(stdout.length >= 2)
    assert.ok(stdout.every((message) => message.jsonrpc === '2.0'))
    const toolsResponse = stdout.find((message) => message.id === 2)
    assert.deepEqual(
      toolsResponse.result.tools.map((tool) => tool.name),
      EXPECTED_TOOLS,
    )
    const setupTool = toolsResponse.result.tools.find(
      (tool) => tool.name === 'sanity_blog_start_config_setup',
    )
    assert.equal(setupTool.inputSchema.additionalProperties, false)
    assert.equal(setupTool.annotations.readOnlyHint, false)
    assert.equal(setupTool.annotations.destructiveHint, false)
  } finally {
    child.stdin.end()
    child.kill()
  }
})
