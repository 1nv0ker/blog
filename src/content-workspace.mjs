import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { CONTENT_TYPE_IDS } from "./content-types.mjs";

const CONTENT_TYPES = new Set(CONTENT_TYPE_IDS);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;
const METADATA_FILE = "reservation.json";
const CONTROL_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_STAGING_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_FILES = 10;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ContentWorkspaceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ContentWorkspaceError";
    this.category = "workspace";
    this.code = code;
    this.retryable = false;
    this.resultUnknown = false;
    if (details !== undefined) {
      this.details = details;
    }
    if (details?.committed === true) {
      this.committed = true;
    }
  }

  toJSON() {
    const error = {
      category: this.category,
      code: this.code,
      retryable: this.retryable,
      resultUnknown: this.resultUnknown,
    };
    if (this.details !== undefined) {
      error.details = this.details;
    }
    return error;
  }
}

export { ContentWorkspaceError as WorkspaceError };

function fail(code, message, details) {
  throw new ContentWorkspaceError(code, message, details);
}

function assertContentType(contentType) {
  if (typeof contentType !== "string" || !CONTENT_TYPES.has(contentType)) {
    fail("INVALID_CONTENT_TYPE", "contentType is not a supported content type.");
  }
  return contentType;
}

function assertSlug(slug, field = "slug") {
  if (
    typeof slug !== "string" ||
    slug.length < 1 ||
    slug.length > 96 ||
    !SLUG_PATTERN.test(slug)
  ) {
    fail(
      "INVALID_SLUG",
      `${field} must be a lowercase, hyphen-separated slug of at most 96 characters.`,
    );
  }
  return slug;
}

function assertReservationId(reservationId) {
  if (
    typeof reservationId !== "string" ||
    !RESERVATION_ID_PATTERN.test(reservationId)
  ) {
    fail(
      "INVALID_RESERVATION_ID",
      "reservationId is not a valid reservation identifier.",
    );
  }
  return reservationId;
}

function processPlatformIsPosix() {
  return process.platform !== "win32";
}

async function getEntryKind(entryPath) {
  try {
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    fail("WORKSPACE_IO_FAILED", "Unable to inspect the local content workspace.");
  }
}

async function ensureDirectory(
  directoryPath,
  { create = false, privateDirectory = false } = {},
) {
  if (create) {
    try {
      await mkdir(directoryPath, {
        recursive: false,
        mode: privateDirectory ? CONTROL_MODE : undefined,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail("WORKSPACE_IO_FAILED", "Unable to create a content workspace directory.");
      }
    }
  }

  const kind = await getEntryKind(directoryPath);
  if (kind === "symlink") {
    fail("UNSAFE_WORKSPACE_PATH", "A content workspace directory is a symbolic link.");
  }
  if (kind !== "directory") {
    fail("INVALID_WORKSPACE", "A required content workspace path is not a directory.");
  }

  if (privateDirectory) {
    try {
      await chmod(directoryPath, CONTROL_MODE);
    } catch {
      if (processPlatformIsPosix()) {
        fail(
          "WORKSPACE_PERMISSION_FAILED",
          "Unable to restrict content workspace control-directory permissions.",
        );
      }
    }
  }
}

function resolveWorkspace(contentType, config) {
  const workspaceRoot = config?.workspaceRoot;
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    !path.isAbsolute(workspaceRoot)
  ) {
    fail("INVALID_WORKSPACE_ROOT", "Configured workspaceRoot must be an absolute path.");
  }

  const root = path.resolve(workspaceRoot);
  const contentsRoot = path.join(root, "contents");
  return {
    root,
    contentsRoot,
    typeRoot: path.join(contentsRoot, contentType),
    reservationsRoot: path.join(contentsRoot, ".reservations", contentType),
    stagingRoot: path.join(contentsRoot, ".staging", contentType),
  };
}

