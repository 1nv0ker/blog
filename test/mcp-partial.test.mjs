import assert from 'node:assert/strict'
import test from 'node:test'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'

import {SafeError} from '../src/errors.mjs'
import {createMcpServer} from '../src/server.mjs'

test('MCP preserves the safe receipt when publication succeeded but record writing failed', async (t) => {
  const service = {
    publish: async () => {
      throw new SafeError({
        category: 'publication_record',
        code: 'PUBLISHED_BUT_RECORD_WRITE_FAILED',
        remoteMutationSucceeded: true,
        receipt: {
          operation: 'created',
          status: 'published',
          id: 'document-1',
          revision: 'revision-1',
          slug: 'example-post',
          requestId: 'request-1',
          uploadedAssetIds: [],
          target: {
            projectId: 'project1',
            dataset: 'production',
            apiVersion: '2026-07-05',
          },
        },
      })
    },
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({service})
  const client = new Client(
    {name: 'partial-success-test', version: '1.0.0'},
    {capabilities: {}},
  )
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const result = await client.callTool({
    name: 'sanity_blog_publish',
    arguments: {articlePath: 'C:\\workspace\\blog\\example-post.json'},
  })
  assert.equal(result.isError, true)
  assert.equal(
    result.structuredContent.error.code,
    'PUBLISHED_BUT_RECORD_WRITE_FAILED',
  )
  assert.equal(result.structuredContent.error.remoteMutationSucceeded, true)
  assert.equal(result.structuredContent.error.receipt.id, 'document-1')
  assert.equal(result.structuredContent.error.receipt.operation, 'created')
})
