import assert from 'node:assert/strict'
import test from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'

import {CONTENT_TOOL_NAMES} from '../src/content-server.mjs'
import {SafeError} from '../src/errors.mjs'
import {createMcpServer} from '../src/server.mjs'

const CONTENT_TYPES = [
  'blog-en',
  'guide',
  'comparison',
  'solution',
  'alternative',
  'tutorial',
]
const PREVIEW_REVISION = 'a'.repeat(64)

function contentStub(overrides = {}) {
  return {
    checkConfig: async () => ({ok: true, configured: true}),
    startConfigSetup: async () => ({ok: true, setupStarted: true}),
    preparePublish: async (contentType, baseSlug) => ({
      ok: true,
      contentType,
      slug: baseSlug,
    }),
    prepareUpdate: async (contentType, slug) => ({
      ok: true,
      contentType,
      slug,
    }),
    validate: async (contentType) => ({ok: true, contentType, valid: true}),
    preview: async (contentType) => ({
      ok: true,
      contentType,
      previewRevision: PREVIEW_REVISION,
    }),
    probePublish: async (contentType) => ({
      ok: true,
      contentType,
      mode: 'create',
    }),
    probeUpdate: async (contentType) => ({
      ok: true,
      contentType,
      mode: 'update',
    }),
    commit: async (contentType, slug) => ({ok: true, contentType, slug}),
    release: async (contentType, slug) => ({
      ok: true,
      contentType,
      slug,
      released: true,
    }),
    publish: async (contentType) => ({
      ok: true,
      contentType,
      operation: 'created',
    }),
    update: async (contentType) => ({
      ok: true,
      contentType,
      operation: 'updated',
    }),
    ...overrides,
  }
}

async function connectedPair(t, contentService = contentStub()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({service: {}, contentService})
  const client = new Client(
    {name: 'sanity-content-test-client', version: '1.0.0'},
    {capabilities: {}},
  )
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  t.after(async () => {
    await client.close()
    await server.close()
  })
  return {client, server}
}

test('MCP exposes exactly 12 strict content tools with the six-type enum', async (t) => {
  const {client} = await connectedPair(t)
  const listed = await client.listTools()
  const tools = listed.tools.filter((tool) =>
    tool.name.startsWith('sanity_content_'),
  )

  assert.deepEqual(
    tools.map((tool) => tool.name),
    CONTENT_TOOL_NAMES,
  )
  assert.equal(tools.length, 12)
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean')
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean')
    assert.equal(typeof tool.annotations?.idempotentHint, 'boolean')
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean')

    if (
      tool.name !== 'sanity_content_check_config' &&
      tool.name !== 'sanity_content_start_config_setup'
    ) {
      assert.ok(tool.inputSchema.required.includes('contentType'))
      assert.deepEqual(
        tool.inputSchema.properties.contentType.enum,
        CONTENT_TYPES,
      )
    } else {
      assert.deepEqual(tool.inputSchema.properties, {})
      assert.equal(tool.inputSchema.required, undefined)
    }
  }

  for (const name of [
    'sanity_content_probe_publish',
    'sanity_content_probe_update',
    'sanity_content_publish',
    'sanity_content_update',
  ]) {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.deepEqual(tool.inputSchema.required, [
      'contentType',
      'articlePath',
      'previewRevision',
    ])
    assert.match(tool.inputSchema.properties.previewRevision.pattern, /\{64\}/u)
  }
})

test('MCP content annotations accurately separate local, probe, and mutation effects', async (t) => {
  const {client} = await connectedPair(t)
  const listed = await client.listTools()
  const byName = new Map(
    listed.tools
      .filter((tool) => tool.name.startsWith('sanity_content_'))
      .map((tool) => [tool.name, tool.annotations]),
  )

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const localWrite = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }
  const localRender = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const localDestructive = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  }
  const remoteProbe = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  }
  const remoteMutation = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  }

  assert.deepEqual(byName.get('sanity_content_check_config'), readOnly)
  assert.deepEqual(byName.get('sanity_content_validate'), readOnly)
  assert.deepEqual(
    byName.get('sanity_content_start_config_setup'),
    localWrite,
  )
  assert.deepEqual(byName.get('sanity_content_prepare_publish'), localWrite)
  assert.deepEqual(byName.get('sanity_content_prepare_update'), localWrite)
  assert.deepEqual(byName.get('sanity_content_preview'), localRender)
  assert.deepEqual(byName.get('sanity_content_commit'), localDestructive)
  assert.deepEqual(byName.get('sanity_content_release'), localDestructive)
  assert.deepEqual(byName.get('sanity_content_probe_publish'), remoteProbe)
  assert.deepEqual(byName.get('sanity_content_probe_update'), remoteProbe)
  assert.deepEqual(byName.get('sanity_content_publish'), remoteMutation)
  assert.deepEqual(byName.get('sanity_content_update'), remoteMutation)
})

