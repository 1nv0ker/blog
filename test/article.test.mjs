import assert from 'node:assert/strict'
import {rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_ARTICLE_BYTES,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_TOTAL_BYTES,
  materializeArticleRequest,
  prepareArticleSnapshot,
} from '../src/article.mjs'
import {
  PNG_BYTES,
  createArticleFixture,
  makeArticle,
} from './helpers.mjs'

test('validates a local article and materializes immutable create/update bodies', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  assert.equal(snapshot.slug, 'example-post')
  assert.equal(snapshot.localImageCount, 1)
  assert.match(snapshot.contentSha256, /^[0-9a-f]{64}$/u)

  const publishedAt = '2026-07-18T12:00:00.000Z'
  const createRequest = materializeArticleRequest(snapshot, {createPublishedAt: publishedAt})
  const updateRequest = materializeArticleRequest(snapshot, {forUpdate: true})
  assert.equal(createRequest.article.publishedAt, publishedAt)
  assert.equal('publishedAt' in updateRequest.article, false)
  assert.ok(createRequest.body instanceof FormData)
  assert.ok(updateRequest.body instanceof FormData)
  assert.equal(snapshot.article.publishedAt, '2026-07-18T00:00:00.000Z')
})

test('accepts complete optional SEO without materializing omitted defaults', async (t) => {
  const article = makeArticle()
  article.seo = {
    ...article.seo,
    keywords: {
      en: ['proxy infrastructure', 'reliability'],
      zh: ['代理基础设施', '可靠性'],
    },
    canonicalUrl: {
      en: 'https://content.example.test/en/blog/example-post',
      zh: 'https://content.example.test/zh/blog/example-post',
    },
    openGraph: {
      title: {
        en: 'Reliable proxy infrastructure',
        zh: '可靠的代理基础设施',
      },
      description: {
        en: 'A practical introduction to reliable proxy infrastructure.',
        zh: '可靠代理基础设施的实用介绍。',
      },
      image: {
        source: {assetRef: 'image-ogasset-1200x630-webp'},
        alt: {
          en: 'A proxy infrastructure diagram',
          zh: '代理基础设施示意图',
        },
      },
    },
    robots: {index: false},
    sitemap: {},
  }
  const fixture = await createArticleFixture({article})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: {
      ...fixture.config,
      publicSiteOrigin: 'https://content.example.test',
    },
  })
  const request = materializeArticleRequest(snapshot, {forUpdate: true})
  assert.deepEqual(request.article.seo, article.seo)

  const legacyFixture = await createArticleFixture()
  t.after(() => rm(legacyFixture.workspaceRoot, {recursive: true, force: true}))
  const legacySnapshot = await prepareArticleSnapshot(legacyFixture.articlePath, {
    config: legacyFixture.config,
  })
  const legacyRequest = materializeArticleRequest(legacySnapshot, {forUpdate: true})
  for (const field of ['keywords', 'canonicalUrl', 'openGraph', 'robots', 'sitemap']) {
    assert.equal(Object.hasOwn(legacyRequest.article.seo, field), false)
  }
})

