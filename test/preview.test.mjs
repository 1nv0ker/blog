import assert from 'node:assert/strict'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import test from 'node:test'

import {prepareArticleSnapshot} from '../src/article.mjs'
import {renderArticlePreview} from '../src/preview.mjs'
import {PNG_BYTES, createArticleFixture, makeArticle} from './helpers.mjs'

test('renders validated JSON and sibling Markdown into one safe local HTML preview', async (t) => {
  const article = makeArticle('example-post', {localCover: true})
  article.body.en[0] = {
    _type: 'block',
    style: 'normal',
    markDefs: [
      {
        _type: 'link',
        _key: 'source',
        href: 'https://example.test/?a=1&b=2',
      },
    ],
    children: [
      {_type: 'span', text: '<script>alert("x")</script> ', marks: []},
      {_type: 'span', text: 'Safe source', marks: ['strong', 'source']},
    ],
  }
  const fixture = await createArticleFixture({article, localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const markdownPath = fixture.articlePath.replace(/\.json$/u, '.md')
  await writeFile(
    markdownPath,
    [
      '# Markdown <script>alert("md")</script>',
      '',
      'A **bold** paragraph with [a safe link](https://example.test/docs).',
      'An [unsafe link](javascript:alert(1)) must not become clickable.',
      '',
      '## Sources',
      '',
      '- [Example](https://example.test/)',
      '',
      '# 中文',
      '',
      '这里是 `Markdown` 预览。',
    ].join('\n'),
    'utf8',
  )

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const result = await renderArticlePreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.equal(result.approximate, true)
  assert.equal(result.source, 'article-json')
  assert.equal(result.markdownRendered, true)
  assert.match(result.previewRevision, /^[0-9a-f]{64}$/u)
  assert.equal(result.markdownPath, markdownPath)
  assert.equal(result.previewUrl.startsWith('file:'), true)
  assert.match(html, /Markdown visual preview/u)
  assert.match(html, /Source: validated article JSON/u)
  assert.match(html, /data:image\/png;base64,/u)
  assert.doesNotMatch(html, /\.\/assets\/example-post-cover\.png/u)
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u)
  assert.match(html, /Markdown &lt;script&gt;alert\(&quot;md&quot;\)&lt;\/script&gt;/u)
  assert.match(
    html,
    /<a href="https:\/\/example\.test\/\?a=1&amp;b=2"[^>]*><strong>Safe source<\/strong><\/a>/u,
  )
  assert.doesNotMatch(html, /href="javascript:/u)
  assert.match(html, /class="unsafe-link"/u)
  assert.doesNotMatch(html, /<script>/u)

  const coverPath = result.coverPath
  await writeFile(coverPath, Buffer.concat([PNG_BYTES, Buffer.from([0x01])]))
  assert.equal(await readFile(result.previewPath, 'utf8'), html)
  const changedAssetSnapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const changedAsset = await renderArticlePreview(changedAssetSnapshot)
  assert.notEqual(changedAsset.previewRevision, result.previewRevision)

  await writeFile(markdownPath, '# Changed Markdown\n\nA revised preview.\n', 'utf8')
  const revised = await renderArticlePreview(changedAssetSnapshot)
  assert.equal(revised.previewPath, result.previewPath)
  assert.notEqual(revised.previewRevision, changedAsset.previewRevision)
})

test('preview requires a regular non-empty sibling Markdown file', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })

  await assert.rejects(
    renderArticlePreview(snapshot),
    (error) => error.code === 'PREVIEW_MARKDOWN_INVALID',
  )
})

test('preview revision binds exact Markdown bytes including a UTF-8 BOM', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const markdownPath = fixture.articlePath.replace(/\.json$/u, '.md')
  const markdown = Buffer.from('# Same rendering\n\nSame text.\n', 'utf8')
  await writeFile(markdownPath, markdown)
  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const withoutBom = await renderArticlePreview(snapshot)

  await writeFile(
    markdownPath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), markdown]),
  )
  const withBom = await renderArticlePreview(snapshot)
  assert.notEqual(withBom.previewRevision, withoutBom.previewRevision)
})

test('preview never replaces a non-file target', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(
    fixture.articlePath.replace(/\.json$/u, '.md'),
    '# English\n\nPreview.\n\n# 中文\n\n预览。\n',
    'utf8',
  )
  await mkdir(fixture.articlePath.replace(/\.json$/u, '.preview.html'))
  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })

  await assert.rejects(
    renderArticlePreview(snapshot),
    (error) => error.code === 'PREVIEW_PATH_UNSAFE',
  )
})
