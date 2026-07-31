import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {prepareContentSnapshot} from '../src/content-article.mjs'
import {renderContentPreview} from '../src/content-preview.mjs'
import {
  commitContentReservation,
  prepareContentPublish,
} from '../src/content-workspace.mjs'

function block(text) {
  return {
    _type: 'block',
    children: [{_type: 'span', text, marks: []}],
    markDefs: [],
  }
}

test('a staged preview commits cleanly and keeps the accepted revision after promotion', async (t) => {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sanity-content-workflow-'),
  )
  t.after(() => rm(workspaceRoot, {recursive: true, force: true}))
  const config = {
    workspaceRoot,
    publicSiteOrigin: 'https://miyaip.com',
  }
  const prepared = await prepareContentPublish({
    contentType: 'guide',
    baseSlug: 'workflow-example',
    config,
  })
  await writeFile(
    prepared.markdownPath,
    '# Workflow example\n\nThe local preview is accepted.\n',
    'utf8',
  )
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify({
      title: {en: 'Workflow example', zh: '工作流示例'},
      slug: prepared.slug,
      excerpt: {
        en: 'A complete local workflow.',
        zh: '完整的本地工作流。',
      },
      body: {
        en: [block('The local preview is accepted.')],
        zh: [block('本地预览已确认。')],
      },
    })}\n`,
    'utf8',
  )

  const stagedSnapshot = await prepareContentSnapshot(
    'guide',
    prepared.articlePath,
    {config},
  )
  const stagedPreview = await renderContentPreview(stagedSnapshot)
  assert.equal(
    stagedPreview.previewPath,
    path.join(
      path.dirname(path.dirname(prepared.articlePath)),
      `${prepared.slug}.preview.html`,
    ),
  )

  const committed = await commitContentReservation({
    contentType: 'guide',
    slug: prepared.slug,
    reservationId: prepared.reservationId,
    config,
  })
  const liveSnapshot = await prepareContentSnapshot(
    'guide',
    committed.articlePath,
    {config},
  )
  const livePreview = await renderContentPreview(liveSnapshot)

  assert.equal(livePreview.previewRevision, stagedPreview.previewRevision)
  assert.equal(
    livePreview.previewPath,
    path.join(
      workspaceRoot,
      'contents',
      'guide',
      `${prepared.slug}.preview.html`,
    ),
  )
  assert.equal(committed.contentType, 'guide')
})
