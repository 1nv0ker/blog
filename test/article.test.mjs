import assert from 'node:assert/strict'
import {rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_ARTICLE_BYTES,
  MAX_ASSET_BYTES,
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

  const publishedAt = '2026-07-18T12:00:00.000Z'
  const createRequest = materializeArticleRequest(snapshot, {createPublishedAt: publishedAt})
  const updateRequest = materializeArticleRequest(snapshot, {forUpdate: true})
  assert.equal(createRequest.article.publishedAt, publishedAt)
  assert.equal('publishedAt' in updateRequest.article, false)
  assert.ok(createRequest.body instanceof FormData)
  assert.ok(updateRequest.body instanceof FormData)
  assert.equal(snapshot.article.publishedAt, '2026-07-18T00:00:00.000Z')
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

test('enforces article, individual asset, count, and total request limits', async (t) => {
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

  const tooMany = makeArticle()
  tooMany.body.en = Array.from({length: 11}, (_, index) => ({
    _type: 'image',
    source: {path: `./assets/image-${index}.png`},
    alt: `Image ${index}`,
  }))
  const countFixture = await createArticleFixture({article: tooMany})
  t.after(() => rm(countFixture.workspaceRoot, {recursive: true, force: true}))
  await assert.rejects(
    prepareArticleSnapshot(countFixture.articlePath, {config: countFixture.config}),
    (error) => error.code === 'ASSET_COUNT_EXCEEDED',
  )

  const totalArticle = makeArticle()
  totalArticle.body.en = []
  for (let index = 0; index < 4; index += 1) {
    totalArticle.body.en.push({
      _type: 'image',
      source: {path: `./assets/large-${index}.png`},
      alt: `Large image ${index}`,
    })
  }
  const totalFixture = await createArticleFixture({article: totalArticle})
  t.after(() => rm(totalFixture.workspaceRoot, {recursive: true, force: true}))
  const largeImage = Buffer.alloc(17 * 1024 * 1024)
  PNG_BYTES.copy(largeImage)
  for (let index = 0; index < 4; index += 1) {
    await writeFile(path.join(totalFixture.assetsRoot, `large-${index}.png`), largeImage)
  }
  await assert.rejects(
    prepareArticleSnapshot(totalFixture.articlePath, {config: totalFixture.config}),
    (error) => error.code === 'REQUEST_SIZE_EXCEEDED',
  )
})
