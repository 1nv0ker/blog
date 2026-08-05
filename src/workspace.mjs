import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
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

import {
  MAX_LOCAL_ASSETS,
  MAX_TOTAL_ASSET_BYTES,
  SAFE_LOCAL_ASSET_PATH,
  assetDefinitionForFilename,
  collectBlogAssetSources,
  hasAssetSignature,
} from "./blog-assets.mjs";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const METADATA_FILE = "reservation.json";
const CONTROL_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_STAGING_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_STAGING_ASSETS = MAX_LOCAL_ASSETS;
const MAX_STAGING_ASSET_TOTAL_BYTES = MAX_TOTAL_ASSET_BYTES;
const READ_CHUNK_BYTES = 64 * 1024;
const ASSET_TRANSACTION_LOCK = ".asset-transaction";

export class WorkspaceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorkspaceError";
    this.category = "workspace";
    this.code = code;
    this.retryable = false;
    this.resultUnknown = false;
    if (details !== undefined) {
      this.details = details;
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

function fail(code, message, details) {
  throw new WorkspaceError(code, message, details);
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
    fail("INVALID_RESERVATION_ID", "reservationId is not a valid reservation identifier.");
  }
  return reservationId;
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
    throw new WorkspaceError("WORKSPACE_IO_FAILED", "Unable to inspect the local workspace.");
  }
}

async function assertDirectory(
  directoryPath,
  { create = false, privateControl = false } = {},
) {
  if (create && !privateControl) {
    fail(
      "WORKSPACE_IO_FAILED",
      "Only private workspace control directories may be created automatically.",
    );
  }

  if (create) {
    try {
      await mkdir(directoryPath, { recursive: true, mode: CONTROL_MODE });
    } catch {
      fail("WORKSPACE_IO_FAILED", "Unable to create a required workspace directory.");
    }
  }

  const kind = await getEntryKind(directoryPath);
  if (kind === "symlink") {
    fail("UNSAFE_WORKSPACE_PATH", "A required workspace directory is a symbolic link.");
  }
  if (kind !== "directory") {
    fail("INVALID_WORKSPACE", "A required workspace path is not a directory.");
  }

  if (!privateControl) {
    return;
  }

  try {
    await chmod(directoryPath, CONTROL_MODE);
  } catch (error) {
    if (processPlatformIsPosix()) {
      throw new WorkspaceError(
        "WORKSPACE_PERMISSION_FAILED",
        "Unable to restrict workspace directory permissions.",
      );
    }
  }
}

function processPlatformIsPosix() {
  return process.platform !== "win32";
}

function resolveWorkspace(config) {
  const workspaceRoot = config?.workspaceRoot;
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    !path.isAbsolute(workspaceRoot)
  ) {
    fail("INVALID_WORKSPACE_ROOT", "Configured workspaceRoot must be an absolute path.");
  }

  const root = path.resolve(workspaceRoot);
  const blogRoot = path.join(root, "blog");
  return {
    root,
    blogRoot,
    assetsRoot: path.join(blogRoot, "assets"),
    reservationsRoot: path.join(blogRoot, ".reservations"),
    stagingRoot: path.join(blogRoot, ".staging"),
  };
}

async function openWorkspace(config) {
  const workspace = resolveWorkspace(config);
  await assertDirectory(workspace.root, { create: false, privateControl: false });
  await assertDirectory(workspace.blogRoot, {
    create: false,
    privateControl: false,
  });
  await assertDirectory(workspace.assetsRoot, {
    create: false,
    privateControl: false,
  });
  await assertDirectory(workspace.reservationsRoot, {
    create: true,
    privateControl: true,
  });
  await assertDirectory(workspace.stagingRoot, {
    create: true,
    privateControl: true,
  });
  return workspace;
}

function bundlePaths(basePath, slug) {
  return {
    markdownPath: path.join(basePath, `${slug}.md`),
    articlePath: path.join(basePath, `${slug}.json`),
    coverPath: path.join(basePath, "assets", `${slug}-cover.png`),
  };
}