async function openWorkspace(contentType, config) {
  const workspace = resolveWorkspace(contentType, config);
  await ensureDirectory(workspace.root);
  await ensureDirectory(workspace.contentsRoot, {
    create: true,
  });
  await ensureDirectory(workspace.typeRoot, {
    create: true,
  });

  const reservationsControlRoot = path.dirname(workspace.reservationsRoot);
  const stagingControlRoot = path.dirname(workspace.stagingRoot);
  await ensureDirectory(reservationsControlRoot, {
    create: true,
    privateDirectory: true,
  });
  await ensureDirectory(stagingControlRoot, {
    create: true,
    privateDirectory: true,
  });
  await ensureDirectory(workspace.reservationsRoot, {
    create: true,
    privateDirectory: true,
  });
  await ensureDirectory(workspace.stagingRoot, {
    create: true,
    privateDirectory: true,
  });
  return workspace;
}

function bundlePaths(directoryPath, slug) {
  return {
    directoryPath,
    markdownPath: path.join(directoryPath, `${slug}.md`),
    articlePath: path.join(directoryPath, `${slug}.json`),
    assetsPath: path.join(directoryPath, "assets"),
  };
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeAssetName(name) {
  if (
    typeof name !== "string" ||
    !SAFE_ASSET_NAME_PATTERN.test(name)
  ) {
    fail("UNSAFE_WORKSPACE_ENTRY", "The content assets directory has an unsafe entry.");
  }
}

async function inspectAssets(assetsPath) {
  let names;
  try {
    names = await readdir(assetsPath);
  } catch {
    fail("WORKSPACE_IO_FAILED", "Unable to inspect the content assets directory.");
  }

  names.sort(compareNames);
  if (names.length > MAX_ASSET_FILES) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "The content bundle exceeds the 10-asset workspace limit.",
    );
  }
  const files = [];
  let totalBytes = 0n;
  for (const name of names) {
    assertSafeAssetName(name);
    const entryPath = path.join(assetsPath, name);
    const kind = await getEntryKind(entryPath);
    if (kind === "symlink") {
      fail("UNSAFE_WORKSPACE_ENTRY", "A content asset is a symbolic link.");
    }
    if (kind !== "file") {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        "Every content asset entry must be an ordinary file.",
      );
    }
    let stats;
    try {
      stats = await lstat(entryPath, { bigint: true });
    } catch {
      fail("WORKSPACE_IO_FAILED", "Unable to inspect a content asset.");
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      fail("UNSAFE_WORKSPACE_ENTRY", "A content asset is not an ordinary file.");
    }
    if (stats.size > BigInt(MAX_ASSET_BYTES)) {
      fail(
        "STAGING_BUNDLE_INVALID",
        "A content asset exceeds the 100 MiB workspace limit.",
      );
    }
    totalBytes += stats.size;
    files.push({
      name,
      relativePath: `assets/${name}`,
      entryPath,
      size: stats.size,
    });
  }
  if (totalBytes > BigInt(MAX_TOTAL_ASSET_BYTES)) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "The content assets exceed the 256 MiB total workspace limit.",
    );
  }
  return files;
}

