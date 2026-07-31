import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {prepareContentSnapshot} from '../src/content-article.mjs'
import {
  ContentPreviewError,
  renderContentPreview,
} from '../src/content-preview.mjs'

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
)
const MP4_BYTES = Buffer.from(
  '000000186674797069736f6d0000020069736f6d',
  'hex',
)
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'ascii')

function textBlock(text, overrides = {}) {
  return {
    _type: 'block',
    style: 'normal',
    markDefs: [],
    children: [{_type: 'span', text, marks: []}],
    ...overrides,
  }
}

function richArticle(slug = 'rich-preview') {
  return {
    title: {
      en: 'A safe rich-content preview',
      zh: '安全的富内容预览',
    },
    slug,
    excerpt: {
      en: 'English excerpt for the preview.',
      zh: '用于预览的中文摘要。',
    },
    coverImage: {
      source: {path: './assets/shared.png'},
      alt: {en: 'Cover alt', zh: '封面替代文本'},
    },
    body: {
      en: [
        textBlock('Heading two', {style: 'h2'}),
        textBlock('Heading three', {style: 'h3'}),
        textBlock('Heading four', {style: 'h4'}),
        textBlock('Heading five', {style: 'h5'}),
        textBlock('Heading six', {style: 'h6'}),
        {
          _type: 'block',
          style: 'normal',
          listItem: 'bullet',
          level: 1,
          markDefs: [
            {
              _type: 'link',
              _key: 'docs',
              href: 'docs/reference?a=1&b=2',
            },
          ],
          children: [
            {
              _type: 'span',
              text: '<script>alert("body")</script> linked item',
              marks: ['strong', 'underline', 'docs'],
            },
          ],
        },
        {
          _type: 'image',
          source: {path: './assets/shared.png'},
          alt: 'Body image alt',
          caption: 'Validated local image bytes',
        },
        {
          _type: 'code',
          language: 'html',
          code: '</code><script>alert("code")</script>',
        },
        {
          _type: 'video',
          sourceType: 'external',
          url: 'https://www.youtube.com/watch?v=preview',
          title: 'External video title',
          caption: 'A safe link, never an embed.',
          poster: {
            source: {path: './assets/shared.png'},
            alt: 'External video poster',
          },
        },
        {
          _type: 'video',
          sourceType: 'upload',
          source: {path: './assets/clip.mp4'},
          title: 'Uploaded video title',
          caption: 'Metadata only.',
          poster: {
            source: {path: './assets/shared.png'},
            alt: 'Uploaded video poster',
          },
        },
        {
          _type: 'attachment',
          source: {path: './assets/brief.pdf'},
          title: 'Downloadable brief',
        },
        {
          _type: 'callout',
          tone: 'warning',
          title: 'Review this warning',
          body: [textBlock('Callout body with <unsafe> text.')],
        },
        {
          _type: 'table',
          headerRows: 1,
          rows: [
            {
              _type: 'row',
              cells: [
                {_type: 'cell', value: [textBlock('Column A')]},
                {_type: 'cell', value: [textBlock('Column B')]},
              ],
            },
            {
              _type: 'row',
              cells: [
                {_type: 'cell', value: [textBlock('Value A')]},
                {_type: 'cell', value: [textBlock('Value B')]},
              ],
            },
          ],
        },
      ],
      zh: [
        textBlock('中文标题', {style: 'h2'}),
        textBlock('中文正文。'),
      ],
    },
    seo: {
      title: {
        en: 'Rich preview SEO title',
        zh: '富内容预览 SEO 标题',
      },
      description: {
        en: 'A complete English SEO description.',
        zh: '完整的中文 SEO 描述。',
      },
      keywords: {
        en: ['preview', 'rich content'],
        zh: ['预览', '富内容'],
      },
      canonicalUrl: {
        en: `https://content.example.com/en/${slug}`,
        zh: `https://content.example.com/zh/${slug}`,
      },
      openGraph: {
        title: {
          en: 'Open Graph English title',
          zh: 'Open Graph 中文标题',
        },
        description: {
          en: 'Open Graph English description.',
          zh: 'Open Graph 中文描述。',
        },
        image: {
          source: {path: './assets/shared.png'},
          alt: {en: 'Open Graph image', zh: 'Open Graph 图片'},
        },
      },
      robots: {index: false, follow: true},
    },
  }
}

