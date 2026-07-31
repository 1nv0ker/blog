import path from 'node:path'

import {z} from 'zod'

import {toSafeErrorResult} from './errors.mjs'
import {asContentSafeError} from './content-service.mjs'
import {CONTENT_TYPE_IDS} from './content-types.mjs'

const contentType = z.enum(CONTENT_TYPE_IDS)
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
    (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      ),
    'reservationId must be a UUID v4',
  )
const previewRevision = z.string().regex(/^[0-9a-f]{64}$/u)

const EMPTY_INPUT = z.object({}).strict()
const BASE_SLUG_INPUT = z.object({contentType, baseSlug: slug}).strict()
const SLUG_INPUT = z.object({contentType, slug}).strict()
const ARTICLE_INPUT = z.object({contentType, articlePath}).strict()
const PREVIEWED_ARTICLE_INPUT = z
  .object({contentType, articlePath, previewRevision})
  .strict()
const RESERVATION_INPUT = z
  .object({contentType, slug, reservationId})
  .strict()

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
const LOCAL_RENDER = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
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
      return toolResult(toSafeErrorResult(asContentSafeError(error)), true)
    }
  }
}

export function registerContentTools(server, service) {
  server.registerTool(
    'sanity_content_check_config',
    {
      title: 'Check Sanity rich-content configuration',
      description:
        'Safely checks the shared local publisher configuration and returns the public canonical origin without exposing the Sanity token.',
      inputSchema: EMPTY_INPUT,
      annotations: READ_ONLY,
    },
    safeHandler(() => service.checkConfig()),
  )

  server.registerTool(
    'sanity_content_start_config_setup',
    {
      title: 'Start Sanity rich-content configuration setup',
      description:
        'Opens the safe interactive configuration flow, including the non-sensitive publicSiteOrigin, without accepting or returning a token.',
      inputSchema: EMPTY_INPUT,
      annotations: LOCAL_WRITE,
    },
    safeHandler(() => service.startConfigSetup()),
  )

  server.registerTool(
    'sanity_content_prepare_publish',
    {
      title: 'Prepare a Sanity rich-content publish bundle',
      description:
        'Reserves one type-scoped slug and returns staging paths for Markdown, strict content JSON, and an assets directory.',
      inputSchema: BASE_SLUG_INPUT,
      annotations: LOCAL_WRITE,
    },
    safeHandler(({contentType: type, baseSlug}) =>
      service.preparePublish(type, baseSlug)),
  )

  server.registerTool(
    'sanity_content_prepare_update',
    {
      title: 'Prepare a strict Sanity rich-content update bundle',
      description:
        'Returns a type-scoped staging copy only when the complete local content bundle already exists.',
      inputSchema: SLUG_INPUT,
      annotations: LOCAL_WRITE,
    },
    safeHandler(({contentType: type, slug: value}) =>
      service.prepareUpdate(type, value)),
  )

  server.registerTool(
    'sanity_content_validate',
    {
      title: 'Validate local Sanity rich content',
      description:
        'Performs the complete API 1.1 rich-content, canonical, Portable Text, local asset, and resource-limit validation with zero remote requests.',
      inputSchema: ARTICLE_INPUT,
      annotations: READ_ONLY,
    },
    safeHandler(({contentType: type, articlePath: value}) =>
      service.validate(type, value)),
  )

  server.registerTool(
    'sanity_content_preview',
    {
      title: 'Render a local Sanity rich-content preview',
      description:
        'Validates the type-scoped content bundle and writes a safe bilingual HTML preview that binds Markdown, JSON, and every referenced local asset.',
      inputSchema: ARTICLE_INPUT,
      annotations: LOCAL_RENDER,
    },
    safeHandler(({contentType: type, articlePath: value}) =>
      service.preview(type, value)),
  )

  server.registerTool(
    'sanity_content_probe_publish',
    {
      title: 'Probe a Sanity rich-content publish',
      description:
        'Revalidates the accepted preview, runs a POST dry-run, and only after a sanitized publish conflict attempts a PUT dry-run.',
      inputSchema: PREVIEWED_ARTICLE_INPUT,
      annotations: REMOTE_PROBE,
    },
    safeHandler(({contentType: type, articlePath: value, previewRevision: revision}) =>
      service.probePublish(type, value, revision)),
  )

  server.registerTool(
    'sanity_content_probe_update',
    {
      title: 'Probe a strict Sanity rich-content update',
      description:
        'Revalidates the accepted preview and runs only a PUT dry-run for an existing type-scoped remote document.',
      inputSchema: PREVIEWED_ARTICLE_INPUT,
      annotations: REMOTE_PROBE,
    },
    safeHandler(({contentType: type, articlePath: value, previewRevision: revision}) =>
      service.probeUpdate(type, value, revision)),
  )

  server.registerTool(
    'sanity_content_commit',
    {
      title: 'Commit a staged Sanity rich-content bundle',
      description:
        'Atomically commits the reserved Markdown, JSON, and assets directory after type-scoped baseline checks.',
      inputSchema: RESERVATION_INPUT,
      annotations: LOCAL_DESTRUCTIVE,
    },
    safeHandler(({contentType: type, slug: value, reservationId: id}) =>
      service.commit(type, value, id)),
  )

  server.registerTool(
    'sanity_content_release',
    {
      title: 'Release a Sanity rich-content reservation',
      description:
        'Releases only the matching type-scoped reservation and its remaining staging bundle.',
      inputSchema: RESERVATION_INPUT,
      annotations: LOCAL_DESTRUCTIVE,
    },
    safeHandler(({contentType: type, slug: value, reservationId: id}) =>
      service.release(type, value, id)),
  )

  server.registerTool(
    'sanity_content_publish',
    {
      title: 'Publish Sanity rich content',
      description:
        'Revalidates the accepted preview, safely probes create or guarded update, performs one final mutation, and writes a type-scoped local record.',
      inputSchema: PREVIEWED_ARTICLE_INPUT,
      annotations: REMOTE_MUTATION,
    },
    safeHandler(({contentType: type, articlePath: value, previewRevision: revision}) =>
      service.publish(type, value, revision)),
  )

  server.registerTool(
    'sanity_content_update',
    {
      title: 'Strictly update Sanity rich content',
      description:
        'Performs a PUT dry-run followed by one revision-guarded PUT and never creates a missing document.',
      inputSchema: PREVIEWED_ARTICLE_INPUT,
      annotations: REMOTE_MUTATION,
    },
    safeHandler(({contentType: type, articlePath: value, previewRevision: revision}) =>
      service.update(type, value, revision)),
  )
}

export const CONTENT_TOOL_NAMES = Object.freeze([
  'sanity_content_check_config',
  'sanity_content_start_config_setup',
  'sanity_content_prepare_publish',
  'sanity_content_prepare_update',
  'sanity_content_validate',
  'sanity_content_preview',
  'sanity_content_probe_publish',
  'sanity_content_probe_update',
  'sanity_content_commit',
  'sanity_content_release',
  'sanity_content_publish',
  'sanity_content_update',
])