async function inspectBundle(basePath, slug) {
  const paths = bundlePaths(basePath, slug);
  const entries = [
    ["markdown", paths.markdownPath],
    ["article", paths.articlePath],
    ["cover", paths.coverPath],
  ];
  const kinds = await Promise.all(entries.map(([, entryPath]) => getEntryKind(entryPath)));

  for (let index = 0; index < entries.length; index += 1) {
    if (kinds[index] === "symlink") {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        `The ${entries[index][0]} bundle entry is a symbolic link.`,
      );
    }
    if (kinds[index] !== "missing" && kinds[index] !== "file") {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        `The ${entries[index][0]} bundle entry is not an ordinary file.`,
      );
    }
  }

  const present = kinds.filter((kind) => kind === "file").length;
  return {
    state: present === 0 ? "missing" : present === entries.length ? "complete" : "partial",
    paths,
    present,
  };
}

function parseArticleForAssets(articleBytes) {
  let article;
  try {
    article = JSON.parse(articleBytes.toString("utf8"));
  } catch {
    fail("STAGING_BUNDLE_INVALID", "The staged article is not valid JSON.");
  }
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    fail("STAGING_BUNDLE_INVALID", "The staged article JSON must be an object.");
  }
  return article;
}

function collectDeclaredLocalAssetNames(article) {
  const assetNames = new Map();
  for (const { kind, source, location } of collectBlogAssetSources(article)) {
    if (!source || typeof source.path !== "string") continue;
    const match = SAFE_LOCAL_ASSET_PATH.exec(source.path);
    if (!match) {
      fail(
        "STAGING_BUNDLE_INVALID",
        `${location} must use a safe flat ./assets/<filename> path.`,
      );
    }

    const filename = match[1];
    const definition = assetDefinitionForFilename(filename);
    if (!definition || definition.kind !== kind) {
      fail(
        "STAGING_BUNDLE_INVALID",
        `${location} must reference a supported ${kind} file.`,
      );
    }
    const identity = filename.toLowerCase();
    const previous = assetNames.get(identity);
    if (previous && previous !== filename) {
      fail(
        "STAGING_BUNDLE_INVALID",
        "Local asset filenames must be unique without case distinctions.",
      );
    }
    assetNames.set(identity, filename);
  }

  return [...assetNames.values()].sort();
}

function collectLocalAssetNames(article, slug) {
  const referencedAssetNames = collectDeclaredLocalAssetNames(article);
  if (referencedAssetNames.length > MAX_STAGING_ASSETS) {
    fail(
      "STAGING_BUNDLE_INVALID",
      `The article bundle references more than ${MAX_STAGING_ASSETS} local assets.`,
    );
  }
  const assetNames = [...new Set([`${slug}-cover.png`, ...referencedAssetNames])];
  const identities = new Set(assetNames.map((filename) => filename.toLowerCase()));
  if (identities.size !== assetNames.length) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "Local asset filenames must be unique without case distinctions.",
    );
  }
  return assetNames.sort();
}