async function assertTextEntrySize(entryPath, label) {
  let stats;
  try {
    stats = await lstat(entryPath, { bigint: true });
  } catch {
    fail("WORKSPACE_IO_FAILED", `Unable to inspect the content ${label}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("UNSAFE_WORKSPACE_ENTRY", `The content ${label} is not an ordinary file.`);
  }
  if (stats.size === 0n || stats.size > BigInt(MAX_STAGING_TEXT_BYTES)) {
    fail(
      "STAGING_BUNDLE_INVALID",
      `The content ${label} must be non-empty and at most 2 MiB.`,
    );
  }
}

async function inspectBundle(directoryPath, slug) {
  const paths = bundlePaths(directoryPath, slug);
  const directoryKind = await getEntryKind(directoryPath);
  if (directoryKind === "missing") {
    return { state: "missing", paths, assetFiles: [] };
  }
  if (directoryKind === "symlink") {
    fail("UNSAFE_WORKSPACE_ENTRY", "The content bundle directory is a symbolic link.");
  }
  if (directoryKind !== "directory") {
    fail(
      "UNSAFE_WORKSPACE_ENTRY",
      "The content bundle path is not an ordinary directory.",
    );
  }

  let rootNames;
  try {
    rootNames = await readdir(directoryPath);
  } catch {
    fail("WORKSPACE_IO_FAILED", "Unable to inspect the local content bundle.");
  }
  const allowedNames = new Set([`${slug}.md`, `${slug}.json`, "assets"]);
  if (rootNames.some((name) => !allowedNames.has(name))) {
    fail("UNSAFE_WORKSPACE_ENTRY", "The content bundle has an unexpected entry.");
  }

  const [markdownKind, articleKind, assetsKind] = await Promise.all([
    getEntryKind(paths.markdownPath),
    getEntryKind(paths.articlePath),
    getEntryKind(paths.assetsPath),
  ]);
  for (const [label, kind, expected] of [
    ["Markdown", markdownKind, "file"],
    ["article JSON", articleKind, "file"],
    ["assets", assetsKind, "directory"],
  ]) {
    if (kind === "symlink") {
      fail("UNSAFE_WORKSPACE_ENTRY", `The content ${label} entry is a symbolic link.`);
    }
    if (kind !== "missing" && kind !== expected) {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        `The content ${label} entry is not an ordinary ${expected}.`,
      );
    }
  }

  const present = [markdownKind, articleKind, assetsKind].filter(
    (kind) => kind !== "missing",
  ).length;
  if (markdownKind === "file") {
    await assertTextEntrySize(paths.markdownPath, "Markdown");
  }
  if (articleKind === "file") {
    await assertTextEntrySize(paths.articlePath, "article JSON");
  }
  const assetFiles = assetsKind === "directory" ? await inspectAssets(paths.assetsPath) : [];
  return {
    state: present === 3 ? "complete" : "partial",
    paths,
    assetFiles,
  };
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function hashStableFile(entry, hash, changedCode, maximumBytes) {
  let pathBefore;
  try {
    pathBefore = await lstat(entry.entryPath, { bigint: true });
  } catch {
    fail(changedCode, "A content bundle entry changed while its digest was computed.");
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    fail("UNSAFE_WORKSPACE_ENTRY", "A content bundle entry is not an ordinary file.");
  }
  if (pathBefore.size > BigInt(maximumBytes)) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "A content bundle entry exceeds its workspace size limit.",
    );
  }

  hash.update(entry.relativePath);
  hash.update("\0");
  hash.update(String(pathBefore.size));
  hash.update("\0");

  let handle;
  try {
    handle = await open(entry.entryPath, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(pathBefore, opened)) {
      fail(changedCode, "A content bundle entry changed while its digest was computed.");
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let remaining = opened.size;
    while (remaining > 0n) {
      const requested = Number(
        remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining,
      );
      const { bytesRead } = await handle.read(buffer, 0, requested, null);
      if (bytesRead === 0) {
        fail(changedCode, "A content bundle entry changed while its digest was computed.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, null)).bytesRead !== 0) {
      fail(changedCode, "A content bundle entry changed while its digest was computed.");
    }

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(entry.entryPath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileSnapshot(opened, after) ||
      !sameFileSnapshot(after, pathAfter)
    ) {
      fail(changedCode, "A content bundle entry changed while its digest was computed.");
    }
  } catch (error) {
    if (error instanceof ContentWorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_IO_FAILED", "Unable to read a content bundle entry.");
  } finally {
    await handle?.close().catch(() => {});
  }
  hash.update("\0");
  return pathBefore.size;
}

function sameAssetCatalog(left, right) {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.name === right[index]?.name)
  );
}

async function digestBundle(bundle, slug, changedCode = "BUNDLE_CHANGED") {
  if (bundle.state === "missing") {
    return { state: "missing", digest: null };
  }
  if (bundle.state !== "complete") {
    fail("LOCAL_BUNDLE_INCOMPLETE", "The local content bundle is incomplete.");
  }

  const [markdown, articleText] = await Promise.all([
    readStableText(bundle.paths.markdownPath, "Markdown", changedCode),
    readStableText(bundle.paths.articlePath, "article JSON", changedCode),
  ]);
  if (markdown.trim().length === 0 || articleText.trim().length === 0) {
    fail("STAGING_BUNDLE_INVALID", "Content Markdown and article JSON must not be blank.");
  }

  const hash = createHash("sha256");
  hash.update("sanity-blog-content-bundle-v1\0");
  const entries = [
    {
      relativePath: `${slug}.md`,
      entryPath: bundle.paths.markdownPath,
      maximumBytes: MAX_STAGING_TEXT_BYTES,
    },
    {
      relativePath: `${slug}.json`,
      entryPath: bundle.paths.articlePath,
      maximumBytes: MAX_STAGING_TEXT_BYTES,
    },
    ...bundle.assetFiles.map((asset) => ({
      ...asset,
      maximumBytes: MAX_ASSET_BYTES,
    })),
  ];
  let totalAssetBytes = 0n;
  for (const entry of entries) {
    const isAsset = entry.relativePath.startsWith("assets/");
    const remainingAssetBytes =
      BigInt(MAX_TOTAL_ASSET_BYTES) - totalAssetBytes;
    const maximumBytes = isAsset
      ? Number(
          remainingAssetBytes < BigInt(entry.maximumBytes)
            ? remainingAssetBytes
            : BigInt(entry.maximumBytes),
        )
      : entry.maximumBytes;
    const fileBytes = await hashStableFile(
      entry,
      hash,
      changedCode,
      maximumBytes,
    );
    if (isAsset) {
      totalAssetBytes += fileBytes;
    }
  }

  const after = await inspectBundle(bundle.paths.directoryPath, slug);
  if (
    after.state !== "complete" ||
    !sameAssetCatalog(bundle.assetFiles, after.assetFiles)
  ) {
    fail(changedCode, "The content bundle changed while its digest was computed.");
  }
  return { state: "complete", digest: hash.digest("hex") };
}

function sameBaseline(left, right) {
  return (
    left?.state === right?.state &&
    (left?.state === "missing" || left?.digest === right?.digest)
  );
}

async function writeReservationMetadata(lockPath, metadata) {
  const metadataPath = path.join(lockPath, METADATA_FILE);
  try {
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: FILE_MODE,
    });
    await chmod(metadataPath, FILE_MODE);
  } catch {
    fail("WORKSPACE_IO_FAILED", "Unable to persist the content reservation.");
  }
}

async function readReservationMetadata(workspace, contentType, slug, reservationId) {
  const lockPath = path.join(workspace.reservationsRoot, slug);
  const lockKind = await getEntryKind(lockPath);
  if (lockKind === "missing") {
    fail("RESERVATION_NOT_FOUND", "No active content reservation exists for this slug.");
  }
  if (lockKind !== "directory") {
    fail("UNSAFE_RESERVATION", "The content reservation is not an ordinary directory.");
  }

  let names;
  try {
    names = await readdir(lockPath);
  } catch {
    fail("WORKSPACE_IO_FAILED", "Unable to inspect the content reservation.");
  }
  if (names.length !== 1 || names[0] !== METADATA_FILE) {
    fail("UNSAFE_RESERVATION", "The content reservation has unexpected entries.");
  }

  const metadataPath = path.join(lockPath, METADATA_FILE);
  let metadataStats;
  try {
    metadataStats = await lstat(metadataPath);
  } catch {
    fail("UNSAFE_RESERVATION", "The content reservation metadata is unavailable.");
  }
  if (
    metadataStats.isSymbolicLink() ||
    !metadataStats.isFile() ||
    metadataStats.size > MAX_METADATA_BYTES
  ) {
    fail("UNSAFE_RESERVATION", "The content reservation metadata is not an ordinary file.");
  }

  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    fail("INVALID_RESERVATION", "The content reservation metadata is invalid.");
  }
  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.contentType !== contentType ||
    metadata?.slug !== slug ||
    metadata?.reservationId !== reservationId ||
    !["create", "update"].includes(metadata?.mode) ||
    !["missing", "complete"].includes(metadata?.baseline?.state) ||
    (metadata.baseline.state === "missing" && metadata.baseline.digest !== null) ||
    (metadata.baseline.state === "complete" &&
      !DIGEST_PATTERN.test(metadata.baseline.digest))
  ) {
    fail("RESERVATION_MISMATCH", "The reservation does not match this content operation.");
  }
  return { metadata, lockPath };
}

async function copyOrdinaryFile(sourcePath, destinationPath, maximumBytes) {
  let before;
  let sourceHandle;
  let destinationHandle;
  try {
    before = await lstat(sourcePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      fail("UNSAFE_WORKSPACE_ENTRY", "A content bundle entry is not an ordinary file.");
    }
    if (before.size > BigInt(maximumBytes)) {
      fail(
        "STAGING_BUNDLE_INVALID",
        "A content bundle entry exceeds its workspace size limit.",
      );
    }

    sourceHandle = await open(sourcePath, "r");
    const opened = await sourceHandle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      fail("BASELINE_CHANGED", "The local content changed while staging was prepared.");
    }
    destinationHandle = await open(destinationPath, "wx", FILE_MODE);

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let remaining = opened.size;
    while (remaining > 0n) {
      const requested = Number(
        remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining,
      );
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, null);
      if (bytesRead === 0) {
        fail("BASELINE_CHANGED", "The local content changed while staging was prepared.");
      }
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (bytesWritten === 0) {
          fail("WORKSPACE_IO_FAILED", "Unable to copy content into staging.");
        }
        written += bytesWritten;
      }
      remaining -= BigInt(bytesRead);
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await sourceHandle.read(probe, 0, 1, null)).bytesRead !== 0) {
      fail("BASELINE_CHANGED", "The local content changed while staging was prepared.");
    }
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;

    const after = await sourceHandle.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    const destination = await lstat(destinationPath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileSnapshot(opened, after) ||
      !sameFileSnapshot(after, pathAfter) ||
      destination.isSymbolicLink() ||
      !destination.isFile() ||
      destination.size !== before.size
    ) {
      fail("BASELINE_CHANGED", "The local content changed while staging was prepared.");
    }
    await chmod(destinationPath, FILE_MODE);
    return before.size;
  } catch (error) {
    if (error instanceof ContentWorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_IO_FAILED", "Unable to copy the existing content into staging.");
  } finally {
    await sourceHandle?.close().catch(() => {});
    await destinationHandle?.close().catch(() => {});
  }
}

async function copyExistingBundle(source, destination, slug, baseline) {
  await copyOrdinaryFile(
    source.paths.markdownPath,
    destination.markdownPath,
    MAX_STAGING_TEXT_BYTES,
  );
  await copyOrdinaryFile(
    source.paths.articlePath,
    destination.articlePath,
    MAX_STAGING_TEXT_BYTES,
  );
  let copiedAssetBytes = 0n;
  for (const asset of source.assetFiles) {
    const remainingAssetBytes =
      BigInt(MAX_TOTAL_ASSET_BYTES) - copiedAssetBytes;
    const copiedBytes = await copyOrdinaryFile(
      asset.entryPath,
      path.join(destination.assetsPath, asset.name),
      Number(
        remainingAssetBytes < BigInt(MAX_ASSET_BYTES)
          ? remainingAssetBytes
          : BigInt(MAX_ASSET_BYTES),
      ),
    );
    copiedAssetBytes += copiedBytes;
  }

  const staged = await inspectBundle(destination.directoryPath, slug);
  const stagedBaseline = await digestBundle(
    staged,
    slug,
    "STAGING_BUNDLE_CHANGED",
  );
  if (!sameBaseline(baseline, stagedBaseline)) {
    fail(
      "BASELINE_CHANGED",
      "The local content changed while its staging snapshot was created.",
    );
  }
}

async function createReservationDirectory(lockPath) {
  let created = false;
  try {
    await mkdir(lockPath, { recursive: false, mode: CONTROL_MODE });
    created = true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      const kind = await getEntryKind(lockPath);
      if (kind === "directory") {
        fail("RESERVATION_CONFLICT", "Another operation already reserved this content.");
      }
      fail("UNSAFE_RESERVATION", "The content reservation path is unsafe.");
    }
    fail("WORKSPACE_IO_FAILED", "Unable to reserve the local content bundle.");
  }
  try {
    await ensureDirectory(lockPath, { privateDirectory: true });
  } catch (error) {
    if (created) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function createStagingBundle(stagingPath, slug) {
  try {
    await mkdir(stagingPath, { recursive: false, mode: CONTROL_MODE });
    await ensureDirectory(stagingPath, { privateDirectory: true });

    const paths = bundlePaths(path.join(stagingPath, slug), slug);
    await ensureDirectory(paths.directoryPath, {
      create: true,
      privateDirectory: true,
    });
    await ensureDirectory(paths.assetsPath, {
      create: true,
      privateDirectory: true,
    });
    return paths;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ContentWorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_IO_FAILED", "Unable to create content staging.");
  }
}

async function prepare({ contentType, slug, config, requireExisting }) {
  assertContentType(contentType);
  assertSlug(slug);
  const workspace = await openWorkspace(contentType, config);
  const destinationPath = path.join(workspace.typeRoot, slug);
  const localBundle = await inspectBundle(destinationPath, slug);
  if (localBundle.state === "partial") {
    fail("LOCAL_BUNDLE_INCOMPLETE", "The local content bundle is incomplete.");
  }
  if (requireExisting && localBundle.state === "missing") {
    fail("LOCAL_CONTENT_NOT_FOUND", "The local content bundle does not exist.");
  }

  const mode = localBundle.state === "complete" ? "update" : "create";
  const baseline = await digestBundle(localBundle, slug, "BASELINE_CHANGED");
  const reservationId = randomUUID();
  const lockPath = path.join(workspace.reservationsRoot, slug);
  const stagingPath = path.join(workspace.stagingRoot, reservationId);
  let lockCreated = false;
  let stagingBundle;

  try {
    await createReservationDirectory(lockPath);
    lockCreated = true;
    stagingBundle = await createStagingBundle(stagingPath, slug);

    if (mode === "update") {
      await copyExistingBundle(localBundle, stagingBundle, slug, baseline);
    }
    await writeReservationMetadata(lockPath, {
      schemaVersion: 1,
      reservationId,
      contentType,
      slug,
      mode,
      baseline,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (lockCreated) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  return {
    contentType,
    slug,
    reservationId,
    mode,
    markdownPath: stagingBundle.markdownPath,
    articlePath: stagingBundle.articlePath,
    assetsDirectory: stagingBundle.assetsPath,
  };
}

export async function prepareContentPublish({ contentType, baseSlug, config }) {
  return prepare({
    contentType: assertContentType(contentType),
    slug: assertSlug(baseSlug, "baseSlug"),
    config,
    requireExisting: false,
  });
}

export async function prepareContentUpdate({ contentType, slug, config }) {
  return prepare({
    contentType: assertContentType(contentType),
    slug: assertSlug(slug),
    config,
    requireExisting: true,
  });
}

async function readStableText(
  entryPath,
  label,
  changedCode = "STAGING_BUNDLE_CHANGED",
) {
  let before;
  try {
    before = await lstat(entryPath, { bigint: true });
  } catch {
    fail(changedCode, `The ${label} changed while being read.`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    fail("UNSAFE_WORKSPACE_ENTRY", `The staged ${label} is not an ordinary file.`);
  }
  if (before.size === 0n || before.size > BigInt(MAX_STAGING_TEXT_BYTES)) {
    fail(
      "STAGING_BUNDLE_INVALID",
      `The staged ${label} must be non-empty and at most 2 MiB.`,
    );
  }

  let handle;
  try {
    handle = await open(entryPath, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      fail(changedCode, `The ${label} changed while being read.`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(READ_CHUNK_BYTES, bytes.length - offset),
        offset,
      );
      if (bytesRead === 0) {
        fail(changedCode, `The ${label} changed while being read.`);
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      fail(changedCode, `The ${label} changed while being read.`);
    }
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(entryPath, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFileSnapshot(opened, openedAfter) ||
      !sameFileSnapshot(openedAfter, after) ||
      BigInt(bytes.length) !== before.size
    ) {
      fail(changedCode, `The ${label} changed while being read.`);
    }
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof ContentWorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_IO_FAILED", `Unable to read the staged ${label}.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertCommitReady(stagingPath, slug, contentType) {
  const staged = await inspectBundle(stagingPath, slug);
  if (staged.state !== "complete") {
    fail(
      "STAGING_BUNDLE_INCOMPLETE",
      "The staged content bundle must contain Markdown, JSON, and an assets directory.",
    );
  }
  await digestBundle(staged, slug, "STAGING_BUNDLE_CHANGED");

  const [markdown, articleText] = await Promise.all([
    readStableText(staged.paths.markdownPath, "Markdown"),
    readStableText(staged.paths.articlePath, "article JSON"),
  ]);
  if (markdown.trim().length === 0 || articleText.trim().length === 0) {
    fail("STAGING_BUNDLE_INVALID", "Staged Markdown and article JSON must not be empty.");
  }

  let article;
  try {
    article = JSON.parse(articleText);
  } catch {
    fail("STAGING_BUNDLE_INVALID", "The staged article is not valid JSON.");
  }
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    fail("STAGING_BUNDLE_INVALID", "The staged article JSON must be an object.");
  }
  const declaredSlug =
    typeof article.slug === "string" ? article.slug : article.slug?.current;
  if (declaredSlug !== undefined && declaredSlug !== slug) {
    fail("STAGING_BUNDLE_INVALID", "The staged article slug does not match its reservation.");
  }
  if (article.contentType !== undefined && article.contentType !== contentType) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "The staged article contentType does not match its reservation.",
    );
  }
}

