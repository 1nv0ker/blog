import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {readdir, readFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const richContentTypes = [
  'blog-en',
  'guide',
  'comparison',
  'solution',
  'alternative',
  'tutorial',
]
const contentOperations = ['preview', 'publish', 'update']
const legacySkillNames = [
  'sanity-blog-preview',
  'sanity-blog-publish',
  'sanity-blog-update',
]
const richContentSkillNames = richContentTypes.flatMap((contentType) =>
  contentOperations.map(
    (operation) => `sanity-content-${contentType}-${operation}`,
  ),
)
const expectedSkillNames = [...legacySkillNames, ...richContentSkillNames].sort()
const removedGenericSkillNames = [
  'sanity-content-preview',
  'sanity-content-publish',
  'sanity-content-update',
]

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
  const claudeMcp = await json('.mcp.json')
  const marketplace = await json('.agents/plugins/marketplace.json')

  assert.equal(packageJson.engines.node, '>=22.12')
  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], '1.29.0')
  assert.equal(packageJson.dependencies.zod, '3.25.76')
  assert.equal(packageJson.devDependencies.esbuild, '0.25.12')
  assert.equal(packageJson.version, '0.2.0')
  assert.match(codex.version, /^0\.2\.0\+codex\.[0-9A-Za-z.-]+$/u)
  assert.equal(claude.version, '0.2.0')
  for (const manifest of [codex, claude]) {
    assert.equal(manifest.name, 'sanityblog')
    assert.equal(manifest.author.name, 'Local developer')
    assert.equal(manifest.skills, './skills/')
  }
  assert.equal(codex.interface.category, 'Productivity')
  assert.equal(claude.mcpServers, './.mcp.json')
  assert.deepEqual(codex.mcpServers.sanityblog, {
    command: 'node',
    args: ['./dist/server.mjs'],
    cwd: '.',
  })
  assert.equal(claudeMcp.mcpServers.sanityblog.command, 'node')
  assert.deepEqual(claudeMcp.mcpServers.sanityblog.args, [
    '${CLAUDE_PLUGIN_ROOT}/dist/server.mjs',
  ])
  assert.equal(marketplace.name, 'sanityblog')
  const marketplacePlugin = marketplace.plugins.find((entry) => entry.name === 'sanityblog')
  assert.deepEqual(marketplacePlugin.source, {
    source: 'url',
    url: 'https://github.com/1nv0ker/blog.git',
    ref: 'main',
  })
  assert.equal(marketplacePlugin.policy.installation, 'AVAILABLE')
  assert.equal(marketplacePlugin.policy.authentication, 'ON_INSTALL')
  assert.doesNotMatch(JSON.stringify({codex, claudeMcp}), /token|secret|authorization/iu)
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
  assert.match(skill, /publisherApiOrigin/u)
  assert.match(skill, /sanity_blog_start_config_setup/u)
  assert.match(skill, /four fields/u)
  assert.match(skill, /sanity_blog_preview/u)
  assert.match(skill, /Markdown view/u)
  assert.match(skill, /previewRevision/u)
  assert.match(skill, /Do not retry/u)

  const workflow = skill.slice(skill.indexOf('## Strict workflow'))
  const ordered = [
    'sanity_blog_check_config',
    'sanity_blog_prepare_publish',
    'sanity_blog_validate',
    'sanity_blog_preview',
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
  assert.match(skill, /publisherApiOrigin/u)
  assert.match(skill, /sanity_blog_start_config_setup/u)
  assert.match(skill, /four fields/u)
  assert.match(skill, /sanity_blog_preview/u)
  assert.match(skill, /Markdown view/u)
  assert.match(skill, /previewRevision/u)

  const workflow = skill.slice(skill.indexOf('## Strict workflow'))
  const ordered = [
    'sanity_blog_check_config',
    'sanity_blog_prepare_update',
    'sanity_blog_validate',
    'sanity_blog_preview',
    'sanity_blog_probe_update',
    'sanity_blog_commit',
    'sanity_blog_update',
  ].map((name) => workflow.indexOf(name))
  assert.ok(ordered.every((position) => position >= 0))
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
  assert.doesNotMatch(workflow, /sanity_blog_publish\(/u)
})