async function readCompleteBundle(bundle, slug) {
  const [markdownBytes, articleBytes] = await Promise.all([
    readStableStagingFile(bundle.paths.markdownPath, {
      label: "markdown",
      maxBytes: MAX_STAGING_TEXT_BYTES,
      limitDescription: "2 MiB",
    }),
    readStableStagingFile(bundle.paths.articlePath, {
      label: "article JSON",
      maxBytes: MAX_STAGING_TEXT_BYTES,
      limitDescription: "2 MiB",
    }),
  ]);
  const article = parseArticleForAssets(articleBytes);
  const assetNames = collectLocalAssetNames(article, slug);
  const assetEntries = await Promise.all(
    assetNames.map(async (filename) => {
      const definition = assetDefinitionForFilename(filename);
      if (!definition) {
        fail(
          "STAGING_BUNDLE_INVALID",
          `The staged asset has an unsupported extension: ${filename}.`,
        );
      }
      const bytes = await readStableStagingFile(
        path.join(path.dirname(bundle.paths.coverPath), filename),
        {
          label: `${definition.kind} asset ${filename}`,
          maxBytes: definition.maxBytes,
          limitDescription: `${definition.maxBytes / (1024 * 1024)} MiB`,
        },
      );
      if (!hasAssetSignature(bytes, definition)) {
        if (filename === `${slug}-cover.png`) {
          fail("STAGING_BUNDLE_INVALID", "The staged cover must be a PNG image.");
        }
        fail(
          "STAGING_BUNDLE_INVALID",
          `The staged asset bytes do not match the extension: ${filename}.`,
        );
      }
      return [filename, bytes];
    }),
  );
  const totalAssetBytes = assetEntries.reduce(
    (total, [, bytes]) => total + bytes.length,
    0,
  );
  if (totalAssetBytes > MAX_STAGING_ASSET_TOTAL_BYTES) {
    fail(
      "STAGING_BUNDLE_INVALID",
      "The staged assets exceed the 256 MiB total limit.",
    );
  }

  return {
    markdownBytes,
    articleBytes,
    article,
    assetEntries,
    assetNames,
  };
}

async function digestBundle(bundle, slug) {
  if (bundle.state === "missing") {
    return { state: "missing", digest: null, assetNames: [] };
  }
  if (bundle.state !== "complete") {
    fail("LOCAL_BUNDLE_INCOMPLETE", "The local article bundle is incomplete.");
  }

  const snapshot = await readCompleteBundle(bundle, slug);
  const hash = createHash("sha256");
  for (const [label, bytes] of [
    ["markdown", snapshot.markdownBytes],
    ["article", snapshot.articleBytes],
    ...snapshot.assetEntries.map(([filename, bytes]) => [
      `asset:${filename}`,
      bytes,
    ]),
  ]) {
    hash.update(label);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return {
    state: "complete",
    digest: hash.digest("hex"),
    assetNames: snapshot.assetNames,
  };
}

function sameBaseline(left, right) {
  return (
    left?.state === right?.state &&
    (left.state === "missing" || left?.digest === right?.digest)
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
    fail("WORKSPACE_IO_FAILED", "Unable to persist the workspace reservation.");
  }
}

async function readReservationMetadata(workspace, slug, reservationId) {
  const lockPath = path.join(workspace.reservationsRoot, slug);
  const lockKind = await getEntryKind(lockPath);
  if (lockKind === "missing") {
    fail("RESERVATION_NOT_FOUND", "No active reservation exists for this slug.");
  }
  if (lockKind !== "directory") {
    fail("UNSAFE_RESERVATION", "The reservation entry is not a regular directory.");
  }

  const metadataPath = path.join(lockPath, METADATA_FILE);
  if ((await getEntryKind(metadataPath)) !== "file") {
    fail("UNSAFE_RESERVATION", "The reservation metadata is not an ordinary file.");
  }

  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    fail("INVALID_RESERVATION", "The reservation metadata is invalid.");
  }

  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.slug !== slug ||
    metadata?.reservationId !== reservationId ||
    !["create", "update"].includes(metadata?.mode) ||
    !["missing", "complete"].includes(metadata?.baseline?.state) ||
    (metadata.baseline.state === "complete" &&
      !/^[0-9a-f]{64}$/i.test(metadata.baseline.digest))
  ) {
    fail("RESERVATION_MISMATCH", "The reservation does not match the requested operation.");
  }

  return { metadata, lockPath };
}

async function copyExistingBundle(source, destination, assetNames) {
  await assertDirectory(path.dirname(destination.coverPath), {
    create: true,
    privateControl: true,
  });
  for (const [from, to] of [
    [source.markdownPath, destination.markdownPath],
    [source.articlePath, destination.articlePath],
    ...assetNames.map((filename) => [
      path.join(path.dirname(source.coverPath), filename),
      path.join(path.dirname(destination.coverPath), filename),
    ]),
  ]) {
    try {
      await copyFile(from, to);
      await chmod(to, FILE_MODE);
    } catch {
      fail("WORKSPACE_IO_FAILED", "Unable to copy the existing article into staging.");
    }
  }
}