async function createFixture({
  article = richArticle(),
  assets = {
    'shared.png': PNG_BYTES,
    'clip.mp4': MP4_BYTES,
    'brief.pdf': PDF_BYTES,
  },
  contentType = 'guide',
  markdown,
} = {}) {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), 'sanityblog-content-preview-'),
  )
  const articleDirectory = path.join(
    workspaceRoot,
    'contents',
    contentType,
    article.slug,
  )
  const assetsDirectory = path.join(articleDirectory, 'assets')
  await mkdir(assetsDirectory, {recursive: true})
  const articlePath = path.join(articleDirectory, `${article.slug}.json`)
  const markdownPath = path.join(articleDirectory, `${article.slug}.md`)
  await writeFile(articlePath, `${JSON.stringify(article)}\n`, 'utf8')
  if (markdown !== null) {
    await writeFile(
      markdownPath,
      markdown ?? [
        '# English <script>alert("markdown")</script>',
        '',
        'A **safe** Markdown view with [docs](https://example.com/docs).',
        'An [unsafe link](javascript:alert(1)) is not clickable.',
        '',
        '# 中文',
        '',
        '安全的 `Markdown` 预览。',
      ].join('\n'),
      'utf8',
    )
  }
  for (const [filename, bytes] of Object.entries(assets)) {
    await writeFile(path.join(assetsDirectory, filename), bytes)
  }
  return {
    article,
    articlePath,
    articleDirectory,
    assetsDirectory,
    markdownPath,
    workspaceRoot,
    config: {
      workspaceRoot,
      publicSiteOrigin: 'https://content.example.com',
    },
  }
}

test('renders every rich content item, full bilingual SEO, and safe asset treatment', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const snapshot = await prepareContentSnapshot('guide', fixture.articlePath, {
    config: fixture.config,
  })

  const result = await renderContentPreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.equal(result.ok, true)
  assert.equal(result.source, 'content-json')
  assert.equal(result.contentType, 'guide')
  assert.equal(result.slug, fixture.article.slug)
  assert.equal(result.articlePath, fixture.articlePath)
  assert.equal(result.markdownPath, fixture.markdownPath)
  assert.equal(
    result.previewPath,
    path.join(path.dirname(fixture.articleDirectory), 'rich-preview.preview.html'),
  )
  assert.match(result.previewRevision, /^[0-9a-f]{64}$/u)
  assert.deepEqual(result.bodyBlocks, {en: 13, zh: 2})
  assert.equal(result.localAssetCount, 3)
  assert.equal(result.totalAssetBytes, PNG_BYTES.length + MP4_BYTES.length + PDF_BYTES.length)
  assert.deepEqual(result.assetCounts, {image: 1, video: 1, attachment: 1})

  for (const level of [2, 3, 4, 5, 6]) {
    assert.match(html, new RegExp(`<h${level}>Heading`, 'u'))
  }
  assert.match(html, /<ul><li class="list-level-1">/u)
  assert.match(html, /class="callout callout--warning"/u)
  assert.match(html, /<table>/u)
  assert.match(html, /<thead>/u)
  assert.match(html, /<tbody>/u)
  assert.match(html, /data:image\/png;base64,/u)
  assert.match(html, /Validated local image bytes/u)
  assert.match(html, /Open Graph English title/u)
  assert.match(html, /https:\/\/content\.example\.com\/en\/rich-preview/u)
  assert.match(html, /robots/u)
  assert.match(html, /index: false/u)

  assert.match(
    html,
    /href="https:\/\/www\.youtube\.com\/watch\?v=preview"[^>]*>Open external video/u,
  )
  assert.match(html, /Uploaded video · metadata only/u)
  assert.match(html, /clip\.mp4/u)
  assert.match(html, /Attachment · metadata only/u)
  assert.match(html, /brief\.pdf/u)
  assert.doesNotMatch(html, /<iframe\b/iu)
  assert.doesNotMatch(html, /<video\b/iu)
  assert.doesNotMatch(html, /data:video\//iu)
  assert.doesNotMatch(html, /href="[^"]*brief\.pdf/iu)

  assert.match(
    html,
    /&lt;script&gt;alert\(&quot;body&quot;\)&lt;\/script&gt;/u,
  )
  assert.match(
    html,
    /&lt;\/code&gt;&lt;script&gt;alert\(&quot;code&quot;\)&lt;\/script&gt;/u,
  )
  assert.match(
    html,
    /English &lt;script&gt;alert\(&quot;markdown&quot;\)&lt;\/script&gt;/u,
  )
  assert.doesNotMatch(html, /<script\b/iu)
  assert.doesNotMatch(html, /href="javascript:/iu)
  assert.match(html, /class="unsafe-link"/u)
  assert.match(
    html,
    /href="docs\/reference\?a=1&amp;b=2"[^>]*><u><strong>/u,
  )

  assert.ok(
    result.warnings.some((warning) => /no iframe is embedded/u.test(warning)),
  )
  assert.ok(
    result.warnings.some((warning) => /local video occurrence/u.test(warning)),
  )
  assert.ok(
    result.warnings.some((warning) => /local attachment occurrence/u.test(warning)),
  )
})

