#!/usr/bin/env node

import {Writable} from 'node:stream'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline/promises'

import {
  DEFAULT_WORKSPACE_ROOT,
  checkConfig,
  initializeConfig,
} from './config.mjs'
import {toSafeErrorResult} from './errors.mjs'
import {asSafeError} from './service.mjs'

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
    throw new Error(
      'SANITY_BLOG_TOKEN must be set when --init is used without an interactive terminal.',
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

async function collectConfiguration() {
  if (!process.stdin.isTTY && !process.env.SANITY_BLOG_TOKEN) {
    throw new Error('Interactive input or SANITY_BLOG_TOKEN is required for --init.')
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY),
  })
  let publisherApiOrigin
  let projectId
  let dataset
  let apiVersion
  let workspaceRoot
  try {
    publisherApiOrigin = await askVisible(
      readline,
      'Publisher API HTTPS origin',
      process.env.SANITY_BLOG_PUBLISHER_API_ORIGIN,
    )
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
    apiVersion = await askVisible(
      readline,
      'Sanity API version',
      process.env.SANITY_BLOG_API_VERSION ?? '2026-07-05',
    )
    workspaceRoot = await askVisible(
      readline,
      'Workspace root',
      process.env.SANITY_BLOG_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT,
    )
  } finally {
    readline.close()
  }
  const sanityToken = process.env.SANITY_BLOG_TOKEN ?? (await askHidden('Sanity token (hidden)'))
  return {
    publisherApiOrigin,
    projectId,
    dataset,
    apiVersion,
    sanityToken,
    workspaceRoot,
  }
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--init', '--check', '--help'].includes(args[0])) {
    throw new Error('Use exactly one of --init, --check, or --help.')
  }
  if (args[0] === '--help') {
    return {
      ok: true,
      usage: [
        'node src/cli.mjs --init',
        'node src/cli.mjs --check',
      ],
    }
  }
  if (args[0] === '--check') {
    return {ok: true, ...(await checkConfig())}
  }
  const configuration = await collectConfiguration()
  return {ok: true, ...(await initializeConfig(configuration))}
}

async function main() {
  try {
    printJson(await runCli())
  } catch (error) {
    printJson(toSafeErrorResult(asSafeError(error)), process.stderr)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