async function prepare({ slug, config, requireExisting }) {
  assertSlug(slug);
  const workspace = await openWorkspace(config);
  const localBundle = await inspectBundle(workspace.blogRoot, slug);

  if (localBundle.state === "partial") {
    fail("LOCAL_BUNDLE_INCOMPLETE", "The local article bundle is incomplete.");
  }
  if (requireExisting && localBundle.state === "missing") {
    fail("LOCAL_ARTICLE_NOT_FOUND", "The local article bundle does not exist.");
  }

  const mode = localBundle.state === "complete" ? "update" : "create";
  const baseline = await digestBundle(localBundle, slug);
  const reservationId = randomUUID();
  const lockPath = path.join(workspace.reservationsRoot, slug);
  const stagingPath = path.join(workspace.stagingRoot, reservationId);
  const stagingBundle = bundlePaths(stagingPath, slug);
  let lockCreated = false;
  let stagingCreated = false;

  try {
    try {
      await mkdir(lockPath, { recursive: false, mode: CONTROL_MODE });
      lockCreated = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("RESERVATION_CONFLICT", "Another operation already reserved this slug.");
      }
      fail("WORKSPACE_IO_FAILED", "Unable to reserve the local article bundle.");
    }
    await assertDirectory(lockPath, { privateControl: true });

    await mkdir(stagingPath, {
      recursive: false,
      mode: CONTROL_MODE,
    });
    stagingCreated = true;
    await assertDirectory(stagingPath, { privateControl: true });
    await assertDirectory(path.join(stagingPath, "assets"), {
      create: true,
      privateControl: true,
    });

    if (mode === "update") {
      await copyExistingBundle(
        localBundle.paths,
        stagingBundle,
        baseline.assetNames,
      );
      const stagedBaseline = await digestBundle(
        {
          state: "complete",
          paths: stagingBundle,
        },
        slug,
      );
      if (!sameBaseline(baseline, stagedBaseline)) {
        fail(
          "BASELINE_CHANGED",
          "The local article changed while its staging snapshot was being created.",
        );
      }
    }

    await writeReservationMetadata(lockPath, {
      schemaVersion: 1,
      reservationId,
      slug,
      mode,
      baseline,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    if (stagingCreated) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    }
    if (lockCreated) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  return {
    slug,
    reservationId,
    mode,
    markdownPath: stagingBundle.markdownPath,
    articlePath: stagingBundle.articlePath,
    coverPath: stagingBundle.coverPath,
  };
}

export async function preparePublish({ baseSlug, config }) {
  return prepare({ slug: assertSlug(baseSlug, "baseSlug"), config, requireExisting: false });
}

export async function prepareUpdate({ slug, config }) {
  return prepare({ slug: assertSlug(slug), config, requireExisting: true });
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

async function readStableStagingFile(
  entryPath,
  { label, maxBytes, limitDescription },
) {
  let pathBefore;
  try {
    pathBefore = await lstat(entryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("STAGING_BUNDLE_CHANGED", `The staged ${label} changed while being read.`);
    }
    fail("WORKSPACE_IO_FAILED", "Unable to inspect the staging bundle.");
  }

  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    fail(
      "UNSAFE_WORKSPACE_ENTRY",
      `The staged ${label} is not an ordinary file.`,
    );
  }
  if (pathBefore.size === 0n) {
    fail("STAGING_BUNDLE_INVALID", `The staged ${label} must not be empty.`);
  }
  if (pathBefore.size > BigInt(maxBytes)) {
    fail(
      "STAGING_BUNDLE_INVALID",
      `The staged ${label} exceeds the ${limitDescription} limit.`,
    );
  }

  let fileHandle;
  try {
    fileHandle = await open(entryPath, "r");
    const before = await fileHandle.stat({ bigint: true });
    if (!before.isFile()) {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        `The staged ${label} is not an ordinary file.`,
      );
    }
    if (!sameFileSnapshot(pathBefore, before)) {
      fail("STAGING_BUNDLE_CHANGED", `The staged ${label} changed while being read.`);
    }

    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(READ_CHUNK_BYTES, bytes.length - offset);
      const result = await fileHandle.read(bytes, offset, length, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }

    const probe = Buffer.alloc(1);
    const { bytesRead: extraBytesRead } = await fileHandle.read(
      probe,
      0,
      probe.length,
      offset,
    );
    const after = await fileHandle.stat({ bigint: true });

    let pathAfter;
    try {
      pathAfter = await lstat(entryPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail(
          "STAGING_BUNDLE_CHANGED",
          `The staged ${label} changed while being read.`,
        );
      }
      throw error;
    }

    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      offset !== bytes.length ||
      extraBytesRead !== 0 ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, pathAfter)
    ) {
      fail("STAGING_BUNDLE_CHANGED", `The staged ${label} changed while being read.`);
    }

    return bytes;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    fail("WORKSPACE_IO_FAILED", "Unable to read the staging bundle.");
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function assertCommitReady(stagingBundle, slug) {
  const staged = await inspectBundle(path.dirname(stagingBundle.markdownPath), slug);
  if (staged.state !== "complete") {
    fail("STAGING_BUNDLE_INCOMPLETE", "The staging bundle must contain all three files.");
  }

  const snapshot = await readCompleteBundle(staged, slug);
  const markdown = snapshot.markdownBytes.toString("utf8");
  const articleText = snapshot.articleBytes.toString("utf8");

  if (markdown.trim().length === 0 || articleText.trim().length === 0) {
    fail("STAGING_BUNDLE_INVALID", "Markdown and article JSON must not be empty.");
  }

  const declaredSlug =
    typeof snapshot.article.slug === "string"
      ? snapshot.article.slug
      : snapshot.article.slug?.current;
  if (declaredSlug !== undefined && declaredSlug !== slug) {
    fail("STAGING_BUNDLE_INVALID", "The staged article slug does not match its reservation.");
  }

  const cover = snapshot.assetEntries.find(
    ([filename]) => filename === `${slug}-cover.png`,
  )?.[1];
  if (
    !cover ||
    cover.length < PNG_SIGNATURE.length ||
    !cover.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    fail("STAGING_BUNDLE_INVALID", "The staged cover must be a PNG image.");
  }

  const validatedSources = new Map();
  const addValidatedSource = (
    source,
    bytes,
    label,
    maxBytes,
    limitDescription,
  ) => {
    validatedSources.set(source, {
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      label,
      maxBytes,
      limitDescription,
    });
  };
  addValidatedSource(
    stagingBundle.markdownPath,
    snapshot.markdownBytes,
    "markdown",
    MAX_STAGING_TEXT_BYTES,
    "2 MiB",
  );
  addValidatedSource(
    stagingBundle.articlePath,
    snapshot.articleBytes,
    "article JSON",
    MAX_STAGING_TEXT_BYTES,
    "2 MiB",
  );
  for (const [filename, bytes] of snapshot.assetEntries) {
    const definition = assetDefinitionForFilename(filename);
    addValidatedSource(
      path.join(path.dirname(stagingBundle.coverPath), filename),
      bytes,
      `${definition.kind} asset ${filename}`,
      definition.maxBytes,
      `${definition.maxBytes / (1024 * 1024)} MiB`,
    );
  }

  return {
    assetNames: snapshot.assetNames,
    validatedSources,
  };
}

