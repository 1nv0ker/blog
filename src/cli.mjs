#!/usr/bin/env node

import {Writable} from 'node:stream'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline/promises'

import {
  checkConfig,
  checkContentConfig,
  initializeConfig,
} from './config.mjs'
import {
  DEFAULT_PUBLIC_SITE_ORIGIN,
  DEFAULT_PUBLISHER_API_ORIGIN,
} from './constants.mjs'
import {SafeError, toSafeErrorResult} from './errors.mjs'

function asCliSafeError(error) {
  if (error instanceof SafeError) return error
  return new SafeError({
    category: 'internal',
    code: 'INTERNAL_ERROR',
    retryable: false,
    resultUnknown: false,
    safeMessage: 'Sanity blog configuration setup failed safely.',
    cause: error,
  })
}

function configurationInputError(code, safeMessage) {
  return new SafeError({
    category: 'configuration',
    code,
    retryable: false,
    resultUnknown: false,
    safeMessage,
  })
}
function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function askVisible(readline, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const answer = (await readline.question(`${label}${suffix}: `)).trim()
  return answer || defaultValue
}

async function askHidden(label) {
  if (!process.stdin.isTTY) {
    throw configurationInputError(
      'CONFIG_INPUT_REQUIRED',
      'SANITY_BLOG_TOKEN is required for non-interactive initialization.',
    )
  }
  process.stderr.write(`${label}: `)
  const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const hidden = createInterface({
    input: process.stdin,
    output: silentOutput,
    terminal: true,
  })
  try {
    return (await hidden.question('')).trim()
  } finally {
    hidden.close()
    process.stderr.write('\n')
  }
}

async function collectConfiguration({includePublicSiteOrigin = false} = {}) {
  if (!process.stdin.isTTY) {
    const projectId = process.env.SANITY_BLOG_PROJECT_ID?.trim()
    const sanityToken = process.env.SANITY_BLOG_TOKEN?.trim()
    if (!projectId || !sanityToken) {
      throw configurationInputError(
        'CONFIG_INPUT_REQUIRED',
        'SANITY_BLOG_PROJECT_ID and SANITY_BLOG_TOKEN are required for non-interactive initialization.',
      )
    }
    return {
      publisherApiOrigin:
        process.env.SANITY_BLOG_PUBLISHER_API_ORIGIN?.trim() ||
        DEFAULT_PUBLISHER_API_ORIGIN,
      ...(includePublicSiteOrigin
        ? {
            publicSiteOrigin:
              process.env.SANITY_BLOG_PUBLIC_SITE_ORIGIN?.trim() ||
              DEFAULT_PUBLIC_SITE_ORIGIN,
          }
        : {}),
      projectId,
      dataset: process.env.SANITY_BLOG_DATASET?.trim() || 'production',
      sanityToken,
    }
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
  let publisherApiOrigin
  let publicSiteOrigin
  let projectId
  let dataset
  try {
    publisherApiOrigin = await askVisible(
      readline,
      'Publisher API origin (HTTPS)',
      process.env.SANITY_BLOG_PUBLISHER_API_ORIGIN ?? DEFAULT_PUBLISHER_API_ORIGIN,
    )
    if (includePublicSiteOrigin) {
      publicSiteOrigin = await askVisible(
        readline,
        'Public site origin for canonical URLs (HTTPS)',
        process.env.SANITY_BLOG_PUBLIC_SITE_ORIGIN ?? DEFAULT_PUBLIC_SITE_ORIGIN,
      )
    }
    projectId = await askVisible(
      readline,
      'Sanity project ID',
      process.env.SANITY_BLOG_PROJECT_ID,
    )
    dataset = await askVisible(
      readline,
      'Sanity dataset',
      process.env.SANITY_BLOG_DATASET ?? 'production',
    )
  } finally {
    readline.close()
  }
  const sanityToken = process.env.SANITY_BLOG_TOKEN ?? (await askHidden('Sanity token (hidden)'))
  return {
    publisherApiOrigin,
    ...(includePublicSiteOrigin ? {publicSiteOrigin} : {}),
    projectId,
    dataset,
    sanityToken,
  }
}

export async function runCli(args = process.argv.slice(2)) {
  if (
    args.length !== 1 ||
    !['--init', '--init-content', '--check', '--help'].includes(args[0])
  ) {
    throw configurationInputError(
      'INVALID_CLI_ARGUMENTS',
      'Use exactly one of --init, --init-content, --check, or --help.',
    )
  }
  if (args[0] === '--help') {
    return {
      ok: true,
      usage: [
        'node dist/cli.mjs --init',
        'node dist/cli.mjs --init-content',
        'node dist/cli.mjs --check',
      ],
    }
  }
  if (args[0] === '--check') {
    return {ok: true, ...(await checkConfig())}
  }
  const configuration = await collectConfiguration({
    includePublicSiteOrigin: args[0] === '--init-content',
  })
  const initialized = await initializeConfig(configuration)
  if (args[0] === '--init-content') {
    return {ok: true, ...(await checkContentConfig())}
  }
  return {ok: true, ...initialized}
}

async function main() {
  try {
    printJson(await runCli())
  } catch (error) {
    printJson(toSafeErrorResult(asCliSafeError(error)), process.stderr)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
