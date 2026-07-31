import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  applyPrivatePermissions,
  defaultWindowsAcl,
  getConfigPaths,
} from "./config.mjs";
import { CONTENT_TYPE_IDS } from "./content-types.mjs";
import { SafeError } from "./errors.mjs";

const CONTENT_TYPES = new Set(CONTENT_TYPE_IDS);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_IMAGE_ASSET_ID =
  /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-(?:jpg|jpeg|png|gif|webp|avif)$/iu;
const SAFE_FILE_ASSET_ID =
  /^file-[A-Za-z0-9]+-(?:mp4|webm|pdf|txt|csv|docx|xlsx|pptx)$/iu;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOADED_ASSET_IDS = 10;
const writeQueues = new Map();

function recordError(code, safeMessage, cause) {
  return new SafeError({
    category: "publication_record",
    code,
    retryable: false,
    resultUnknown: false,
    safeMessage,
    cause,
  });
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function requireContentType(contentType, field = "contentType") {
  if (typeof contentType !== "string" || !CONTENT_TYPES.has(contentType)) {
    throw recordError("INVALID_CONTENT_TYPE", `${field} is not a supported content type.`);
  }
  return contentType;
}

function requireString(value, field, maximumLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw recordError("INVALID_PUBLICATION_RECEIPT", `${field} is invalid.`);
  }
  return value;
}

function requirePlainObject(value, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw recordError("INVALID_PUBLICATION_RECEIPT", `${field} must be a plain object.`);
  }
  return value;
}

function ownDataValue(object, key, field) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) {
    throw recordError("INVALID_PUBLICATION_RECEIPT", `${field} is invalid.`);
  }
  return descriptor.value;
}

