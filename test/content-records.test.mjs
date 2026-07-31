import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SafeError } from "../src/errors.mjs";
import {
  __resetContentRecordWriteQueuesForTests,
  writeContentPublicationRecord,
} from "../src/content-records.mjs";

const noopAcl = async () => {};
const roots = new Set();

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-content-record-"));
  roots.add(homeDir);
  await mkdir(path.join(homeDir, ".sanity-blog"));
  return { homeDir };
}

function receipt(contentType, slug = "shared-slug") {
  return {
    status: "published",
    id: `${contentType}-document-id`,
    revision: "revision-id",
    slug,
    contentType,
    requestId: "request-id",
    uploadedAssetIds: [
      "image-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1200x630-png",
      "file-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pdf",
    ],
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

test.afterEach(async () => {
  __resetContentRecordWriteQueuesForTests();
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

test("schema version 2 record is namespaced, strict, and keeps image/file asset IDs", async () => {
  const { homeDir } = await fixture();
  const publishedDirectory = path.join(homeDir, ".sanity-blog", "published");
  await mkdir(publishedDirectory);
  const legacyPath = path.join(publishedDirectory, "shared-slug.json");
  await writeFile(legacyPath, '{"schemaVersion":1,"legacy":true}\n', "utf8");

  const response = await writeContentPublicationRecord({
    operation: "created",
    contentType: "guide",
    article: {
      _type: "guide",
      slug: "shared-slug",
      title: "Guide",
    },
    result: receipt("guide"),
    homeDir,
    acl: noopAcl,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
  assert.equal(
    response.recordPath,
    path.join(publishedDirectory, "contents", "guide", "shared-slug.json"),
  );

  const onDisk = JSON.parse(await readFile(response.recordPath, "utf8"));
  assert.deepEqual(onDisk, response.record);
  assert.deepEqual(Object.keys(onDisk), [
    "schemaVersion",
    "recordedAt",
    "operation",
    "contentType",
    "article",
    "result",
  ]);
  assert.equal(onDisk.schemaVersion, 2);
  assert.equal(onDisk.contentType, "guide");
  assert.deepEqual(Object.keys(onDisk.result), [
    "status",
    "id",
    "revision",
    "slug",
    "contentType",
    "requestId",
    "uploadedAssetIds",
    "target",
  ]);
  assert.match(onDisk.result.uploadedAssetIds[0], /^image-/u);
  assert.match(onDisk.result.uploadedAssetIds[1], /^file-/u);
  assert.doesNotMatch(
    JSON.stringify(onDisk),
    /must-not-be-recorded|origin|headers|body|authorization/u,
  );
  assert.equal(await readFile(legacyPath, "utf8"), '{"schemaVersion":1,"legacy":true}\n');
});

test("same slug has independent latest records for different content types", async () => {
  const { homeDir } = await fixture();
  const [guide, tutorial] = await Promise.all([
    writeContentPublicationRecord({
      operation: "created",
      contentType: "guide",
      article: { title: "Guide" },
      result: receipt("guide"),
      homeDir,
      acl: noopAcl,
    }),
    writeContentPublicationRecord({
      operation: "created",
      contentType: "tutorial",
      article: { title: "Tutorial" },
      result: receipt("tutorial"),
      homeDir,
      acl: noopAcl,
    }),
  ]);

  assert.notEqual(guide.recordPath, tutorial.recordPath);
  assert.equal(
    JSON.parse(await readFile(guide.recordPath, "utf8")).article.title,
    "Guide",
  );
  assert.equal(
    JSON.parse(await readFile(tutorial.recordPath, "utf8")).article.title,
    "Tutorial",
  );
});

test("record requires a supported contentType that exactly matches the receipt", async () => {
  const { homeDir } = await fixture();
  await assert.rejects(
    writeContentPublicationRecord({
      operation: "created",
      contentType: "guide",
      article: {},
      result: receipt("tutorial"),
      homeDir,
      acl: noopAcl,
    }),
    (error) =>
      error instanceof SafeError &&
      error.code === "INVALID_PUBLICATION_RECEIPT",
  );
  await assert.rejects(
    writeContentPublicationRecord({
      operation: "created",
      contentType: "../guide",
      article: {},
      result: receipt("guide"),
      homeDir,
      acl: noopAcl,
    }),
    (error) => error instanceof SafeError && error.code === "INVALID_CONTENT_TYPE",
  );
});

test("a failure before atomic replacement preserves the previous content record", async () => {
  const { homeDir } = await fixture();
  const first = await writeContentPublicationRecord({
    operation: "created",
    contentType: "comparison",
    article: { title: "First" },
    result: receipt("comparison"),
    homeDir,
    acl: noopAcl,
  });
  const before = await readFile(first.recordPath, "utf8");
  const failingAcl = async (_targetPath, { kind }) => {
    if (kind === "file") {
      throw new Error("simulated temporary-record ACL failure");
    }
  };

  await assert.rejects(
    writeContentPublicationRecord({
      operation: "updated",
      contentType: "comparison",
      article: { title: "Must not land" },
      result: { ...receipt("comparison"), revision: "revision-2" },
      homeDir,
      platform: "win32",
      acl: failingAcl,
    }),
    (error) => error instanceof SafeError && error.code === "RECORD_WRITE_FAILED",
  );
  assert.equal(await readFile(first.recordPath, "utf8"), before);
});

test("published contents hierarchy rejects symbolic links", async (t) => {
  const { homeDir } = await fixture();
  const publishedDirectory = path.join(homeDir, ".sanity-blog", "published");
  const elsewhere = path.join(homeDir, "elsewhere");
  await mkdir(publishedDirectory);
  await mkdir(elsewhere);
  try {
    await symlink(
      elsewhere,
      path.join(publishedDirectory, "contents"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error?.code)) {
      t.skip("Creating directory links is unavailable on this platform.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    writeContentPublicationRecord({
      operation: "created",
      contentType: "blog-en",
      article: {},
      result: receipt("blog-en"),
      homeDir,
      acl: noopAcl,
    }),
    (error) => error instanceof SafeError && error.code === "UNSAFE_RECORD_PATH",
  );
});

test("concurrent writes for one type and slug leave complete latest JSON", async () => {
  const { homeDir } = await fixture();
  const writes = Array.from({ length: 12 }, (_, index) =>
    writeContentPublicationRecord({
      operation: index === 0 ? "created" : "updated",
      contentType: "tutorial",
      article: { sequence: index },
      result: {
        ...receipt("tutorial", "concurrent-record"),
        revision: `revision-${index}`,
      },
      homeDir,
      acl: noopAcl,
    }),
  );
  const completed = await Promise.all(writes);
  const onDisk = JSON.parse(await readFile(completed.at(-1).recordPath, "utf8"));
  assert.equal(onDisk.article.sequence, 11);
  assert.equal(onDisk.result.revision, "revision-11");
});
