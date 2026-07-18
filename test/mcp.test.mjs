import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'

import {SafeError} from '../src/errors.mjs'
import {createMcpServer} from '../src/server.mjs'

const EXPECTED_TOOLS = [
  'sanity_blog_check_config',
  'sanity_blog_prepare_publish',
  'sanity_blog_prepare_update',
  'sanity_blog_validate',
  'sanity_blog_probe_publish',
  'sanity_blog_probe_update',
  'sanity_blog_commit',
  'sanity_blog_release',
  'sanity_blog_publish',
  'sanity_blog_update',
]

function stubService(overrides = {}) {
  return {
    checkConfig: async () => ({ok: true, configured: true}),
    preparePublish: async (baseSlug) => ({ok: true, slug: baseSlug}),
    prepareUpdate: async (slug) => ({ok: true, slug}),
    validate: async () => ({ok: true, valid: true}),
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
  assert.deepEqual(result.structuredContent, {ok: true, configured: true})
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

test('stdio stdout contains JSON-RPC only', async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const pluginRoot = path.resolve(testDirectory, '..')
  const child = spawn(process.execPath, ['src/server.mjs'], {
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
  } finally {
    child.stdin.end()
    child.kill()
  }
})