test('keeps the legacy body image assetRef contract unchanged', async (t) => {
  const article = makeArticle('legacy-body-image')
  article.body.en.push({
    _type: 'image',
    source: {assetRef: 'image-existingasset-1600x900-custom'},
    alt: 'An existing explanatory image',
  })
  article.body.zh.push({
    _type: 'image',
    source: {assetRef: 'image-existingasset-1600x900-custom'},
    alt: '现有说明图片',
  })
  const fixture = await createArticleFixture({
    slug: article.slug,
    article,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  const request = materializeArticleRequest(snapshot, {forUpdate: true})
  assert.equal(snapshot.localImageCount, 0)
  assert.equal(Buffer.isBuffer(request.body), true)
  assert.deepEqual(request.article.body.en.at(-1), article.body.en.at(-1))
  assert.deepEqual(request.article.body.zh.at(-1), article.body.zh.at(-1))
})

test('validates enhanced SEO values and canonical origin', async (t) => {
  const cases = [
    {
      mutate(seo) {
        seo.keywords = {en: ['duplicate', 'duplicate'], zh: ['关键词']}
      },
      issuePath: 'seo.keywords.en',
    },
    {
      mutate(seo) {
        seo.canonicalUrl = {
          en: 'https://miyaip.com/en/blog/example-post',
          zh: 'https://miyaip.com/en/blog/example-post',
        }
      },
      issuePath: 'seo.canonicalUrl.zh',
    },
    {
      mutate(seo) {
        seo.openGraph = {
          image: {
            source: {assetRef: 'image-ogasset-1200x630-pdf'},
            alt: {en: 'OG image', zh: 'OG 图片'},
          },
        }
      },
      issuePath: 'seo.openGraph.image.source.assetRef',
    },
    {
      mutate(seo) {
        seo.robots = {index: 'yes'}
      },
      issuePath: 'seo.robots.index',
    },
    {
      mutate(seo) {
        seo.sitemap = {include: 'yes'}
      },
      issuePath: 'seo.sitemap.include',
    },
  ]

  for (const [index, scenario] of cases.entries()) {
    const article = makeArticle(`invalid-seo-${index}`)
    scenario.mutate(article.seo)
    const fixture = await createArticleFixture({
      slug: article.slug,
      article,
    })
    t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
    await assert.rejects(
      prepareArticleSnapshot(fixture.articlePath, {config: fixture.config}),
      (error) =>
        error.code === 'ARTICLE_SCHEMA_INVALID' &&
        error.details?.issues?.some((issue) => issue.path === scenario.issuePath),
    )
  }

  const wrongOrigin = makeArticle('wrong-origin')
  wrongOrigin.seo.canonicalUrl = {
    en: 'https://other.example.test/en/blog/wrong-origin',
    zh: 'https://other.example.test/zh/blog/wrong-origin',
  }
  const originFixture = await createArticleFixture({
    slug: wrongOrigin.slug,
    article: wrongOrigin,
  })
  t.after(() => rm(originFixture.workspaceRoot, {recursive: true, force: true}))
  await assert.rejects(
    prepareArticleSnapshot(originFixture.articlePath, {
      config: {
        ...originFixture.config,
        publicSiteOrigin: 'https://content.example.test',
      },
    }),
    (error) =>
      error.code === 'ARTICLE_SCHEMA_INVALID' &&
      error.details?.issues?.every((issue) =>
        issue.path.startsWith('seo.canonicalUrl.')),
  )
})

test('strict schema rejects unknown fields and unsafe link protocols', async (t) => {
  const article = makeArticle()
  article.unexpected = true
  article.body.en[0].markDefs = [
    {_type: 'link', _key: 'unsafe', href: 'javascript:alert(1)'},
  ]
  article.body.en[0].children[0].marks = ['unsafe']
  const fixture = await createArticleFixture({article})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  await assert.rejects(
    prepareArticleSnapshot(fixture.articlePath, {config: fixture.config}),
    (error) => error.code === 'ARTICLE_SCHEMA_INVALID',
  )
})

test('rejects image bytes that do not match the declared extension', async (t) => {
  const fixture = await createArticleFixture({localCover: true})
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(
    path.join(fixture.assetsRoot, 'example-post-cover.png'),
    Buffer.from('not a png'),
  )

  await assert.rejects(
    prepareArticleSnapshot(fixture.articlePath, {config: fixture.config}),
    (error) => error.code === 'ASSET_FORMAT_INVALID',
  )
})

test('collects and deduplicates cover, body, and Open Graph local images', async (t) => {
  const article = makeArticle('local-images', {localCover: true})
  const bodyImage = {
    _type: 'image',
    source: {path: './assets/local-images-body.png'},
    alt: 'A local explanatory diagram',
  }
  article.body.en.push(bodyImage)
  article.body.zh.push({
    ...bodyImage,
    alt: '本地说明图',
  })
  article.seo.openGraph = {
    image: {
      source: {path: './assets/local-images-og.png'},
      alt: {
        en: 'A social preview of the explanatory diagram',
        zh: '说明图的社交分享预览',
      },
    },
  }
  const fixture = await createArticleFixture({
    slug: article.slug,
    localCover: true,
    article,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))
  await writeFile(path.join(fixture.assetsRoot, 'local-images-body.png'), PNG_BYTES)
  await writeFile(path.join(fixture.assetsRoot, 'local-images-og.png'), PNG_BYTES)

  const snapshot = await prepareArticleSnapshot(fixture.articlePath, {
    config: fixture.config,
  })
  assert.equal(snapshot.localImageCount, 3)
  assert.equal(snapshot.totalAssetBytes, PNG_BYTES.length * 3)

  const request = materializeArticleRequest(snapshot, {forUpdate: true})
  assert.ok(request.body instanceof FormData)
  const parts = [...request.body.entries()]
  assert.equal(parts.filter(([name]) => name === 'article').length, 1)
  assert.deepEqual(
    parts
      .filter(([name]) => name === 'assets')
      .map(([, value]) => value.name)
      .sort(),
    ['local-images-body.png', 'local-images-cover.png', 'local-images-og.png'],
  )
})

test('rejects case-ambiguous local image paths before reading assets', async (t) => {
  const article = makeArticle('case-ambiguous-images')
  article.body.en.push({
    _type: 'image',
    source: {path: './assets/case-ambiguous-images-flow.png'},
    alt: 'A request flow',
  })
  article.body.zh.push({
    _type: 'image',
    source: {path: './assets/CASE-AMBIGUOUS-IMAGES-FLOW.PNG'},
    alt: '请求流程',
  })
  const fixture = await createArticleFixture({
    slug: article.slug,
    article,
  })
  t.after(() => rm(fixture.workspaceRoot, {recursive: true, force: true}))

  await assert.rejects(
    prepareArticleSnapshot(fixture.articlePath, {config: fixture.config}),
    (error) => error.code === 'ASSET_PATH_COLLISION',
  )
})

test('enforces article, image, count, and combined limits', async (t) => {
  assert.equal(MAX_ASSETS, 10)
  assert.equal(MAX_TOTAL_BYTES, 256 * 1024 * 1024)

  const oversizedArticle = makeArticle()
  oversizedArticle.body.en[0].children[0].text = 'a'.repeat(MAX_ARTICLE_BYTES)
  const articleFixture = await createArticleFixture({article: oversizedArticle})
  t.after(() => rm(articleFixture.workspaceRoot, {recursive: true, force: true}))
  await assert.rejects(
    prepareArticleSnapshot(articleFixture.articlePath, {config: articleFixture.config}),
    (error) => error.code === 'ARTICLE_SIZE_INVALID',
  )

  const assetFixture = await createArticleFixture({localCover: true})
  t.after(() => rm(assetFixture.workspaceRoot, {recursive: true, force: true}))
  const oversizedAsset = Buffer.alloc(MAX_ASSET_BYTES + 1)
  PNG_BYTES.copy(oversizedAsset)
  await writeFile(
    path.join(assetFixture.assetsRoot, 'example-post-cover.png'),
    oversizedAsset,
  )
  await assert.rejects(
    prepareArticleSnapshot(assetFixture.articlePath, {config: assetFixture.config}),
    (error) => error.code === 'ASSET_SIZE_INVALID',
  )

  const tooManyImages = makeArticle('too-many-images')
  tooManyImages.body.en = Array.from({length: MAX_ASSETS + 1}, (_, index) => ({
    _type: 'image',
    source: {path: `./assets/too-many-images-${index}.png`},
    alt: `Local body image ${index}`,
  }))
  const countFixture = await createArticleFixture({
    slug: tooManyImages.slug,
    article: tooManyImages,
  })
  t.after(() => rm(countFixture.workspaceRoot, {recursive: true, force: true}))
  await assert.rejects(
    prepareArticleSnapshot(countFixture.articlePath, {config: countFixture.config}),
    (error) => error.code === 'ASSET_COUNT_EXCEEDED',
  )
})
