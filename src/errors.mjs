const DEFAULT_CATEGORY = "internal";
const DEFAULT_CODE = "INTERNAL_ERROR";

function cleanOptionalString(value, maximumLength = 256) {
  if (typeof value !== "string") {
    return undefined;
  }

  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (cleaned.length === 0) {
    return undefined;
  }

  return cleaned.slice(0, maximumLength);
}

function cleanStringArray(value, maximumItems = 10) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value
    .slice(0, maximumItems)
    .map((entry) => cleanOptionalString(entry))
    .filter(Boolean);
  return result.length > 0 ? result : [];
}

function sanitizeIssues(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues = [];
  for (const entry of value.slice(0, 20)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const issue = {};
    const path = cleanOptionalString(entry.path, 512);
    const code = cleanOptionalString(entry.code, 96);
    const message = cleanOptionalString(entry.message, 512);
    if (path !== undefined) issue.path = path;
    if (code !== undefined) issue.code = code;
    if (message !== undefined) issue.message = message;
    if (Object.keys(issue).length > 0) issues.push(issue);
  }
  return issues.length > 0 ? issues : undefined;
}

function sanitizeCommitReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (value.committed !== true) {
    return undefined;
  }
  const receipt = { committed: true };
  for (const key of ["contentType", "slug", "reservationId", "mode"]) {
    const cleaned = cleanOptionalString(value[key]);
    if (cleaned !== undefined) receipt[key] = cleaned;
  }
  for (const key of [
    "bundlePath",
    "markdownPath",
    "articlePath",
    "assetsDirectory",
    "coverPath",
  ]) {
    const cleaned = cleanOptionalString(value[key], 4096);
    if (cleaned !== undefined) receipt[key] = cleaned;
  }
  return receipt;
}

function sanitizeReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const receipt = {};
  for (const key of [
    "status",
    "id",
    "revision",
    "slug",
    "contentType",
    "requestId",
    "operation",
  ]) {
    const cleaned = cleanOptionalString(value[key]);
    if (cleaned) {
      receipt[key] = cleaned;
    }
  }

  const uploadedAssetIds = cleanStringArray(value.uploadedAssetIds);
  if (uploadedAssetIds) {
    receipt.uploadedAssetIds = uploadedAssetIds;
  }

  if (value.target !== null && typeof value.target === "object" && !Array.isArray(value.target)) {
    const target = {};
    for (const key of ["projectId", "dataset", "apiVersion"]) {
      const cleaned = cleanOptionalString(value.target[key]);
      if (cleaned) {
        target[key] = cleaned;
      }
    }
    if (Object.keys(target).length > 0) {
      receipt.target = target;
    }
  }

  return Object.keys(receipt).length > 0 ? receipt : undefined;
}

/**
 * An error whose serialized form is intentionally smaller than the Error
 * instance. Never put a token, URL, response body, header map, stack, or local
 * temporary path in these fields.
 */
export class SafeError extends Error {
  constructor(codeOrOptions, options = {}) {
    const normalized =
      typeof codeOrOptions === "string"
        ? { ...options, code: codeOrOptions }
        : { ...(codeOrOptions ?? {}) };

    super(normalized.safeMessage ?? normalized.message ?? normalized.code ?? DEFAULT_CODE);
    this.name = "SafeError";
    this.category = cleanOptionalString(normalized.category, 64) ?? DEFAULT_CATEGORY;
    this.code = cleanOptionalString(normalized.code, 96) ?? DEFAULT_CODE;
    this.retryable = normalized.retryable === true;
    this.resultUnknown = normalized.resultUnknown === true;
    this.safeMessage = cleanOptionalString(normalized.safeMessage, 256);

    if (Number.isInteger(normalized.statusCode)) {
      this.statusCode = normalized.statusCode;
    }

    const requestId = cleanOptionalString(normalized.requestId);
    if (requestId) {
      this.requestId = requestId;
    }

    const uploadedAssetIds = cleanStringArray(normalized.uploadedAssetIds);
    if (uploadedAssetIds) {
      this.uploadedAssetIds = uploadedAssetIds;
    }

    if (normalized.remoteMutationSucceeded === true) {
      this.remoteMutationSucceeded = true;
    }

    if (normalized.committed === true) {
      this.committed = true;
    }

    const receipt = sanitizeReceipt(normalized.receipt);
    if (receipt !== undefined) {
      this.receipt = receipt;
    }

    const issues = sanitizeIssues(normalized.issues);
    if (issues !== undefined) {
      this.issues = issues;
    }

    const commitReceipt = sanitizeCommitReceipt(normalized.commitReceipt);
    if (commitReceipt !== undefined) {
      this.commitReceipt = commitReceipt;
    }

    if (normalized.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: normalized.cause,
        writable: false,
      });
    }
  }
}

export function toSafeErrorResult(error) {
  const source = error instanceof SafeError ? error : undefined;
  const payload = {
    category: source?.category ?? DEFAULT_CATEGORY,
    code: source?.code ?? DEFAULT_CODE,
    retryable: source?.retryable === true,
    resultUnknown: source?.resultUnknown === true,
  };

  if (source?.safeMessage) {
    payload.message = source.safeMessage;
  }
  if (Number.isInteger(source?.statusCode)) {
    payload.statusCode = source.statusCode;
  }
  if (source?.requestId) {
    payload.requestId = source.requestId;
  }
  if (Array.isArray(source?.uploadedAssetIds)) {
    payload.uploadedAssetIds = [...source.uploadedAssetIds];
  }
  if (source?.remoteMutationSucceeded === true) {
    payload.remoteMutationSucceeded = true;
  }
  if (source?.committed === true) {
    payload.committed = true;
  }
  if (source?.receipt !== undefined) {
    payload.receipt = source.receipt;
  }
  if (Array.isArray(source?.issues)) {
    payload.issues = source.issues.map((issue) => ({ ...issue }));
  }
  if (source?.commitReceipt !== undefined) {
    payload.commitReceipt = { ...source.commitReceipt };
  }

  return { ok: false, error: payload };
}

export const serializeSafeError = toSafeErrorResult;