async function assertCurrentBaseline(workspace, slug, expected) {
  const current = await inspectBundle(path.join(workspace.typeRoot, slug), slug);
  if (current.state === "partial") {
    fail("BASELINE_CHANGED", "The local content changed after it was reserved.");
  }
  const actual = await digestBundle(current, slug, "BASELINE_CHANGED");
  if (!sameBaseline(expected, actual)) {
    fail("BASELINE_CHANGED", "The local content changed after it was reserved.");
  }
}

const DEFAULT_TRANSACTION_OPS = Object.freeze({ rename });
const DEFAULT_CLEANUP_OPS = Object.freeze({ rm });

async function rollbackDirectoryTransaction({
  stagingBundlePath,
  destinationPath,
  backupPath,
  moved,
  backedUp,
  fileOps,
}) {
  let failed = false;
  if (moved) {
    try {
      await fileOps.rename(destinationPath, stagingBundlePath);
    } catch {
      failed = true;
    }
  }
  if (backedUp) {
    try {
      await fileOps.rename(backupPath, destinationPath);
    } catch {
      failed = true;
    }
  }
  return !failed;
}

async function commitDirectoryTransaction({
  stagingBundlePath,
  destinationPath,
  backupPath,
  mode,
  fileOps,
}) {
  let backedUp = false;
  let moved = false;
  try {
    if (mode === "update") {
      await fileOps.rename(destinationPath, backupPath);
      backedUp = true;
    }
    await fileOps.rename(stagingBundlePath, destinationPath);
    moved = true;
  } catch {
    const rolledBack = await rollbackDirectoryTransaction({
      stagingBundlePath,
      destinationPath,
      backupPath,
      moved,
      backedUp,
      fileOps,
    });
    if (!rolledBack) {
      fail(
        "COMMIT_ROLLBACK_FAILED",
        "The content commit failed and could not be fully rolled back.",
      );
    }
    fail("COMMIT_FAILED", "The content commit failed and was rolled back.");
  }
}