async function assertCurrentBaseline(workspace, slug, expected) {
  const current = await inspectBundle(workspace.blogRoot, slug);
  if (current.state === "partial") {
    fail("BASELINE_CHANGED", "The local article bundle changed after it was reserved.");
  }
  let actual;
  try {
    actual = await digestBundle(current, slug);
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      [
        "LOCAL_BUNDLE_INCOMPLETE",
        "STAGING_BUNDLE_CHANGED",
        "STAGING_BUNDLE_INVALID",
        "UNSAFE_WORKSPACE_ENTRY",
      ].includes(error.code)
    ) {
      fail("BASELINE_CHANGED", "The local article bundle changed after it was reserved.");
    }
    throw error;
  }
  if (!sameBaseline(expected, actual)) {
    fail("BASELINE_CHANGED", "The local article bundle changed after it was reserved.");
  }
  return actual;
}

function assetIdentity(filename) {
  return filename.toLowerCase();
}

async function assertExclusiveAssetOwnership(workspace, slug, candidateNames) {
  let entries;
  try {
    entries = await readdir(workspace.blogRoot);
  } catch {
    fail("WORKSPACE_IO_FAILED", "Unable to inspect article asset ownership.");
  }

  const candidateIdentities = new Set(candidateNames.map(assetIdentity));
  for (const entryName of entries) {
    if (!entryName.endsWith(".json")) {
      continue;
    }
    const otherSlug = entryName.slice(0, -".json".length);
    if (
      otherSlug === slug ||
      otherSlug.length > 96 ||
      !SLUG_PATTERN.test(otherSlug)
    ) {
      continue;
    }

    const articlePath = path.join(workspace.blogRoot, entryName);
    if ((await getEntryKind(articlePath)) !== "file") {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        "Another article JSON entry is not an ordinary file.",
      );
    }

    let article;
    try {
      const bytes = await readStableStagingFile(articlePath, {
        label: `article JSON ${entryName}`,
        maxBytes: MAX_STAGING_TEXT_BYTES,
        limitDescription: "2 MiB",
      });
      article = parseArticleForAssets(bytes);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        fail(
          "INVALID_WORKSPACE",
          "Another local article has invalid or unsafe asset metadata.",
        );
      }
      throw error;
    }

    let claimedNames;
    try {
      claimedNames = [
        `${otherSlug}-cover.png`,
        ...collectDeclaredLocalAssetNames(article),
      ];
    } catch (error) {
      if (error instanceof WorkspaceError) {
        fail(
          "INVALID_WORKSPACE",
          "Another local article has invalid or unsafe asset metadata.",
        );
      }
      throw error;
    }

    const conflict = claimedNames.find((filename) =>
      candidateIdentities.has(assetIdentity(filename)),
    );
    if (conflict) {
      fail(
        "ASSET_OWNERSHIP_CONFLICT",
        `The asset ${conflict} is also owned by another local article.`,
      );
    }
  }
}

