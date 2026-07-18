#!/usr/bin/env node

import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'

import {PLUGIN_NAME, PLUGIN_VERSION} from './constants.mjs'
import {toSafeErrorResult} from './errors.mjs'
import {asSafeError, createBlogService} from './service.mjs'

const slug = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)

const articlePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), 'articlePath must be absolute')

const reservationId = z
  .string()
  .uuid()
  .refine(
    (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
    'reservationId must be a UUID v4',
  )

const EMPTY_INPUT = z.object({}).strict()
const BASE_SLUG_INPUT = z.object({baseSlug: slug}).strict()
const SLUG_INPUT = z.object({slug}).strict()
const ARTICLE_INPUT = z.object({articlePath}).strict()
const RESERVATION_INPUT = z.object({slug, reservationId}).strict()

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})
const LOCAL_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
})
const LOCAL_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
})
const REMOTE_PROBE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
})
const REMOTE_MUTATION = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
})

function toolResult(structuredContent, isError = false) {
  return {
    content: [{type: 'text', text: JSON.stringify(structuredContent, null, 2)}],
    structuredContent,
    ...(isError ? {isError: true} : {}),
  }
}

function safeHandler(handler) {
  return async (input) => {
    try {
      return toolResult(await handler(input))
    } catch (error) {
      return toolResult(toSafeErrorResult(asSafeError(error)), true)
    }
  }
}

export function registerBlogTools(server, service) {
  server.registerTool(
    'sanity_blog_check_config',
    {
      title: 'Check Sanity blog configuration',
      description:
        'Safely checks the fixed ~/.sanity-blog/config.json without returning the token or API origin.',
      inputSchema: EMPTY_INPUT,
      annotations: READ_ONLY,
    },
    safeHandler(() => service.checkConfig()),
  )

  server.registerTool(
    'sanity_blog_prepare_publish',
    {
      title: 'Prepare a Sanity blog publish bundle',
      description:
        'Reserves a slug and returns staging paths for a new or complete existing local article bundle.',
      inputSchema: BASE_SLUG_INPUT,
      annotations: LOCAL_WRITE,
    },
    safeHandler(({baseSlug}) => service.preparePublish(baseSlug)),
  )

  server.registerTool(
    'sanity_blog_prepare_update',
    {
      title: 'Prepare a strict Sanity blog update bundle',
      description:
        'Returns staging paths only when the complete local article bundle already exists; it never creates an article.',
      inputSchema: SLUG_INPUT,
      annotations: LOCAL_WRITE,
    },
    safeHandler(({slug: value}) => service.prepareUpdate(value)),
  )

  server.registerTool(
    'sanity_blog_validate',
    {
      title: 'Validate a local Sanity blog article',
      description:
        'Performs the built-in article contract, path, Portable Text, image signature, and resource-limit checks with zero remote requests.',
      inputSchema: ARTICLE_INPUT,
      annotations: READ_ONLY,
    },
    safeHandler(({articlePath: value}) => service.validate(value)),
  )

  server.registerTool(
    'sanity_blog_probe_publish',
    {
      title: 'Probe a Sanity blog publish',
      description:
        'Runs one POST dry-run and only after a sanitized slug conflict runs one PUT dry-run; it performs no final article mutation.',
      inputSchema: ARTICLE_INPUT,
      annotations: REMOTE_PROBE,
    },
    safeHandler(({articlePath: value}) => service.probePublish(value)),
  )

  server.registerTool(
    'sanity_blog_probe_update',
    {
      title: 'Probe a strict Sanity blog update',
      description:
        'Runs only a PUT dry-run for an existing remote article and returns its guarded revision.',
      inputSchema: ARTICLE_INPUT,
      annotations: REMOTE_PROBE,
    },
    safeHandler(({articlePath: value}) => service.probeUpdate(value)),
  )

  server.registerTool(
    'sanity_blog_commit',
    {
      title: 'Commit a staged Sanity blog bundle',
      description:
        'Atomically commits the complete reserved Markdown, article JSON, and PNG cover bundle after baseline checks.',
      inputSchema: RESERVATION_INPUT,
      annotations: LOCAL_DESTRUCTIVE,
    },
    safeHandler(({slug: value, reservationId: id}) => service.commit(value, id)),
  )

  server.registerTool(
    'sanity_blog_release',
    {
      title: 'Release a Sanity blog reservation',
      description:
        'Releases only the matching uncommitted local reservation and its staging bundle.',
      inputSchema: RESERVATION_INPUT,
      annotations: LOCAL_DESTRUCTIVE,
    },
    safeHandler(({slug: value, reservationId: id}) => service.release(value, id)),
  )

  server.registerTool(
    'sanity_blog_publish',
    {
      title: 'Publish a Sanity blog article',
      description:
        'Validates locally, probes create, safely falls back to guarded update only on a sanitized conflict, performs one final mutation, and writes the local publication record.',
      inputSchema: ARTICLE_INPUT,
      annotations: REMOTE_MUTATION,
    },
    safeHandler(({articlePath: value}) => service.publish(value)),
  )

  server.registerTool(
    'sanity_blog_update',
    {
      title: 'Strictly update a Sanity blog article',
      description:
        'Validates locally, obtains a revision through a PUT dry-run, performs one revision-guarded PUT, and never creates an article.',
      inputSchema: ARTICLE_INPUT,
      annotations: REMOTE_MUTATION,
    },
    safeHandler(({articlePath: value}) => service.update(value)),
  )
}

export function createMcpServer({service = createBlogService()} = {}) {
  const server = new McpServer(
    {name: PLUGIN_NAME, version: PLUGIN_VERSION},
    {capabilities: {tools: {}}},
  )
  registerBlogTools(server, service)
  return server
}

export async function startServer({transport = new StdioServerTransport(), service} = {}) {
  const server = createMcpServer({service})
  await server.connect(transport)
  return server
}

async function main() {
  await startServer()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('sanityblog MCP server failed')
    process.exitCode = 1
  })
}
