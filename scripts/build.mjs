#!/usr/bin/env node

import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'esbuild'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = path.join(pluginRoot, 'dist')

await mkdir(outputDirectory, {recursive: true})
await build({
  absWorkingDir: pluginRoot,
  entryPoints: ['src/server.mjs'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
})