async function acquireAssetTransactionLock(workspace) {
  const lockPath = path.join(workspace.reservationsRoot, ASSET_TRANSACTION_LOCK);
  try {
    await mkdir(lockPath, { recursive: false, mode: CONTROL_MODE });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        "ASSET_TRANSACTION_CONFLICT",
        "Another article asset transaction is already in progress.",
      );
    }
    fail("WORKSPACE_IO_FAILED", "Unable to lock the shared article assets.");
  }

  try {
    await assertDirectory(lockPath, { privateControl: true });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return lockPath;
}

function transactionPairs(
  stagingBundle,
  destinationBundle,
  backupRoot,
  slug,
  { mode, previousAssetNames, nextAssetNames, validatedSources },
) {
  const backupBundle = bundlePaths(backupRoot, slug);
  const pairs = [
    {
      source: stagingBundle.markdownPath,
      destination: destinationBundle.markdownPath,
      backup: backupBundle.markdownPath,
      destinationExists: mode === "update",
      expected: validatedSources.get(stagingBundle.markdownPath),
    },
    {
      source: stagingBundle.articlePath,
      destination: destinationBundle.articlePath,
      backup: backupBundle.articlePath,
      destinationExists: mode === "update",
      expected: validatedSources.get(stagingBundle.articlePath),
    },
  ];
  const previousAssets = new Set(previousAssetNames);
  const nextAssets = new Set(nextAssetNames);
  const allAssets = [...new Set([...previousAssets, ...nextAssets])].sort();
  for (const filename of allAssets) {
    pairs.push({
      source: nextAssets.has(filename)
        ? path.join(path.dirname(stagingBundle.coverPath), filename)
        : null,
      destination: path.join(path.dirname(destinationBundle.coverPath), filename),
      backup: path.join(path.dirname(backupBundle.coverPath), filename),
      destinationExists: previousAssets.has(filename),
      expected: nextAssets.has(filename)
        ? validatedSources.get(
            path.join(path.dirname(stagingBundle.coverPath), filename),
          )
        : null,
    });
  }
  return pairs;
}

