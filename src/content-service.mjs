import {
  checkContentConfig,
  defaultWindowsAcl,
  loadConfig,
} from './config.mjs'
import {
  contentConfigurationSetupSummary,
  createConfigurationSetupLauncher,
  isReinitializableConfigurationError,
} from './config-setup.mjs'
import {SafeError} from './errors.mjs'
import {
  describeContentSnapshot,
  prepareContentSnapshot,
} from './content-article.mjs'
import {
  ContentPublisherApiError,
  isContentPublishConflict,
  requestContent,
} from './content-api.mjs'
import {writeContentPublicationRecord} from './content-records.mjs'
import {renderContentPreview} from './content-preview.mjs'
import {
  commitContentReservation,
  prepareContentPublish,
  prepareContentUpdate,
  releaseContentReservation,
} from './content-workspace.mjs'
import {requireContentType} from './content-types.mjs'

function genericMessage(category) {
  if (category === 'validation') {
    return 'Local content validation failed before any remote request.'
  }
  if (category === 'configuration') {
    return 'The local Sanity content configuration is invalid.'
  }
  if (category === 'workspace') {
    return 'The local content workspace operation failed safely.'
  }
  if (category === 'preview') {
    return 'The local content preview could not be generated safely.'
  }
  if (category === 'api') {
    return 'The content publisher API did not return a confirmed safe result.'
  }
  return 'The local sanityblog content operation failed safely.'
}

function normalizedIssues(error) {
  const source = error?.details?.issues ?? error?.issues
  if (!Array.isArray(source)) return undefined
  return source.map((entry) => ({
    ...(entry?.code ? {code: String(entry.code)} : {}),
    ...(entry?.message ? {message: String(entry.message)} : {}),
    ...(entry?.path !== undefined
      ? {
          path: Array.isArray(entry.path)
            ? entry.path.join('.')
            : String(entry.path),
        }
      : {}),
  }))
}

export function asContentSafeError(error) {
  if (error instanceof SafeError) return error
  if (
    error instanceof ContentPublisherApiError ||
    (error &&
      typeof error === 'object' &&
      typeof error.category === 'string' &&
      typeof error.code === 'string')
  ) {
    return new SafeError({
      category: error.category,
      code: error.code,
      retryable: false,
      resultUnknown: error.resultUnknown === true,
      statusCode: error.statusCode,
      requestId: error.requestId,
      uploadedAssetIds: error.uploadedAssetIds,
      issues: normalizedIssues(error),
      committed: error.details?.committed === true,
      commitReceipt:
        error.details?.committed === true
          ? error.details
          : undefined,
      safeMessage: genericMessage(error.category),
      cause: error,
    })
  }
  return new SafeError({
    category: 'internal',
    code: 'INTERNAL_ERROR',
    retryable: false,
    resultUnknown: false,
    safeMessage: 'The local sanityblog content operation failed safely.',
    cause: error,
  })
}

function confirmedReceipt(operation, result) {
  return {
    operation,
    status: result.status,
    contentType: result.contentType,
    id: result.id,
    revision: result.revision,
    slug: result.slug,
    requestId: result.requestId,
    uploadedAssetIds: [...result.uploadedAssetIds],
    target: {...result.target},
  }
}

