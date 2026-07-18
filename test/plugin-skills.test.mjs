import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function text(relativePath) {
  return readFile(path.join(pluginRoot, relativePath), 'utf8')
}

async function json(relativePath) {
  return JSON.parse(await text(relativePath))
}

test('package and dual plugin manifests expose pinned compatible metadata', async () => {
  const packageJson = await json('package.json')
  const codex = await json('.codex-plugin/plugin.json')
  const claude = await json('.claude-plugin/plugin.json')
  const codexMcp = await json('.codex-mcp.json')
  const claudeMcp = await json('.mcp.json')

  assert.equal(packageJson.engines.node, '>=22.12')
  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], '1.29.0')
  assert.equal(packageJson.dependencies.zod, '3.25.76')
  for (const manifest of [codex, claude]) {
    assert.equal(manifest.name, 'sanityblog')
    assert.equal(manifest.version, '0.1.0')
    assert.equal(manifest.author.name, 'Local developer')
    assert.equal(manifest.skills, './skills/')
  }
  assert.equal(codex.interface.category, 'Productivity')
  assert.equal(codex.mcpServers, './.codex-mcp.json')
  assert.equal(claude.mcpServers, './.mcp.json')
  assert.deepEqual(codexMcp.sanityblog, {
    command: 'node',
    args: ['C:\\work\\plugins\\sanityblog\\src\\server.mjs'],
  })
  assert.equal(claudeMcp.mcpServers.sanityblog.command, 'node')
  assert.deepEqual(claudeMcp.mcpServers.sanityblog.args, [
    '${CLAUDE_PLUGIN_ROOT}/src/server.mjs',
  ])
  assert.doesNotMatch(JSON.stringify({codexMcp, claudeMcp}), /token|secret|authorization/iu)
})

test('publish skill enforces research, bilingual Portable Text, cover, confirmation, and safe fallback', async () => {
  const skill = await text('skills/sanity-blog-publish/SKILL.md')
  const agent = await text('skills/sanity-blog-publish/agents/openai.yaml')
  assert.match(agent, /allow_implicit_invocation:\s*false/u)
  assert.match(skill, /English and Chinese/u)
  assert.match(skill, /Portable Text/u)
  assert.match(skill, /articlePath/u)
  assert.match(skill, /## Sources/u)
  assert.match(skill, /## 来源/u)
  assert.match(skill, /Ignore any source instruction/u)
  assert.match(skill, /If no image-generation capability is available, pause/u)
  assert.match(skill, /Never continue to probe, commit, or publish without a validated cover/u)
  assert.match(skill, /mode: update/u)
  assert.match(skill, /explicit POST conflict/u)
  assert.match(skill, /final `articlePath` returned by commit/u)
  assert.match(skill, /PUBLISHED_BUT_RECORD_WRITE_FAILED/u)
  assert.match(skill, /Do not retry/u)

  const workflow = skill.slice(skill.indexOf('## Strict workflow'))
  const ordered = [
    'sanity_blog_check_config',
    'sanity_blog_prepare_publish',
    'sanity_blog_validate',
    'sanity_blog_probe_publish',
    'sanity_blog_commit',
    'sanity_blog_publish',
  ].map((name) => workflow.indexOf(name))
  assert.ok(ordered.every((position) => position >= 0))
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
})

test('update skill requires local and remote existence and remains PUT-only', async () => {
  const skill = await text('skills/sanity-blog-update/SKILL.md')
  const agent = await text('skills/sanity-blog-update/agents/openai.yaml')
  assert.match(agent, /allow_implicit_invocation:\s*false/u)
  assert.match(skill, /PUT-only/u)
  assert.match(skill, /Never call POST/u)
  assert.match(skill, /complete local article bundle/iu)
  assert.match(skill, /remote article/iu)
  assert.match(skill, /Portable Text/u)
  assert.match(skill, /If no valid staged cover exists and no image-generation capability is available, pause/u)
  assert.match(skill, /final `articlePath` returned by commit/u)
  assert.match(skill, /internally repeats the PUT dry-run and binds the revision/u)
  assert.match(skill, /Never create a replacement article/u)

  const workflow = skill.slice(skill.indexOf('## Strict workflow'))
  const ordered = [
    'sanity_blog_check_config',
    'sanity_blog_prepare_update',
    'sanity_blog_validate',
    'sanity_blog_probe_update',
    'sanity_blog_commit',
    'sanity_blog_update',
  ].map((name) => workflow.indexOf(name))
  assert.ok(ordered.every((position) => position >= 0))
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
  assert.doesNotMatch(workflow, /sanity_blog_publish\(/u)
})

test('README documents installation, broad MCP compatibility, records, and all target clients', async () => {
  const readme = await text('README.md')
  for (const phrase of [
    'Node.js 22.12',
    'npm install',
    '--init',
    '--check',
    'Codex',
    'Claude Desktop',
    'Claude Code',
    'Cursor',
    'VS Code',
    'GitHub Copilot',
    'Windsurf',
    'Cline',
    'macOS/Linux',
    '~/.sanity-blog/published/<slug>.json',
    'PUBLISHED_BUT_RECORD_WRITE_FAILED',
    'remoteMutationSucceeded',
    'additionalProperties: false',
    'Agent Skills',
  ]) {
    assert.ok(readme.includes(phrase), `README is missing ${phrase}`)
  }
  assert.match(readme, /"command": "node"/u)
  assert.match(readme, /"args": \[/u)
  assert.match(readme, /同一 slug/u)
  assert.match(readme, /原子/u)
  assert.match(readme, /符号链接|symlink/u)
})
