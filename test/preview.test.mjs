import assert from 'node:assert/strict'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {prepareArticleSnapshot} from '../src/article.mjs'
import {renderArticlePreview} from '../src/preview.mjs'
import {
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  createArticleFixture,
  makeArticle,
} from './helpers.mjs'

const nestedBlock = (text) => ({
  _type: 'block',
  children: [{_type: 'span', text}],
})

const previewCta = () => ({
  _type: 'cta',
  heading: 'Continue',
  primaryAction: {label: 'Start', href: '/start'},
})

const previewMediaText = (assetRef = 'image-template-1600x900-png') => ({
  _type: 'mediaText',
  heading: 'Feature',
  body: [nestedBlock('Feature explanation.')],
  image: {source: {assetRef}, alt: 'Feature diagram'},
})

const previewFaq = () => ({
  _type: 'faqSection',
  heading: 'Questions',
  items: [{question: 'Why?', answer: [nestedBlock('Because it is useful.')]}],
})

function withPreviewTemplate(article, template) {
  const body = {
    default: [nestedBlock('Editorial body.')],
    productExplainer: [previewMediaText(), previewFaq(), previewCta()],
    alternatingContent: [
      previewMediaText('image-templateone-1600x900-png'),
      previewMediaText('image-templatetwo-1600x900-png'),
      previewCta(),
    ],
    alternative: [
      {
        _type: 'table',
        rows: [
          {cells: [{value: [nestedBlock('Option')]}, {value: [nestedBlock('Fit')]}]},
        ],
      },
      previewFaq(),
      previewCta(),
    ],
    tutorial: [
      {
        _type: 'tutorialSteps',
        heading: 'Steps',
        steps: [
          {title: 'First', body: [nestedBlock('Do this.')]},
          {title: 'Second', body: [{_type: 'code', code: 'npm test'}]},
        ],
      },
      previewFaq(),
      previewCta(),
    ],
    solution: [previewMediaText(), previewCta()],
    faq: [previewFaq(), previewCta()],
    caseStudy: [previewMediaText(), previewCta()],
  }[template]
  article.template = template
  article.body.en = structuredClone(body)
  article.body.zh = structuredClone(body)
  return article
}

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
  assert.match(
    html,
    /class="preview-asset-payload" type="application\/octet-stream"[^>]+data-preview-mime="image\/png"/u,
  )
  assert.doesNotMatch(html, /src="data:/u)
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

test('renders full SEO and only validated local images from JSON and Markdown', async (t) => {
  const article = makeArticle('seo-image-post', {localCover: true})
  const bodyImagePath = './assets/seo-image-post-architecture.png'
  article.body.en.push({
    _type: 'image',
    source: {path: bodyImagePath},
    alt: 'Architecture flow <safe>',
  })
  article.body.zh.push({
    _type: 'image',
    source: {path: bodyImagePath},
    alt: '架构流程图',
  })
  article.seo = {
    ...article.seo,
    keywords: {
      en: ['proxy architecture', 'reliability'],
      zh: ['代理架构', '可靠性'],
    },
    canonicalUrl: {
      en: 'https://miyaip.com/en/blog/seo-image-post?source=preview&lang=en',
      zh: 'https://miyaip.com/zh/blog/seo-image-post?source=preview&lang=zh',
    },
    openGraph: {
      title: {
        en: 'Architecture preview <English>',
        zh: '架构预览',
      },
      description: {
        en: 'A safe Open Graph description.',
        zh: '安全的 Open Graph 描述。',
      },
      image: {
        source: {path: bodyImagePath},
        alt: {
          en: 'Open Graph architecture image',
          zh: 'Open Graph 架构图片',
        },
      },
    },
    robots: {index: false, follow: true},
    sitemap: {include: false},
  }
  const fixture = await createArticleFixture({
    slug: 'seo-image-post',
    article,
    localCover: true,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(
    `${fixture.assetsRoot}/seo-image-post-architecture.png`,
    PNG_BYTES,
  )
  await writeFile(
    `${fixture.assetsRoot}/seo-image-post-unreferenced.png`,
    PNG_BYTES,
  )
  const markdownPath = fixture.articlePath.replace(/\.json$/u, '.md')
  await writeFile(
    markdownPath,
    [
      '# English',
      '',
      '![Validated architecture](./assets/seo-image-post-architecture.png "Architecture")',
      '',
      '![Unreferenced on disk](./assets/seo-image-post-unreferenced.png)',
      '',
      '![External tracker](https://tracker.invalid/pixel.png)',
      '',
      '![Local file](file:///private/secret.png)',
      '',
      '# 中文',
      '',
      '正文。',
    ].join('\n'),
    'utf8',
  )

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const result = await renderArticlePreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.match(html, /Full SEO preview/u)
  assert.match(html, /proxy architecture, reliability/u)
  assert.match(html, /代理架构, 可靠性/u)
  assert.match(
    html,
    /https:\/\/miyaip\.com\/en\/blog\/seo-image-post\?source=preview&amp;lang=en/u,
  )
  assert.match(html, /Architecture preview &lt;English&gt;/u)
  assert.match(html, /noindex, follow/u)
  assert.match(html, /<dt>Sitemap<\/dt><dd>Excluded<\/dd>/u)
  assert.match(html, /class="body-image"/u)
  assert.match(html, /alt="Architecture flow &lt;safe&gt;"/u)
  assert.match(html, /class="seo-image"/u)
  assert.match(html, /alt="Open Graph architecture image"/u)
  assert.match(
    html,
    /<img class="markdown-image" data-preview-asset="preview-asset-[0-9a-f]{64}" alt="Validated architecture" decoding="async">/u,
  )
  assert.equal(html.split(PNG_BYTES.toString('base64')).length - 1, 1)
  assert.equal(
    (html.match(/data-preview-asset="preview-asset-[0-9a-f]{64}"/gu) ?? [])
      .length >= 6,
    true,
  )
  assert.equal(
    (html.match(/class="preview-asset-payload"/gu) ?? []).length,
    1,
  )
  assert.equal((html.match(/class="unsafe-image"/gu) ?? []).length, 3)
  assert.doesNotMatch(html, /tracker\.invalid/u)
  assert.doesNotMatch(html, /file:\/\/\//u)
  assert.doesNotMatch(html, /seo-image-post-unreferenced\.png/u)
  assert.match(
    html,
    /Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src blob:; script-src 'nonce-[0-9a-f]{32}';/u,
  )

  await writeFile(
    `${fixture.assetsRoot}/seo-image-post-architecture.png`,
    Buffer.concat([PNG_BYTES, Buffer.from([0x01])]),
  )
  const changedImageSnapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const changedImagePreview = await renderArticlePreview(changedImageSnapshot)
  assert.notEqual(changedImagePreview.previewRevision, result.previewRevision)
})

test('shows publisher-derived canonical status and remote Open Graph placeholders', async (t) => {
  const article = makeArticle('remote-og-post', {localCover: true})
  article.seo.openGraph = {
    image: {
      source: {assetRef: 'image-ogasset-1200x630-png'},
      alt: {
        en: 'Remote Open Graph image',
        zh: '远程 Open Graph 图片',
      },
    },
  }
  article.seo.robots = {index: false}
  article.seo.sitemap = {}
  const fixture = await createArticleFixture({
    slug: 'remote-og-post',
    article,
    localCover: true,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(
    fixture.articlePath.replace(/\.json$/u, '.md'),
    '# English\n\nPreview.\n\n# 中文\n\n预览。\n',
    'utf8',
  )

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const result = await renderArticlePreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.match(
    html,
    /Derived by the publisher from the site origin and slug/u,
  )
  assert.equal(
    (html.match(/Remote Sanity Open Graph image/gu) ?? []).length,
    2,
  )
  assert.equal(
    result.warnings.some((warning) => warning.includes('1 remote Sanity image is')),
    true,
  )
  assert.match(html, /noindex, follow \(publisher default\)/u)
  assert.match(html, /Included \(publisher default\)/u)
  assert.doesNotMatch(html, /image-ogasset-1200x630-png/u)
})

test('renders production-like hero and module structures for all Blog Post templates', async (t) => {
  const expectations = {
    default: ['data-blog-template="default"', 'hero--default'],
    productExplainer: [
      'template-hero--split',
      'class="media-text',
      'class="faq-section',
      'container-type: inline-size',
      '@container (max-width: 620px)',
    ],
    alternatingContent: ['template-hero--split', 'media-text--right', 'media-text--left'],
    alternative: ['template-hero--compact', 'class="table-scroll"', 'class="faq-section'],
    tutorial: ['template-hero--compact', 'class="tutorial-nav"', 'class="tutorial-step"'],
    solution: ['template-hero--split', 'class="media-text', 'class="cta-card'],
    faq: ['template-hero--compact', '<details>', 'class="cta-card'],
    caseStudy: ['template-hero--editorial', 'class="media-text', 'class="cta-card'],
  }

  for (const [template, markers] of Object.entries(expectations)) {
    const slug = `preview-${template.toLowerCase()}`
    const article = withPreviewTemplate(makeArticle(slug), template)
    const fixture = await createArticleFixture({slug, article})
    t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
    await writeFile(
      fixture.articlePath.replace(/\.json$/u, '.md'),
      '# English\n\nPreview.\n\n# 中文\n\n预览。\n',
      'utf8',
    )
    const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
      config: fixture.config,
    })
    const result = await renderArticlePreview(snapshot)
    const html = await readFile(result.previewPath, 'utf8')
    assert.equal(result.template, template)
    assert.match(html, new RegExp(`data-blog-template="${template}"`, 'u'))
    for (const marker of markers) {
      assert.ok(html.includes(marker), `${template} preview is missing ${marker}`)
    }
  }
})

test('plays validated local video, links external video, and keeps attachments metadata-only', async (t) => {
  const article = makeArticle('preview-mixed-media', {localCover: true})
  const modules = [
    {
      _type: 'video',
      sourceType: 'upload',
      source: {path: './assets/preview-mixed-media-demo.mp4'},
      title: 'Validated demo',
      poster: {
        source: {path: './assets/preview-mixed-media-poster.png'},
        alt: 'Demo poster',
      },
    },
    {
      _type: 'video',
      sourceType: 'external',
      url: 'https://www.youtube.com/watch?v=example',
      title: 'External demo',
    },
    {
      _type: 'attachment',
      source: {path: './assets/preview-mixed-media-guide.pdf'},
      title: 'Downloadable guide',
    },
  ]
  article.body.en = structuredClone(modules)
  article.body.zh = structuredClone(modules)
  const fixture = await createArticleFixture({
    slug: article.slug,
    article,
    localCover: true,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(path.join(fixture.assetsRoot, 'preview-mixed-media-demo.mp4'), MP4_BYTES)
  await writeFile(path.join(fixture.assetsRoot, 'preview-mixed-media-poster.png'), PNG_BYTES)
  await writeFile(path.join(fixture.assetsRoot, 'preview-mixed-media-guide.pdf'), PDF_BYTES)
  await writeFile(
    fixture.articlePath.replace(/\.json$/u, '.md'),
    '# English\n\nMedia preview.\n\n# 中文\n\n媒体预览。\n',
    'utf8',
  )

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const result = await renderArticlePreview(snapshot)
  const html = await readFile(result.previewPath, 'utf8')

  assert.equal(result.localAssetCount, 4)
  assert.deepEqual(result.assetCounts, {image: 2, video: 1, attachment: 1})
  assert.match(
    html,
    /<video class="local-video" controls preload="metadata" playsinline data-preview-asset=/u,
  )
  assert.doesNotMatch(html, /<video[^>]+\sautoplay(?:\s|>)/u)
  assert.match(html, /data-preview-mime="video\/mp4"/u)
  assert.match(
    html,
    /href="https:\/\/www\.youtube\.com\/watch\?v=example"[^>]*>Open external video<\/a>/u,
  )
  assert.doesNotMatch(html, /<iframe/u)
  assert.match(html, /Attachment · metadata only/u)
  assert.match(html, /preview-mixed-media-guide\.pdf/u)
  assert.doesNotMatch(html, new RegExp(PDF_BYTES.toString('base64'), 'u'))
})