test('MCP rejects blog-post, unknown, missing, relative, and extra inputs before handlers', async (t) => {
  let handlerCalls = 0
  const service = contentStub({
    validate: async () => {
      handlerCalls += 1
      throw new Error('invalid arguments must not reach the handler')
    },
    publish: async () => {
      handlerCalls += 1
      throw new Error('invalid arguments must not reach the handler')
    },
  })
  const {client} = await connectedPair(t, service)
  const absolutePath = 'C:\\workspace\\contents\\guide\\example\\example.json'
  const invalidCalls = [
    {
      name: 'sanity_content_validate',
      arguments: {contentType: 'blog-post', articlePath: absolutePath},
    },
    {
      name: 'sanity_content_validate',
      arguments: {contentType: 'unknown', articlePath: absolutePath},
    },
    {
      name: 'sanity_content_validate',
      arguments: {articlePath: absolutePath},
    },
    {
      name: 'sanity_content_validate',
      arguments: {contentType: 'guide', articlePath: 'relative.json'},
    },
    {
      name: 'sanity_content_publish',
      arguments: {
        contentType: 'guide',
        articlePath: absolutePath,
        previewRevision: PREVIEW_REVISION,
        unexpected: true,
      },
    },
  ]

  for (const request of invalidCalls) {
    const result = await client.callTool(request)
    assert.equal(result.isError, true)
  }
  assert.equal(handlerCalls, 0)
})

test('MCP forwards contentType and accepted previewRevision to the service', async (t) => {
  let received
  const {client} = await connectedPair(
    t,
    contentStub({
      probePublish: async (contentType, articlePath, previewRevision) => {
        received = {contentType, articlePath, previewRevision}
        return {
          ok: true,
          contentType,
          mode: 'create',
          previewRevision,
        }
      },
    }),
  )
  const articlePath =
    'C:\\workspace\\contents\\comparison\\example\\example.json'
  const result = await client.callTool({
    name: 'sanity_content_probe_publish',
    arguments: {
      contentType: 'comparison',
      articlePath,
      previewRevision: PREVIEW_REVISION,
    },
  })

  assert.equal(result.isError, undefined)
  assert.deepEqual(received, {
    contentType: 'comparison',
    articlePath,
    previewRevision: PREVIEW_REVISION,
  })
  assert.equal(result.structuredContent.contentType, 'comparison')
})

test('MCP preserves a whitelisted typed receipt after confirmed remote success', async (t) => {
  const receipt = {
    operation: 'created',
    status: 'published',
    contentType: 'guide',
    id: 'document-1',
    revision: 'revision-1',
    slug: 'example',
    requestId: 'request-1',
    uploadedAssetIds: ['file-retained-pdf'],
    target: {
      projectId: 'exampleproject',
      dataset: 'production',
      apiVersion: '2026-07-05',
    },
    token: 'must-not-escape',
  }
  const {client} = await connectedPair(
    t,
    contentStub({
      publish: async () => {
        throw new SafeError({
          category: 'publication_record',
          code: 'PUBLISHED_BUT_RECORD_WRITE_FAILED',
          remoteMutationSucceeded: true,
          receipt,
          safeMessage:
            'The remote mutation succeeded, but the local record failed.',
        })
      },
    }),
  )
  const result = await client.callTool({
    name: 'sanity_content_publish',
    arguments: {
      contentType: 'guide',
      articlePath:
        'C:\\workspace\\contents\\guide\\example\\example.json',
      previewRevision: PREVIEW_REVISION,
    },
  })

  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.remoteMutationSucceeded, true)
  assert.equal(result.structuredContent.error.receipt.contentType, 'guide')
  assert.equal(Object.hasOwn(result.structuredContent.error.receipt, 'token'), false)
  assert.doesNotMatch(result.content[0].text, /must-not-escape/u)
})
