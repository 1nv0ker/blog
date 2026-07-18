import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkConfig,
  initializeConfig,
  loadConfig,
  validateConfigObject,
} from "../src/config.mjs";
import { SafeError, toSafeErrorResult } from "../src/errors.mjs";
import { writePublicationRecord } from "../src/records.mjs";

const noopAcl = async () => {};

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-records-"));
  const workspaceRoot = path.join(homeDir, "workspace");
  await mkdir(workspaceRoot);
  return {
    homeDir,
    workspaceRoot,
    config: {
      publisherApiOrigin: "https://publisher.example.test",
      projectId: "project-id",
      dataset: "production",
      apiVersion: "2026-07-05",
      sanityToken: "secret-token-never-serialize",
      workspaceRoot,
    },
  };
}

function receipt(slug = "example-post") {
  return {
    status: "published",
    id: "document-id",
    revision: "revision-id",
    slug,
    requestId: "request-id",
    uploadedAssetIds: ["image-asset-id"],
    target: {
      projectId: "project-id",
      dataset: "production",
      apiVersion: "2026-07-05",
    },
    origin: "must-not-be-recorded",
    headers: { authorization: "must-not-be-recorded" },
    body: "must-not-be-recorded",
  };
}

async function initialize(fixtureValue) {
  return initializeConfig(fixtureValue.config, {
    homeDir: fixtureValue.homeDir,
    platform: process.platform,
    acl: noopAcl,
  });
}

test("SafeError serialization only exposes explicitly safe fields", () => {
  const cause = new Error("token=secret-token-never-serialize");
  const error = new SafeError({
    category: "network",
    code: "TIMEOUT",
    safeMessage: "The request timed out.",
    resultUnknown: true,
    cause,
  });
  const serialized = JSON.stringify(toSafeErrorResult(error));
  assert.doesNotMatch(serialized, /secret-token/u);
  assert.doesNotMatch(serialized, /stack/u);
  assert.deepEqual(JSON.parse(serialized), {
    ok: false,
    error: {
      category: "network",
      code: "TIMEOUT",
      retryable: false,
      resultUnknown: true,
      message: "The request timed out.",
    },
  });
});

test("configuration initializes atomically and safe summaries omit token and origin", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  const summary = await initialize(value);
  assert.equal(summary.configured, true);
  assert.deepEqual(summary.target, {
    projectId: "project-id",
    dataset: "production",
    apiVersion: "2026-07-05",
  });
  assert.equal("sanityToken" in summary, false);
  assert.equal("publisherApiOrigin" in summary, false);

  const loaded = await loadConfig({
    homeDir: value.homeDir,
    acl: noopAcl,
  });
  assert.equal(loaded.sanityToken, "secret-token-never-serialize");
  assert.equal(JSON.stringify(loaded).includes("secret-token"), false);
  assert.equal((await checkConfig({ homeDir: value.homeDir, acl: noopAcl })).configured, true);
});

test("configuration rejects unknown keys and non-bare origins", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await assert.rejects(
    initializeConfig(
      { ...value.config, extra: true },
      { homeDir: value.homeDir, acl: noopAcl },
    ),
    (error) => error instanceof SafeError && error.code === "INVALID_CONFIG",
  );
  await assert.rejects(
    initializeConfig(
      { ...value.config, publisherApiOrigin: "https://publisher.example.test/" },
      { homeDir: value.homeDir, acl: noopAcl },
    ),
    (error) => error instanceof SafeError && error.code === "INVALID_CONFIG",
  );
});

test("configuration enforces identifier and token length limits", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  assert.doesNotThrow(() =>
    validateConfigObject({
      ...value.config,
      projectId: "a".repeat(64),
      dataset: "A".repeat(64),
      sanityToken: "t".repeat(4096),
    }),
  );

  for (const [field, candidate] of [
    ["projectId", "a".repeat(65)],
    ["dataset", "A".repeat(65)],
    ["sanityToken", "t".repeat(4097)],
  ]) {
    assert.throws(
      () => validateConfigObject({ ...value.config, [field]: candidate }),
      (error) => error instanceof SafeError && error.code === "INVALID_CONFIG",
    );
  }
});

test("configuration path rejects a symbolic-link file", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  const configDirectory = path.join(value.homeDir, ".sanity-blog");
  await mkdir(configDirectory);
  const source = path.join(value.homeDir, "elsewhere.json");
  await writeFile(source, JSON.stringify(value.config));
  try {
    await symlink(source, path.join(configDirectory, "config.json"), "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating file symlinks requires Windows Developer Mode.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    loadConfig({ homeDir: value.homeDir, acl: noopAcl }),
    (error) => error instanceof SafeError && error.code === "UNSAFE_CONFIG_PATH",
  );
});