const DEFAULT_TRANSACTION_OPS = Object.freeze({ rename });
const DEFAULT_CLEANUP_OPS = Object.freeze({ rm });

async function rollbackTransaction({ moved, backedUp, fileOps }) {
  let failed = false;
  for (const pair of [...moved].reverse()) {
    try {
      await fileOps.rename(pair.destination, pair.source);
    } catch {
      failed = true;
    }
  }
  for (const pair of [...backedUp].reverse()) {
    try {
      await fileOps.rename(pair.backup, pair.destination);
    } catch {
      failed = true;
    }
  }
  return !failed;
}

async function commitTransaction({ pairs, fileOps = DEFAULT_TRANSACTION_OPS }) {
  if (!fileOps || typeof fileOps.rename !== "function") {
    fail("WORKSPACE_IO_FAILED", "Invalid internal filesystem operations.");
  }

  for (const pair of pairs) {
    const destinationKind = await getEntryKind(pair.destination);
    if (
      (pair.destinationExists && destinationKind !== "file") ||
      (!pair.destinationExists && destinationKind !== "missing")
    ) {
      fail(
        "BASELINE_CHANGED",
        "The local article bundle changed before its transaction started.",
      );
    }
    if (pair.source !== null && (await getEntryKind(pair.source)) !== "file") {
      fail(
        "UNSAFE_WORKSPACE_ENTRY",
        "A staged bundle entry is no longer an ordinary file.",
      );
    }
    if (pair.source !== null && !pair.expected) {
      fail("WORKSPACE_IO_FAILED", "A staged bundle entry lacks a validated snapshot.");
    }
  }

  const backedUp = [];
  const moved = [];
  try {
    for (const pair of pairs) {
      if (pair.destinationExists) {
        await fileOps.rename(pair.destination, pair.backup);
        backedUp.push(pair);
      }
    }
    for (const pair of pairs) {
      if (pair.source !== null) {
        await fileOps.rename(pair.source, pair.destination);
        moved.push(pair);
      }
    }
    for (const pair of moved) {
      const bytes = await readStableStagingFile(pair.destination, {
        label: pair.expected.label,
        maxBytes: pair.expected.maxBytes,
        limitDescription: pair.expected.limitDescription,
      });
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length !== pair.expected.size ||
        digest !== pair.expected.digest
      ) {
        fail(
          "STAGING_BUNDLE_CHANGED",
          `The staged ${pair.expected.label} changed before promotion.`,
        );
      }
    }
  } catch {
    const rolledBack = await rollbackTransaction({ moved, backedUp, fileOps });
    if (!rolledBack) {
      fail(
        "COMMIT_ROLLBACK_FAILED",
        "The workspace commit failed and could not be fully rolled back.",
      );
    }
    fail("COMMIT_FAILED", "The workspace commit failed and was rolled back.");
  }
}