test('preview skill creates, validates, renders, and optionally keeps a local bundle without remote calls', async () => {
  const skill = await text('skills/sanity-blog-preview/SKILL.md')
  const agent = await text('skills/sanity-blog-preview/agents/openai.yaml')
  assert.match(agent, /allow_implicit_invocation:\s*false/u)
  assert.match(skill, /Markdown/u)
  assert.match(skill, /strict article JSON/iu)
  assert.match(skill, /real PNG cover/iu)
  assert.match(skill, /approximate/u)
  assert.match(skill, /zero remote requests/iu)
  assert.match(skill, /previewPath/u)
  assert.match(skill, /previewRevision/u)
  assert.match(skill, /not a Git commit/u)

  const workflow = skill.slice(skill.indexOf('## Strict workflow'))
  const firstPreview = workflow.indexOf('sanity_blog_preview')
  const commit = workflow.indexOf('sanity_blog_commit')
  const finalPreview = workflow.lastIndexOf('sanity_blog_preview')
  const ordered = [
    workflow.indexOf('sanity_blog_check_config'),
    workflow.indexOf('sanity_blog_prepare_publish'),
    workflow.indexOf('sanity_blog_validate'),
    firstPreview,
    commit,
    finalPreview,
  ]
  assert.ok(ordered.every((position) => position >= 0))
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
  assert.doesNotMatch(workflow, /sanity_blog_probe_(?:publish|update)\(/u)
  assert.doesNotMatch(workflow, /sanity_blog_(?:publish|update)\(/u)
})

test('skills inventory contains exactly seven types with three dedicated workflows', async () => {
  const entries = await readdir(path.join(pluginRoot, 'skills'), {
    withFileTypes: true,
  })
  const actualSkillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(actualSkillNames, expectedSkillNames)
  for (const removedName of removedGenericSkillNames) {
    assert.equal(
      actualSkillNames.includes(removedName),
      false,
      `${removedName} must not remain as a generic alias`,
    )
  }
})

test('dedicated rich-content skills pin one type and enforce operation-specific workflows', async (t) => {
  const operationContracts = {
    preview: {
      order: [
        'sanity_content_check_config',
        'sanity_content_prepare_publish',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_commit',
      ],
      requiredCalls: [
        'sanity_content_prepare_publish',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_commit',
        'sanity_content_release',
      ],
      forbiddenCalls:
        /sanity_content_(?:probe_publish|probe_update|publish|update)\(/u,
    },
    publish: {
      order: [
        'sanity_content_check_config',
        'sanity_content_prepare_publish',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_probe_publish',
        'sanity_content_commit',
        'sanity_content_publish',
      ],
      requiredCalls: [
        'sanity_content_prepare_publish',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_probe_publish',
        'sanity_content_commit',
        'sanity_content_release',
        'sanity_content_publish',
      ],
      forbiddenCalls: /sanity_content_(?:probe_update|update)\(/u,
    },
    update: {
      order: [
        'sanity_content_check_config',
        'sanity_content_prepare_update',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_probe_update',
        'sanity_content_commit',
        'sanity_content_update',
      ],
      requiredCalls: [
        'sanity_content_prepare_update',
        'sanity_content_validate',
        'sanity_content_preview',
        'sanity_content_probe_update',
        'sanity_content_commit',
        'sanity_content_release',
        'sanity_content_update',
      ],
      forbiddenCalls: /sanity_content_(?:probe_publish|publish)\(/u,
    },
  }

  for (const contentType of richContentTypes) {
    for (const operation of contentOperations) {
      const skillName = `sanity-content-${contentType}-${operation}`
      await t.test(skillName, async () => {
        const [skill, agent] = await Promise.all([
          text(`skills/${skillName}/SKILL.md`),
          text(`skills/${skillName}/agents/openai.yaml`),
        ])
        const contract = operationContracts[operation]

        assert.match(
          skill,
          new RegExp(`^---\\r?\\nname:\\s*${skillName}\\r?\\n`, 'u'),
        )
        assert.match(skill, /\ndescription:\s*[^\r\n]+\r?\n/u)
        assert.doesNotMatch(skill, /\[?TODO(?::|\])/u)
        assert.match(agent, /display_name:\s*["'][^"'\r\n]+["']/u)
        assert.match(agent, /short_description:\s*["'][^"'\r\n]+["']/u)
        assert.match(
          agent,
          new RegExp(`default_prompt:.*\\$${skillName}\\b`, 'u'),
        )
        assert.match(agent, /allow_implicit_invocation:\s*false/u)

        const literalTypes = [
          ...skill.matchAll(/contentType:\s*["']([^"']+)["']/gu),
        ].map((match) => match[1])
        assert.ok(
          literalTypes.length >= contract.requiredCalls.length,
          `${skillName} must pin contentType in every content tool signature`,
        )
        assert.deepEqual([...new Set(literalTypes)], [contentType])
        assert.doesNotMatch(skill, /\{contentType(?:[,}])/u)

        for (const toolName of contract.requiredCalls) {
          assert.match(
            skill,
            new RegExp(
              `${toolName}\\(\\{[^}\\r\\n]*contentType:\\s*["']${contentType}["'][^}\\r\\n]*\\}\\)`,
              'u',
            ),
          )
        }

        assert.match(skill, /previewRevision/u)
        assert.match(skill, /assetsDirectory/u)
        assert.doesNotMatch(skill, /sanity_blog_[a-z_]+\(/u)
        assert.doesNotMatch(skill, /\b(?:fetch|curl|Invoke-WebRequest)\s*\(/u)

        const workflowStart = skill.indexOf('## Workflow')
        assert.notEqual(workflowStart, -1)
        const workflow = skill.slice(workflowStart)
        const positions = contract.order.map((toolName) =>
          workflow.indexOf(toolName),
        )
        assert.ok(positions.every((position) => position >= 0))
        assert.deepEqual(
          [...positions].sort((left, right) => left - right),
          positions,
        )
        assert.doesNotMatch(workflow, contract.forbiddenCalls)

        if (operation === 'preview') {
          assert.match(skill, /no publisher API (?:request|probe)/iu)
        } else if (operation === 'publish') {
          assert.match(skill, /explicit confirmation/iu)
          assert.match(skill, /Never retry/iu)
          assert.match(skill, /partial success/iu)
        } else {
          assert.match(skill, /PUT-only/u)
          assert.match(
            skill,
            /omission (?:preserves|keeps) (?:the|an) [^\r\n.]*value/iu,
          )
          assert.match(
            skill,
            /(?:explicit(?: supported)?|supported) `null` clears/iu,
          )
          assert.match(skill, /never creates/iu)
        }

        if (contentType === 'blog-en') {
          assert.match(skill, /complete(?: API 1\.1)? SEO/iu)
          assert.match(skill, /canonical(?: HTTPS)? URLs?/iu)
          assert.match(skill, /publicSiteOrigin/u)
        } else {
          assert.doesNotMatch(
            skill,
            /(?:requires?|must have|retain valid)[^\r\n.]*canonical/iu,
          )
        }
      })
    }
  }
})

test('dedicated content skill generator is deterministic and current', async () => {
  const generatorPath = path.join(
    pluginRoot,
    'scripts',
    'generate-content-skills.mjs',
  )
  const result = await execFileAsync(process.execPath, [generatorPath, '--check'], {
    cwd: pluginRoot,
    windowsHide: true,
  })
  assert.equal(result.stderr, '')
})

test('one-click installer and minimal configuration are packaged', async () => {
  const installer = await text('install.ps1')
  const macInstaller = await text('install.sh')
  const configureInstall = await text('scripts/configure-install.mjs')
  const bundledCli = await text('dist/cli.mjs')
  const example = await json('config.example.json')

  assert.deepEqual(Object.keys(example), [
    'publisherApiOrigin',
    'publicSiteOrigin',
    'projectId',
    'dataset',
    'sanityToken',
  ])
  assert.match(installer, /NodeVersion = "22\.23\.1"/u)
  assert.match(installer, /SHASUMS256\.txt/u)
  assert.match(installer, /--omit=dev --ignore-scripts/u)
  assert.match(installer, /Test-SanityBlogConfiguration/u)
  assert.match(installer, /"dist\\cli\.mjs"/u)
  assert.match(
    installer,
    /\$installedCli = Join-Path \$resolvedInstallRoot "dist\\cli\.mjs"/u,
  )
  assert.match(bundledCli, /CONFIG_INPUT_REQUIRED/u)
  assert.match(configureInstall, /INSTALLED_BY_DEFAULT/u)
  assert.match(configureInstall, /ON_INSTALL/u)
  assert.match(configureInstall, /runtime["', ]+, "node\.exe"/u)
  assert.match(configureInstall, /runtime["', ]+, "bin"[, ]+["']node/u)
  assert.doesNotMatch(installer, /--(?:sanity-)?token\b/iu)
  assert.match(macInstaller, /NODE_VERSION="22\.23\.1"/u)
  assert.match(macInstaller, /darwin-arm64/u)
  assert.match(macInstaller, /darwin-x64/u)
  assert.match(macInstaller, /--runtime-platform macos/u)
  assert.match(macInstaller, /runtime\/bin\/node/u)
  assert.doesNotMatch(macInstaller, /--(?:sanity-)?token\b/iu)
})

test('README stays concise and covers only installation, initialization, and skills', async () => {
  const readme = await text('README.md')
  for (const phrase of [
    'codex plugin marketplace add https://github.com/1nv0ker/blog --ref main',
    'codex plugin add sanityblog@sanityblog',
    '不需要预先安装 Git、Node.js 或 npm',
    'raw.githubusercontent.com/1nv0ker/blog/main/install.ps1',
    'raw.githubusercontent.com/1nv0ker/blog/main/install.sh',
    'Apple Silicon',
    'runtime/bin/node',
    'Node.js 22.12',
    'npm install',
    'publisherApiOrigin',
    'projectId',
    'dataset',
    'sanityToken',
    '~/.sanity-blog/workspace',
    '--init',
    '--check',
    'sanity-blog-preview',
    'sanity-blog-publish',
    'sanity-blog-update',
    'previewRevision',
  ]) {
    assert.ok(readme.includes(phrase), `README is missing ${phrase}`)
  }
  assert.deepEqual(
    [...readme.matchAll(/^## .+$/gmu)].map(([heading]) => heading),
    ['## 如何安装', '## 如何初始化配置', '## 技能概览'],
  )
  assert.ok(readme.length < 5000, 'README should remain concise')
})