test("publication record uses the strict schema and result whitelist", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);

  const response = await writePublicationRecord({
    operation: "created",
    article: { slug: "example-post", title: "Example", publishedAt: "2026-07-18T12:00:00.000Z" },
    result: receipt(),
    homeDir: value.homeDir,
    acl: noopAcl,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  });
  const onDisk = JSON.parse(await readFile(response.recordPath, "utf8"));
  assert.deepEqual(onDisk, response.record);
  assert.deepEqual(Object.keys(onDisk), [
    "schemaVersion",
    "recordedAt",
    "operation",
    "article",
    "result",
  ]);
  assert.deepEqual(Object.keys(onDisk.result), [
    "status",
    "id",
    "revision",
    "slug",
    "requestId",
    "uploadedAssetIds",
    "target",
  ]);
  const serialized = JSON.stringify(onDisk);
  assert.doesNotMatch(serialized, /must-not-be-recorded/u);
  assert.doesNotMatch(serialized, /origin|headers|body|stack|secret-token/u);
});

test("latest successful record overwrites the same slug", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);

  await writePublicationRecord({
    operation: "created",
    article: { slug: "example-post", title: "First" },
    result: receipt(),
    homeDir: value.homeDir,
    acl: noopAcl,
  });
  const updated = await writePublicationRecord({
    operation: "updated",
    article: { slug: "example-post", title: "Second" },
    result: { ...receipt(), revision: "revision-2" },
    homeDir: value.homeDir,
    acl: noopAcl,
  });
  const onDisk = JSON.parse(await readFile(updated.recordPath, "utf8"));
  assert.equal(onDisk.operation, "updated");
  assert.equal(onDisk.article.title, "Second");
  assert.equal(onDisk.result.revision, "revision-2");
});

test("a failure before atomic replacement does not overwrite the old record", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);
  const first = await writePublicationRecord({
    operation: "created",
    article: { slug: "example-post", title: "First" },
    result: receipt(),
    homeDir: value.homeDir,
    acl: noopAcl,
  });
  const before = await readFile(first.recordPath, "utf8");
  const failingAcl = async (_targetPath, { kind }) => {
    if (kind === "file") {
      throw new Error("simulated ACL failure");
    }
  };
  await assert.rejects(
    writePublicationRecord({
      operation: "updated",
      article: { slug: "example-post", title: "Should not land" },
      result: { ...receipt(), revision: "revision-2" },
      homeDir: value.homeDir,
      platform: "win32",
      acl: failingAcl,
    }),
    (error) => error instanceof SafeError && error.code === "RECORD_WRITE_FAILED",
  );
  assert.equal(await readFile(first.recordPath, "utf8"), before);
});

test("concurrent writes for one slug are serialized and always leave complete JSON", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);
  const writes = Array.from({ length: 20 }, (_, index) =>
    writePublicationRecord({
      operation: index === 0 ? "created" : "updated",
      article: { slug: "example-post", sequence: index },
      result: { ...receipt(), revision: `revision-${index}` },
      homeDir: value.homeDir,
      acl: noopAcl,
    }),
  );
  const completed = await Promise.all(writes);
  const onDisk = JSON.parse(await readFile(completed.at(-1).recordPath, "utf8"));
  assert.equal(onDisk.article.sequence, 19);
  assert.equal(onDisk.result.revision, "revision-19");
});

test("published directory and target reject symbolic links", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);
  const publishedDirectory = path.join(value.homeDir, ".sanity-blog", "published");
  const elsewhere = path.join(value.homeDir, "elsewhere");
  await mkdir(elsewhere);
  try {
    await symlink(elsewhere, publishedDirectory, "junction");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating directory links is not available.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    writePublicationRecord({
      operation: "created",
      article: { slug: "example-post" },
      result: receipt(),
      homeDir: value.homeDir,
      acl: noopAcl,
    }),
    (error) => error instanceof SafeError && error.code === "UNSAFE_RECORD_PATH",
  );
});

test("POSIX record files are mode 0600", { skip: process.platform === "win32" }, async (t) => {
  const value = await fixture();
  t.after(() => rm(value.homeDir, { recursive: true, force: true }));
  await initialize(value);
  const response = await writePublicationRecord({
    operation: "created",
    article: { slug: "example-post" },
    result: receipt(),
    homeDir: value.homeDir,
    acl: noopAcl,
  });
  await chmod(response.recordPath, 0o600);
  assert.equal((await lstat(response.recordPath)).mode & 0o777, 0o600);
});
