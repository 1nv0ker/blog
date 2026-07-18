import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyPrivatePermissions,
  checkConfig,
  getDefaultWorkspaceRoot,
  initializeConfig,
  loadConfig,
  validateConfigObject,
} from "../src/config.mjs";
import {
  DEFAULT_PUBLISHER_API_ORIGIN,
  DEFAULT_SANITY_API_VERSION,
} from "../src/constants.mjs";
import { SafeError, toSafeErrorResult } from "../src/errors.mjs";
import { writePublicationRecord } from "../src/records.mjs";

const noopAcl = async () => {};
const execFileAsync = promisify(execFile);

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-records-"));
  const workspaceRoot = path.join(homeDir, "workspace");
  await mkdir(workspaceRoot);
  return {
    homeDir,
    workspaceRoot,
    config: {
      publisherApiOrigin: DEFAULT_PUBLISHER_API_ORIGIN,
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

test(
  "Windows ACL replaces explicit other-user access and ignores USERNAME spoofing",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sanityblog acl ' & -"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "config ' & file.json");
    await writeFile(file, "{}", "utf8");
    await execFileAsync("icacls.exe", [root, "/grant", "*S-1-1-0:(OI)(CI)R"]);
    await execFileAsync("icacls.exe", [file, "/grant", "*S-1-1-0:R"]);

    const originalUserName = process.env.USERNAME;
    try {
      process.env.USERNAME = "not-the-current-user";
      await applyPrivatePermissions(root, "directory");
      await applyPrivatePermissions(file, "file");
    } finally {
      if (originalUserName === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUserName;
      }
    }
  },
);
test("managed configuration persists only Sanity fields and creates the local workspace", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-managed-config-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));

  const summary = await initializeConfig(
    {
      projectId: "project-id",
      dataset: "production",
      sanityToken: "secret-token-never-serialize",
    },
    { homeDir, platform: process.platform, acl: noopAcl },
  );

  const configPath = path.join(homeDir, ".sanity-blog", "config.json");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(persisted), ["projectId", "dataset", "sanityToken"]);
  assert.deepEqual(persisted, {
    projectId: "project-id",
    dataset: "production",
    sanityToken: "secret-token-never-serialize",
  });

  const workspaceRoot = getDefaultWorkspaceRoot(homeDir);
  for (const directory of [
    workspaceRoot,
    path.join(workspaceRoot, "blog"),
    path.join(workspaceRoot, "blog", "assets"),
  ]) {
    const stats = await lstat(directory);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
  }

  const loaded = await loadConfig({ homeDir, acl: noopAcl });
  assert.equal(loaded.publisherApiOrigin, DEFAULT_PUBLISHER_API_ORIGIN);
  assert.equal(loaded.apiVersion, DEFAULT_SANITY_API_VERSION);
  assert.equal(loaded.workspaceRoot, workspaceRoot);
  assert.equal(summary.workspaceRoot, workspaceRoot);
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

test("configuration rejects unknown keys and requires reinit for malformed legacy targets", async (t) => {
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
    (error) =>
      error instanceof SafeError && error.code === "LEGACY_CONFIG_REQUIRES_REINIT",
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

test("managed workspace check rejects a replaced assets junction", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-managed-junction-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await initializeConfig(
    {
      projectId: "project-id",
      dataset: "production",
      sanityToken: "secret-token-never-serialize",
    },
    { homeDir, acl: noopAcl },
  );

  const assetsPath = path.join(getDefaultWorkspaceRoot(homeDir), "blog", "assets");
  const elsewhere = path.join(homeDir, "elsewhere");
  await rm(assetsPath, { recursive: true });
  await mkdir(elsewhere);
  try {
    await symlink(elsewhere, assetsPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating a managed-workspace link is unavailable.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    loadConfig({ homeDir, acl: noopAcl }),
    (error) => error instanceof SafeError && error.code === "UNSAFE_CONFIG_PATH",
  );
});

test("failed config temp-file permissions preserve the previous bytes", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-config-atomic-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const first = {
    projectId: "project-id",
    dataset: "production",
    sanityToken: "first-secret-token",
  };
  await initializeConfig(first, { homeDir, acl: noopAcl });
  const configDirectory = path.join(homeDir, ".sanity-blog");
  const configPath = path.join(configDirectory, "config.json");
  const before = await readFile(configPath, "utf8");
  const failingAcl = async (targetPath, { kind }) => {
    if (kind === "file" && path.basename(targetPath).startsWith(".config.")) {
      throw new Error("simulated temp ACL failure");
    }
  };

  await assert.rejects(
    initializeConfig(
      { ...first, sanityToken: "replacement-secret-token" },
      { homeDir, platform: "win32", acl: failingAcl },
    ),
    (error) => error instanceof SafeError && error.code === "UNSAFE_PERMISSIONS",
  );
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(
    (await readdir(configDirectory)).some((name) => name.startsWith(".config.")),
    false,
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