export async function commitContentReservation({
  contentType,
  slug,
  reservationId,
  config,
  fileOps = DEFAULT_TRANSACTION_OPS,
  cleanupOps = DEFAULT_CLEANUP_OPS,
}) {
  assertContentType(contentType);
  assertSlug(slug);
  assertReservationId(reservationId);
  if (!fileOps || typeof fileOps.rename !== "function") {
    fail("WORKSPACE_IO_FAILED", "Invalid internal filesystem transaction operations.");
  }
  if (!cleanupOps || typeof cleanupOps.rm !== "function") {
    fail("WORKSPACE_IO_FAILED", "Invalid internal filesystem cleanup operations.");
  }

  const workspace = await openWorkspace(contentType, config);
  const { metadata, lockPath } = await readReservationMetadata(
    workspace,
    contentType,
    slug,
    reservationId,
  );
  const stagingPath = path.join(workspace.stagingRoot, reservationId);
  const stagingKind = await getEntryKind(stagingPath);
  if (stagingKind !== "directory") {
    fail("INVALID_RESERVATION", "The content staging directory is missing or unsafe.");
  }
  await ensureDirectory(stagingPath, { privateDirectory: true });

  const stagingBundlePath = path.join(stagingPath, slug);
  await assertCommitReady(stagingBundlePath, slug, contentType);
  await assertCurrentBaseline(workspace, slug, metadata.baseline);

  const destinationPath = path.join(workspace.typeRoot, slug);
  const backupRoot = path.join(stagingPath, ".backup");
  let backupPath;
  if (metadata.mode === "update") {
    await ensureDirectory(backupRoot, {
      create: true,
      privateDirectory: true,
    });
    backupPath = path.join(backupRoot, slug);
  }
  await commitDirectoryTransaction({
    stagingBundlePath,
    destinationPath,
    backupPath,
    mode: metadata.mode,
    fileOps,
  });

  const destinationBundle = bundlePaths(destinationPath, slug);
  try {
    await cleanupOps.rm(stagingPath, { recursive: true, force: true });
    await cleanupOps.rm(lockPath, { recursive: true, force: true });
  } catch {
    fail(
      "COMMIT_CLEANUP_FAILED",
      "The content was committed, but reservation cleanup failed.",
      {
        committed: true,
        contentType,
        slug,
        reservationId,
        mode: metadata.mode,
        markdownPath: destinationBundle.markdownPath,
        articlePath: destinationBundle.articlePath,
        assetsDirectory: destinationBundle.assetsPath,
      },
    );
  }

  return {
    contentType,
    slug,
    reservationId,
    mode: metadata.mode,
    markdownPath: destinationBundle.markdownPath,
    articlePath: destinationBundle.articlePath,
    assetsDirectory: destinationBundle.assetsPath,
  };
}

export async function releaseContentReservation({
  contentType,
  slug,
  reservationId,
  config,
}) {
  assertContentType(contentType);
  assertSlug(slug);
  assertReservationId(reservationId);
  const workspace = await openWorkspace(contentType, config);
  const { lockPath } = await readReservationMetadata(
    workspace,
    contentType,
    slug,
    reservationId,
  );
  const stagingPath = path.join(workspace.stagingRoot, reservationId);
  const stagingKind = await getEntryKind(stagingPath);
  if (!["missing", "directory"].includes(stagingKind)) {
    fail("UNSAFE_RESERVATION", "The content staging path is unsafe.");
  }

  try {
    await rm(stagingPath, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  } catch {
    fail("RELEASE_FAILED", "Unable to release the content workspace reservation.");
  }
  return { contentType, slug, reservationId, released: true };
}
