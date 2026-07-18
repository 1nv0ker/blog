import {mkdtemp, mkdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
])

export function makeArticle(
  slug = 'example-post',
  {localCover = false, publishedAt = '2026-07-18T00:00:00.000Z'} = {},
) {
  return {
    title: {
      en: 'A safe example post',
      zh: '安全示例文章',
    },
    slug,
    publishedAt,
    excerpt: {
      en: 'A concise English summary.',
      zh: '一段简洁的中文摘要。',
    },
    coverImage: {
      source: localCover
        ? {path: `./assets/${slug}-cover.png`}
        : {assetRef: 'image-coverasset-1200x630-png'},
      alt: {
        en: 'An abstract cover for the example post',
        zh: '示例文章的抽象封面',
      },
    },
    body: {
      en: [
        {
          _type: 'block',
          style: 'normal',
          markDefs: [],
          children: [{_type: 'span', text: 'Verified English content.', marks: []}],
        },
      ],
      zh: [
        {
          _type: 'block',
          style: 'normal',
          markDefs: [],
          children: [{_type: 'span', text: '经过核实的中文内容。', marks: []}],
        },
      ],
    },
    seo: {
      title: {
        en: 'Safe example post',
        zh: '安全示例文章',
      },
      description: {
        en: 'A safe description for the example post.',
        zh: '示例文章的安全描述。',
      },
    },
  }
}

export async function createArticleFixture({
  slug = 'example-post',
  localCover = false,
  article = makeArticle(slug, {localCover}),
} = {}) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'sanityblog-article-'))
  const blogRoot = path.join(workspaceRoot, 'blog')
  const assetsRoot = path.join(blogRoot, 'assets')
  await mkdir(assetsRoot, {recursive: true})
  const articlePath = path.join(blogRoot, `${slug}.json`)
  await writeFile(articlePath, `${JSON.stringify(article, null, 2)}\n`, 'utf8')
  if (localCover) {
    await writeFile(path.join(assetsRoot, `${slug}-cover.png`), PNG_BYTES)
  }
  return {
    workspaceRoot,
    blogRoot,
    assetsRoot,
    articlePath,
    article,
    config: {
      publisherApiOrigin: 'https://publisher.example.test',
      projectId: 'project1',
      dataset: 'production',
      apiVersion: '2026-07-05',
      sanityToken: 'secret-test-token',
      workspaceRoot,
    },
  }
}

export function responsePayload({
  status = 200,
  mode,
  slug = 'example-post',
  id,
  revision,
  requestId = 'request-1',
  uploadedAssetIds = [],
  target = {
    projectId: 'project1',
    dataset: 'production',
    apiVersion: '2026-07-05',
  },
  errorCode,
} = {}) {
  if (errorCode) {
    return new Response(
      JSON.stringify({
        error: {code: errorCode, details: {uploadedAssetIds}},
        requestId,
      }),
      {
        status,
        headers: {'content-type': 'application/json'},
      },
    )
  }
  return new Response(
    JSON.stringify({
      data: {
        status: mode === 'create' || mode === 'update' ? 'dry-run' : 'published',
        mode,
        slug,
        ...(id ? {id} : {}),
        ...(revision ? {revision} : {}),
        uploadedAssetIds,
        target,
      },
      requestId,
    }),
    {
      status,
      headers: {'content-type': 'application/json'},
    },
  )
}