export async function commitReservation({
  slug,
  reservationId,
  config,
  fileOps = DEFAULT_TRANSACTION_OPS,
  cleanupOps = DEFAULT_CLEANUP_OPS,
}) {
  assertSlug(slug);
  assertReservationId(reservationId);
  const workspace = await openWorkspace(config);
  const { metadata, lockPath } = await readReservationMetadata(
    workspace,
    slug,
    reservationId,
  );
  const stagingPath = path.join(workspace.stagingRoot, reservationId);
  const stagingAssetsPath = path.join(stagingPath, "assets");
  if (
    (await getEntryKind(stagingPath)) !== "directory" ||
    (await getEntryKind(stagingAssetsPath)) !== "directory"
  ) {
    fail("INVALID_RESERVATION", "The reservation staging directory is missing or unsafe.");
  }
  await assertDirectory(stagingPath, { privateControl: true });
  await assertDirectory(stagingAssetsPath, { privateControl: true });

  const stagingBundle = bundlePaths(stagingPath, slug);
  const staged = await assertCommitReady(stagingBundle, slug);
  const destinationBundle = bundlePaths(workspace.blogRoot, slug);
  const assetLockPath = await acquireAssetTransactionLock(workspace);
  let committed = false;
  let result;
  let operationError;
  try {
    const current = await assertCurrentBaseline(
      workspace,
      slug,
      metadata.baseline,
    );
    await assertExclusiveAssetOwnership(
      workspace,
      slug,
      [...new Set([...current.assetNames, ...staged.assetNames])],
    );

    const backupRoot = path.join(stagingPath, ".backup");
    await assertDirectory(backupRoot, {
      create: true,
      privateControl: true,
    });
    await assertDirectory(path.join(backupRoot, "assets"), {
      create: true,
      privateControl: true,
    });
    const pairs = transactionPairs(
      stagingBundle,
      destinationBundle,
      backupRoot,
      slug,
      {
        mode: metadata.mode,
        previousAssetNames: current.assetNames,
        nextAssetNames: staged.assetNames,
        validatedSources: staged.validatedSources,
      },
    );
    await commitTransaction({ pairs, fileOps });
    committed = true;

    try {
      await cleanupOps.rm(stagingPath, { recursive: true, force: true });
      await cleanupOps.rm(lockPath, { recursive: true, force: true });
    } catch {
      fail(
        "COMMIT_CLEANUP_FAILED",
        "The article was committed, but reservation cleanup failed.",
        {
          committed: true,
          slug,
          reservationId,
          mode: metadata.mode,
          markdownPath: destinationBundle.markdownPath,
          articlePath: destinationBundle.articlePath,
          coverPath: destinationBundle.coverPath,
        },
      );
    }
    result = {
      slug,
      reservationId,
      mode: metadata.mode,
      markdownPath: destinationBundle.markdownPath,
      articlePath: destinationBundle.articlePath,
      coverPath: destinationBundle.coverPath,
    };
  } catch (error) {
    operationError = error;
  }

  let assetLockCleanupFailed = false;
  try {
    await rm(assetLockPath, { recursive: true, force: true });
  } catch {
    assetLockCleanupFailed = true;
  }

  if (operationError) {
    if (committed && !(operationError instanceof WorkspaceError)) {
      fail(
        "COMMIT_CLEANUP_FAILED",
        "The article was committed, but reservation cleanup failed.",
        {
          committed: true,
          slug,
          reservationId,
          mode: metadata.mode,
          markdownPath: destinationBundle.markdownPath,
          articlePath: destinationBundle.articlePath,
          coverPath: destinationBundle.coverPath,
        },
      );
    }
    throw operationError;
  }
  if (assetLockCleanupFailed) {
    fail(
      "COMMIT_CLEANUP_FAILED",
      "The article was committed, but reservation cleanup failed.",
      {
        committed: true,
        slug,
        reservationId,
        mode: metadata.mode,
        markdownPath: destinationBundle.markdownPath,
        articlePath: destinationBundle.articlePath,
        coverPath: destinationBundle.coverPath,
      },
    );
  }
  return result;
}

export async function releaseReservation({ slug, reservationId, config }) {
  assertSlug(slug);
  assertReservationId(reservationId);
  const workspace = await openWorkspace(config);
  const { lockPath } = await readReservationMetadata(workspace, slug, reservationId);
  const stagingPath = path.join(workspace.stagingRoot, reservationId);

  try {
    await rm(stagingPath, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  } catch {
    fail("RELEASE_FAILED", "Unable to release the workspace reservation.");
  }

  return { slug, reservationId, released: true };
}
