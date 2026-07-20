import {
  checkConfig,
  defaultWindowsAcl,
  loadConfig,
} from './config.mjs'
import {
  configurationSetupSummary,
  createConfigurationSetupLauncher,
  isReinitializableConfigurationError,
} from './config-setup.mjs'
import {SafeError} from './errors.mjs'
import {
  describeArticleSnapshot,
  prepareArticleSnapshot,
} from './article.mjs'
import {
  PublisherApiError,
  isPublishConflict,
  requestArticle,
} from './api.mjs'
import {writePublicationRecord} from './records.mjs'
import {
  WorkspaceError,
  commitReservation,
  preparePublish,
  prepareUpdate,
  releaseReservation,
} from './workspace.mjs'

function genericMessage(category) {
  if (category === 'validation') return 'Local article validation failed before any remote request.'
  if (category === 'configuration') return 'The local Sanity blog configuration is invalid.'
  if (category === 'workspace') return 'The local blog workspace operation failed safely.'
  if (category === 'api') return 'The publisher API did not return a confirmed safe result.'
  return 'The local sanityblog operation failed safely.'
}

export function asSafeError(error) {
  if (error instanceof SafeError) return error
  if (
    error instanceof PublisherApiError ||
    error instanceof WorkspaceError ||
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
      safeMessage: genericMessage(error.category),
      cause: error,
    })
  }
  return new SafeError({
    category: 'internal',
    code: 'INTERNAL_ERROR',
    retryable: false,
    resultUnknown: false,
    safeMessage: 'The local sanityblog operation failed safely.',
    cause: error,
  })
}

function confirmedReceipt(operation, result) {
  return {
    operation,
    status: result.status,
    id: result.id,
    revision: result.revision,
    slug: result.slug,
    requestId: result.requestId,
    uploadedAssetIds: [...result.uploadedAssetIds],
    target: {...result.target},
  }
}

export function createBlogService({
  homeDir,
  platform = process.platform,
  acl = defaultWindowsAcl,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  clock = () => new Date(),
  loadConfigImpl = loadConfig,
  checkConfigImpl = checkConfig,
  recordWriter = writePublicationRecord,
  requestImpl = requestArticle,
  configurationSetupLauncher,
  workspace = {
    preparePublish,
    prepareUpdate,
    commitReservation,
    releaseReservation,
  },
} = {}) {
  const configOptions = {homeDir, platform, acl}
  const setupLauncher = configurationSetupLauncher ?? createConfigurationSetupLauncher({
    homeDir,
    platform,
  })

  async function configured() {
    return loadConfigImpl(configOptions)
  }

  async function snapshot(articlePath) {
    const config = await configured()
    const articleSnapshot = await prepareArticleSnapshot(articlePath, {config})
    return {config, articleSnapshot}
  }

  async function remoteRequest(operation, articleSnapshot, config, options = {}) {
    return requestImpl(operation, articleSnapshot, {
      config,
      fetchImpl,
      ...(timeoutMs === undefined ? {} : {timeoutMs}),
      ...options,
    })
  }

  async function probePublishSnapshot(articleSnapshot, config, createPublishedAt) {
    try {
      const createProbe = await remoteRequest(
        'create-dry-run',
        articleSnapshot,
        config,
        {createPublishedAt},
      )
      return {
        mode: 'create',
        createPublishedAt,
        probe: createProbe.result,
      }
    } catch (error) {
      if (!isPublishConflict(error)) throw error
    }

    const updateProbe = await remoteRequest(
      'update-dry-run',
      articleSnapshot,
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
          'The remote mutation succeeded, but its local publication record could not be written. Do not retry the remote mutation.',
        cause: error,
      })
    }
  }

  async function run(operation) {
    try {
      return await operation()
    } catch (error) {
      throw asSafeError(error)
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
          const safeError = asSafeError(error)
          if (!isReinitializableConfigurationError(safeError)) throw safeError
          return {
            ok: true,
            ...configurationSetupSummary(await setupLauncher.start()),
          }
        }
      })
    },

    preparePublish(baseSlug) {
      return run(async () => {
        const config = await configured()
        return {ok: true, ...(await workspace.preparePublish({baseSlug, config}))}
      })
    },

    prepareUpdate(slug) {
      return run(async () => {
        const config = await configured()
        return {ok: true, ...(await workspace.prepareUpdate({slug, config}))}
      })
    },

    commit(slug, reservationId) {
      return run(async () => {
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.commitReservation({slug, reservationId, config})),
        }
      })
    },

    release(slug, reservationId) {
      return run(async () => {
        const config = await configured()
        return {
          ok: true,
          ...(await workspace.releaseReservation({slug, reservationId, config})),
        }
      })
    },

    validate(articlePath) {
      return run(async () => {
        const {articleSnapshot} = await snapshot(articlePath)
        return describeArticleSnapshot(articleSnapshot)
      })
    },

    probePublish(articlePath) {
      return run(async () => {
        const {config, articleSnapshot} = await snapshot(articlePath)
        const createPublishedAt = clock().toISOString()
        const outcome = await probePublishSnapshot(
          articleSnapshot,
          config,
          createPublishedAt,
        )
        return {
          ok: true,
          mode: outcome.mode,
          slug: articleSnapshot.slug,
          articlePath: articleSnapshot.articlePath,
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

    probeUpdate(articlePath) {
      return run(async () => {
        const {config, articleSnapshot} = await snapshot(articlePath)
        const outcome = await remoteRequest(
          'update-dry-run',
          articleSnapshot,
          config,
        )
        return {
          ok: true,
          mode: 'update',
          slug: articleSnapshot.slug,
          articlePath: articleSnapshot.articlePath,
          id: outcome.result.id,
          revision: outcome.result.revision,
          requestId: outcome.result.requestId,
          uploadedAssetIds: [...outcome.result.uploadedAssetIds],
          target: {...outcome.result.target},
        }
      })
    },

    publish(articlePath) {
      return run(async () => {
        const {config, articleSnapshot} = await snapshot(articlePath)
        const createPublishedAt = clock().toISOString()
        const outcome = await probePublishSnapshot(
          articleSnapshot,
          config,
          createPublishedAt,
        )
        const final =
          outcome.mode === 'create'
            ? await remoteRequest('create', articleSnapshot, config, {
                createPublishedAt,
              })
            : await remoteRequest('update', articleSnapshot, config, {
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
          articlePath: articleSnapshot.articlePath,
          recordPath,
        }
      })
    },

    update(articlePath) {
      return run(async () => {
        const {config, articleSnapshot} = await snapshot(articlePath)
        const probe = await remoteRequest(
          'update-dry-run',
          articleSnapshot,
          config,
        )
        const final = await remoteRequest('update', articleSnapshot, config, {
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
          articlePath: articleSnapshot.articlePath,
          recordPath,
        }
      })
    },
  })
}
