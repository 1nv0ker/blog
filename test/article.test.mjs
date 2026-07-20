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

test('enforces article and cover limits and rejects local Portable Text images', async (t) => {
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

  const localBodyImage = makeArticle()
  localBodyImage.body.en = [{
    _type: 'image',
    source: {path: './assets/body.png'},
    alt: 'A local body image that the three-file bundle cannot commit',
  }]
  const bodyFixture = await createArticleFixture({article: localBodyImage})
  t.after(() => rm(bodyFixture.workspaceRoot, {recursive: true, force: true}))
  await assert.rejects(
    prepareArticleSnapshot(bodyFixture.articlePath, {config: bodyFixture.config}),
    (error) =>
      error.code === 'ARTICLE_SCHEMA_INVALID' &&
      error.details?.issues?.some((issue) => issue.path === 'body.en.0'),
  )
})