test('supports omitted cover and SEO while still requiring sibling Markdown', async (t) => {
  const article = richArticle('optional-fields')
  article.coverImage = null
  article.seo = null
  article.body.en = [textBlock('English body')]
  article.body.zh = [textBlock('中文正文')]
  const fixture = await createFixture({
    article,
    assets: {},
    contentType: 'tutorial',
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  const snapshot = await prepareContentSnapshot('tutorial', fixture.articlePath, {
    config: fixture.config,
  })
  const result = await renderContentPreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.equal(result.contentType, 'tutorial')
  assert.equal(result.localAssetCount, 0)
  assert.match(html, /Optional cover not supplied/u)
  assert.match(html, /Optional SEO metadata not supplied/u)

  const missingMarkdown = await createFixture({
    article: {...article, slug: 'missing-markdown'},
    assets: {},
    markdown: null,
  })
  t.after(() => rm(missingMarkdown.workspaceRoot, {recursive: true, force: true}))
  const missingSnapshot = await prepareContentSnapshot(
    'guide',
    missingMarkdown.articlePath,
    {config: missingMarkdown.config},
  )
  await assert.rejects(
    renderContentPreview(missingSnapshot),
    (error) =>
      error instanceof ContentPreviewError &&
      error.code === 'CONTENT_PREVIEW_MARKDOWN_INVALID',
  )
})

test('preview revision binds content type, exact and normalized JSON, Markdown bytes, and asset bytes', async (t) => {
  const article = richArticle('revision-binding')
  const fixture = await createFixture({article})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  const firstSnapshot = await prepareContentSnapshot('guide', fixture.articlePath, {
    config: fixture.config,
  })
  const first = await renderContentPreview(firstSnapshot)

  await writeFile(
    fixture.articlePath,
    `${JSON.stringify(article, null, 2)}\n`,
    'utf8',
  )
  const whitespaceSnapshot = await prepareContentSnapshot(
    'guide',
    fixture.articlePath,
    {config: fixture.config},
  )
  assert.deepEqual(whitespaceSnapshot.article, firstSnapshot.article)
  const whitespace = await renderContentPreview(whitespaceSnapshot)
  assert.notEqual(whitespace.previewRevision, first.previewRevision)

  const markdownBytes = await readFile(fixture.markdownPath)
  await writeFile(
    fixture.markdownPath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), markdownBytes]),
  )
  const withBom = await renderContentPreview(whitespaceSnapshot)
  assert.notEqual(withBom.previewRevision, whitespace.previewRevision)

  await writeFile(
    path.join(fixture.assetsDirectory, 'brief.pdf'),
    Buffer.concat([PDF_BYTES, Buffer.from('% changed bytes\n', 'ascii')]),
  )
  const changedAssetSnapshot = await prepareContentSnapshot(
    'guide',
    fixture.articlePath,
    {config: fixture.config},
  )
  const changedAsset = await renderContentPreview(changedAssetSnapshot)
  assert.notEqual(changedAsset.previewRevision, withBom.previewRevision)

  const otherType = await createFixture({
    article,
    contentType: 'comparison',
  })
  t.after(() => rm(otherType.workspaceRoot, {recursive: true, force: true}))
  const otherTypeSnapshot = await prepareContentSnapshot(
    'comparison',
    otherType.articlePath,
    {config: otherType.config},
  )
  const otherTypePreview = await renderContentPreview(otherTypeSnapshot)
  assert.notEqual(otherTypePreview.previewRevision, first.previewRevision)
})

test('never replaces a non-file preview target', async (t) => {
  const article = richArticle('unsafe-preview-target')
  article.coverImage = null
  article.seo = null
  article.body.en = [textBlock('English body')]
  article.body.zh = [textBlock('中文正文')]
  const fixture = await createFixture({
    article,
    assets: {},
    contentType: 'solution',
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await mkdir(
    path.join(
      path.dirname(fixture.articleDirectory),
      `${article.slug}.preview.html`,
    ),
  )
  const snapshot = await prepareContentSnapshot('solution', fixture.articlePath, {
    config: fixture.config,
  })

  await assert.rejects(
    renderContentPreview(snapshot),
    (error) =>
      error instanceof ContentPreviewError &&
      error.code === 'CONTENT_PREVIEW_PATH_UNSAFE',
  )
})