function cloneJson(value, location = "article", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw recordError(
        "INVALID_ARTICLE_SNAPSHOT",
        "Article snapshot contains a non-JSON number.",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw recordError(
      "INVALID_ARTICLE_SNAPSHOT",
      "Article snapshot is not JSON-compatible.",
    );
  }
  if (seen.has(value)) {
    throw recordError("INVALID_ARTICLE_SNAPSHOT", "Article snapshot contains a cycle.");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        cloneJson(entry, `${location}[${index}]`, seen),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw recordError(
        "INVALID_ARTICLE_SNAPSHOT",
        "Article snapshot must contain plain objects.",
      );
    }

    const output = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw recordError(
          "INVALID_ARTICLE_SNAPSHOT",
          "Article snapshot cannot contain accessors.",
        );
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw recordError(
          "INVALID_ARTICLE_SNAPSHOT",
          "Article snapshot contains an unsafe key.",
        );
      }
      output[key] = cloneJson(descriptor.value, `${location}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeResult(result, contentType) {
  requirePlainObject(result, "result");
  if (ownDataValue(result, "status", "result.status") !== "published") {
    throw recordError(
      "INVALID_PUBLICATION_RECEIPT",
      "result.status must confirm publication.",
    );
  }

  const slug = requireString(
    ownDataValue(result, "slug", "result.slug"),
    "result.slug",
    96,
  );
  if (!SLUG_PATTERN.test(slug)) {
    throw recordError("INVALID_PUBLICATION_RECEIPT", "result.slug is invalid.");
  }

  const resultContentType = ownDataValue(
    result,
    "contentType",
    "result.contentType",
  );
  if (typeof resultContentType !== "string" || !CONTENT_TYPES.has(resultContentType)) {
    throw recordError(
      "INVALID_PUBLICATION_RECEIPT",
      "result.contentType is invalid.",
    );
  }
  if (resultContentType !== contentType) {
    throw recordError(
      "INVALID_PUBLICATION_RECEIPT",
      "result.contentType does not match contentType.",
    );
  }

  const target = requirePlainObject(
    ownDataValue(result, "target", "result.target"),
    "result.target",
  );
  const uploadedAssetIds =
    Object.hasOwn(result, "uploadedAssetIds")
      ? ownDataValue(result, "uploadedAssetIds", "result.uploadedAssetIds")
      : [];
  if (
    !Array.isArray(uploadedAssetIds) ||
    uploadedAssetIds.length > MAX_UPLOADED_ASSET_IDS ||
    new Set(uploadedAssetIds).size !== uploadedAssetIds.length ||
    uploadedAssetIds.some(
      (assetId) =>
        typeof assetId !== "string" ||
        (!SAFE_IMAGE_ASSET_ID.test(assetId) &&
          !SAFE_FILE_ASSET_ID.test(assetId)),
    )
  ) {
    throw recordError(
      "INVALID_PUBLICATION_RECEIPT",
      "result.uploadedAssetIds is invalid.",
    );
  }

  return {
    status: "published",
    id: requireString(
      ownDataValue(result, "id", "result.id"),
      "result.id",
      256,
    ),
    revision: requireString(
      ownDataValue(result, "revision", "result.revision"),
      "result.revision",
      256,
    ),
    slug,
    contentType: resultContentType,
    requestId: requireString(
      ownDataValue(result, "requestId", "result.requestId"),
      "result.requestId",
      256,
    ),
    uploadedAssetIds: uploadedAssetIds.map((entry) =>
      requireString(entry, "result.uploadedAssetIds[]", 256),
    ),
    target: {
      projectId: requireString(
        ownDataValue(target, "projectId", "result.target.projectId"),
        "result.target.projectId",
        128,
      ),
      dataset: requireString(
        ownDataValue(target, "dataset", "result.target.dataset"),
        "result.target.dataset",
        128,
      ),
      apiVersion: requireString(
        ownDataValue(target, "apiVersion", "result.target.apiVersion"),
        "result.target.apiVersion",
        10,
      ),
    },
  };
}

function buildRecord({ operation, contentType, article, result, now }) {
  if (operation !== "created" && operation !== "updated") {
    throw recordError(
      "INVALID_PUBLICATION_RECEIPT",
      "operation must be created or updated.",
    );
  }
  const strictContentType = requireContentType(contentType);
  const recordedDate = typeof now === "function" ? now() : new Date();
  if (!(recordedDate instanceof Date) || Number.isNaN(recordedDate.getTime())) {
    throw recordError("INVALID_PUBLICATION_RECEIPT", "recordedAt is invalid.");
  }

  return {
    schemaVersion: 2,
    recordedAt: recordedDate.toISOString(),
    operation,
    contentType: strictContentType,
    article: cloneJson(article),
    result: sanitizeResult(result, strictContentType),
  };
}

async function ensureOrdinaryDirectory(directoryPath, permissions) {
  try {
    await mkdir(directoryPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw recordError(
      "UNSAFE_RECORD_PATH",
      "Content publication record directories must be ordinary.",
    );
  }
  await applyPrivatePermissions(directoryPath, "directory", permissions);
}

async function assertTargetIsSafe(targetPath) {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw recordError(
        "UNSAFE_RECORD_PATH",
        "Content publication record target must be ordinary.",
      );
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function writeRecordAtomically(targetPath, source, permissions) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await applyPrivatePermissions(temporaryPath, "file", permissions);
    await assertTargetIsSafe(targetPath);
    await rename(temporaryPath, targetPath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function enqueue(targetPath, operation) {
  const previous = writeQueues.get(targetPath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(targetPath, current);
  return current.finally(() => {
    if (writeQueues.get(targetPath) === current) {
      writeQueues.delete(targetPath);
    }
  });
}

export async function writeContentPublicationRecord(
  {
    operation,
    contentType,
    article,
    result,
    homeDir = os.homedir(),
    platform = process.platform,
    acl = defaultWindowsAcl,
    now,
    confirmed,
  },
  options = {},
) {
  if (confirmed === false) {
    throw recordError("PUBLICATION_NOT_CONFIRMED", "Publication was not confirmed.");
  }

  const record = buildRecord({
    operation,
    contentType,
    article,
    result,
    now: now ?? options.now,
  });
  const { configDirectory, publishedDirectory } = getConfigPaths(
    options.homeDir ?? homeDir,
  );
  const permissions = {
    platform: options.platform ?? platform,
    acl: options.acl ?? acl,
  };
  const contentsDirectory = path.join(publishedDirectory, "contents");
  const typeDirectory = path.join(contentsDirectory, record.contentType);
  const targetPath = path.join(typeDirectory, `${record.result.slug}.json`);

  return enqueue(targetPath, async () => {
    try {
      const configStats = await lstat(configDirectory);
      if (configStats.isSymbolicLink() || !configStats.isDirectory()) {
        throw recordError(
          "UNSAFE_RECORD_PATH",
          "Configuration directory must be ordinary.",
        );
      }
      await applyPrivatePermissions(configDirectory, "directory", permissions);
      await ensureOrdinaryDirectory(publishedDirectory, permissions);
      await ensureOrdinaryDirectory(contentsDirectory, permissions);
      await ensureOrdinaryDirectory(typeDirectory, permissions);
      await assertTargetIsSafe(targetPath);

      const source = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(source) > MAX_RECORD_BYTES) {
        throw recordError(
          "PUBLICATION_RECORD_TOO_LARGE",
          "Content publication record exceeds the size limit.",
        );
      }
      await writeRecordAtomically(targetPath, source, permissions);
      return { recordPath: targetPath, record };
    } catch (error) {
      if (error instanceof SafeError && error.code !== "UNSAFE_PERMISSIONS") {
        throw error;
      }
      throw recordError(
        "RECORD_WRITE_FAILED",
        "The remote mutation succeeded, but its local content publication record could not be written.",
        error,
      );
    }
  });
}

export function __resetContentRecordWriteQueuesForTests() {
  writeQueues.clear();
}