export function createContentService({
  homeDir,
  platform = process.platform,
  acl = defaultWindowsAcl,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  clock = () => new Date(),
  loadConfigImpl = loadConfig,
  checkConfigImpl = checkContentConfig,
  recordWriter = writeContentPublicationRecord,
  requestImpl = requestContent,
  previewRenderer = renderContentPreview,
  configurationSetupLauncher,
  workspace = {
    prepareContentPublish,
    prepareContentUpdate,
    commitContentReservation,
    releaseContentReservation,
  },
} = {}) {
  const configOptions = {homeDir, platform, acl}
  const setupLauncher =
    configurationSetupLauncher ??
    createConfigurationSetupLauncher({
      homeDir,
      platform,
      setupMode: 'content',
    })

  async function configured() {
    return loadConfigImpl(configOptions)
  }

  async function snapshot(contentType, articlePath) {
    const safeContentType = requireContentType(contentType)
    const config = await configured()
    const contentSnapshot = await prepareContentSnapshot(
      safeContentType,
      articlePath,
      {config},
    )
    return {config, contentSnapshot}
  }

  async function remoteRequest(operation, contentSnapshot, config, options = {}) {
    return requestImpl(operation, contentSnapshot, {
      config,
      fetchImpl,
      ...(timeoutMs === undefined ? {} : {timeoutMs}),
      ...options,
    })
  }

  async function requireAcceptedPreview(contentSnapshot, previewRevision) {
    if (typeof previewRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(previewRevision)) {
      throw new SafeError({
        category: 'preview',
        code: 'PREVIEW_REVISION_INVALID',
        safeMessage: 'A valid accepted preview revision is required before any remote request.',
      })
    }
    const preview = await previewRenderer(contentSnapshot)
    if (preview?.previewRevision !== previewRevision) {
      throw new SafeError({
        category: 'preview',
        code: 'PREVIEW_REVISION_MISMATCH',
        safeMessage: 'The content bundle no longer matches the accepted local preview.',
      })
    }
    return preview
  }

  async function probePublishSnapshot(contentSnapshot, config, createPublishedAt) {
    try {
      const createProbe = await remoteRequest(
        'create-dry-run',
        contentSnapshot,
        config,
        {createPublishedAt},
      )
      return {
        mode: 'create',
        createPublishedAt,
        probe: createProbe.result,
      }
    } catch (error) {
      if (!isContentPublishConflict(error)) throw error
    }

    const updateProbe = await remoteRequest(
      'update-dry-run',
      contentSnapshot,
      config,
    )
    return {
      mode: 'update',
      probe: updateProbe.result,
    }
  }

  async function persistConfirmed(operation, article, result) {
    try {
      const written = await recordWriter({
        contentType: result.contentType,
        operation,
        article,
        result,
        homeDir,
        platform,
        acl,
        confirmed: true,
      })
      return written.recordPath
    } catch (error) {
      const receipt = confirmedReceipt(operation, result)
      throw new SafeError({
        category: 'publication_record',
        code: 'PUBLISHED_BUT_RECORD_WRITE_FAILED',
        retryable: false,
        resultUnknown: false,
        remoteMutationSucceeded: true,
        receipt,
        safeMessage:
          'The remote mutation succeeded, but its local content publication record could not be written. Do not retry the remote mutation.',
        cause: error,
      })
    }
  }

  async function run(operation) {
    try {
      return await operation()
    } catch (error) {
      throw asContentSafeError(error)
    }
  }

  return Object.freeze({
    checkConfig() {
      return run(async () => ({ok: true, ...(await checkConfigImpl(configOptions))}))
    },

    startConfigSetup() {
      return run(async () => {
        try {
          return {ok: true, ...(await checkConfigImpl(configOptions)), setupStarted: false}
        } catch (error) {
          const safeError = asContentSafeError(error)
          if (!isReinitializableConfigurationError(safeError)) throw safeError
          return {
            ok: true,
            ...contentConfigurationSetupSummary(await setupLauncher.start()),
          }
        }
      })
    },

    preparePublish(contentType, baseSlug) {
      return run(async () => {
        const safeContentType = requireContentType(contentType)
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.prepareContentPublish({
            contentType: safeContentType,
            baseSlug,
            config,
          })),
        }
      })
    },

    prepareUpdate(contentType, slug) {
      return run(async () => {
        const safeContentType = requireContentType(contentType)
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.prepareContentUpdate({
            contentType: safeContentType,
            slug,
            config,
          })),
        }
      })
    },

    commit(contentType, slug, reservationId) {
      return run(async () => {
        const safeContentType = requireContentType(contentType)
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.commitContentReservation({
            contentType: safeContentType,
            slug,
            reservationId,
            config,
          })),
        }
      })
    },

    release(contentType, slug, reservationId) {
      return run(async () => {
        const safeContentType = requireContentType(contentType)
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.releaseContentReservation({
            contentType: safeContentType,
            slug,
            reservationId,
            config,
          })),
        }
      })
    },

    validate(contentType, articlePath) {
      return run(async () => {
        const {contentSnapshot} = await snapshot(contentType, articlePath)
        return describeContentSnapshot(contentSnapshot)
      })
    },

    preview(contentType, articlePath) {
      return run(async () => {
        const {contentSnapshot} = await snapshot(contentType, articlePath)
        return previewRenderer(contentSnapshot)
      })
    },

    probePublish(contentType, articlePath, previewRevision) {
      return run(async () => {
        const {config, contentSnapshot} = await snapshot(contentType, articlePath)
        await requireAcceptedPreview(contentSnapshot, previewRevision)
        const createPublishedAt =
          contentSnapshot.article.publishedAt ?? clock().toISOString()
        const outcome = await probePublishSnapshot(
          contentSnapshot,
          config,
          createPublishedAt,
        )
        return {
          ok: true,
          contentType: contentSnapshot.contentType,
          mode: outcome.mode,
          slug: contentSnapshot.slug,
          articlePath: contentSnapshot.articlePath,
          previewRevision,
          ...(outcome.mode === 'create'
            ? {publishedAt: outcome.createPublishedAt}
            : {
                id: outcome.probe.id,
                revision: outcome.probe.revision,
              }),
          requestId: outcome.probe.requestId,
          uploadedAssetIds: [...outcome.probe.uploadedAssetIds],
          target: {...outcome.probe.target},
        }
      })
    },

    probeUpdate(contentType, articlePath, previewRevision) {
      return run(async () => {
        const {config, contentSnapshot} = await snapshot(contentType, articlePath)
        await requireAcceptedPreview(contentSnapshot, previewRevision)
        const outcome = await remoteRequest(
          'update-dry-run',
          contentSnapshot,
          config,
        )
        return {
          ok: true,
          contentType: contentSnapshot.contentType,
          mode: 'update',
          slug: contentSnapshot.slug,
          articlePath: contentSnapshot.articlePath,
          previewRevision,
          id: outcome.result.id,
          revision: outcome.result.revision,
          requestId: outcome.result.requestId,
          uploadedAssetIds: [...outcome.result.uploadedAssetIds],
          target: {...outcome.result.target},
        }
      })
    },

    publish(contentType, articlePath, previewRevision) {
      return run(async () => {
        const {config, contentSnapshot} = await snapshot(contentType, articlePath)
        await requireAcceptedPreview(contentSnapshot, previewRevision)
        const createPublishedAt =
          contentSnapshot.article.publishedAt ?? clock().toISOString()
        const outcome = await probePublishSnapshot(
          contentSnapshot,
          config,
          createPublishedAt,
        )
        const final =
          outcome.mode === 'create'
            ? await remoteRequest('create', contentSnapshot, config, {
                createPublishedAt,
              })
            : await remoteRequest('update', contentSnapshot, config, {
                expectedRevision: outcome.probe.revision,
                expectedId: outcome.probe.id,
              })
        const operation = outcome.mode === 'create' ? 'created' : 'updated'
        const recordPath = await persistConfirmed(
          operation,
          final.article,
          final.result,
        )
        return {
          ok: true,
          operation,
          ...final.result,
          articlePath: contentSnapshot.articlePath,
          previewRevision,
          recordPath,
        }
      })
    },

    update(contentType, articlePath, previewRevision) {
      return run(async () => {
        const {config, contentSnapshot} = await snapshot(contentType, articlePath)
        await requireAcceptedPreview(contentSnapshot, previewRevision)
        const probe = await remoteRequest(
          'update-dry-run',
          contentSnapshot,
          config,
        )
        const final = await remoteRequest('update', contentSnapshot, config, {
          expectedRevision: probe.result.revision,
          expectedId: probe.result.id,
        })
        const operation = 'updated'
        const recordPath = await persistConfirmed(
          operation,
          final.article,
          final.result,
        )
        return {
          ok: true,
          operation,
          ...final.result,
          articlePath: contentSnapshot.articlePath,
          previewRevision,
          recordPath,
        }
      })
    },
  })
}
