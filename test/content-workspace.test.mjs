import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ContentWorkspaceError,
  commitContentReservation,
  prepareContentPublish,
  prepareContentUpdate,
  releaseContentReservation,
} from "../src/content-workspace.mjs";

const roots = new Set();

async function makeWorkspace() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), "sanityblog-content-workspace-"),
  );
  roots.add(workspaceRoot);
  return { workspaceRoot };
}

function canonicalPaths(config, contentType, slug) {
  const directoryPath = path.join(
    config.workspaceRoot,
    "contents",
    contentType,
    slug,
  );
  return {
    directoryPath,
    markdownPath: path.join(directoryPath, `${slug}.md`),
    articlePath: path.join(directoryPath, `${slug}.json`),
    assetsPath: path.join(directoryPath, "assets"),
  };
}

async function writeBundle(prepared, marker, assets = { "hero.png": marker }) {
  await Promise.all([
    writeFile(
      prepared.markdownPath,
      `# ${prepared.slug}\n\n${marker}\n`,
      "utf8",
    ),
    writeFile(
      prepared.articlePath,
      `${JSON.stringify(
        {
          slug: prepared.slug,
          contentType: prepared.contentType,
          title: marker,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    ...Object.entries(assets).map(([name, value]) =>
      writeFile(path.join(prepared.assetsDirectory, name), value),
    ),
  ]);
}

test.afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

test("same slug is independently reserved and committed for different content types", async () => {
  const config = await makeWorkspace();
  const [guide, tutorial] = await Promise.all([
    prepareContentPublish({
      contentType: "guide",
      baseSlug: "shared-slug",
      config,
    }),
    prepareContentPublish({
      contentType: "tutorial",
      baseSlug: "shared-slug",
      config,
    }),
  ]);

  assert.equal(guide.mode, "create");
  assert.equal(tutorial.mode, "create");
  assert.notEqual(guide.reservationId, tutorial.reservationId);
  assert.match(
    guide.articlePath,
    /[\\/]contents[\\/]\.staging[\\/]guide[\\/]/u,
  );
  assert.match(
    tutorial.articlePath,
    /[\\/]contents[\\/]\.staging[\\/]tutorial[\\/]/u,
  );

  await Promise.all([
    writeBundle(guide, "guide", { "image.png": "guide-image" }),
    writeBundle(tutorial, "tutorial", { "file.pdf": "tutorial-file" }),
  ]);
  const [guideCommit, tutorialCommit] = await Promise.all([
    commitContentReservation({
      contentType: "guide",
      slug: guide.slug,
      reservationId: guide.reservationId,
      config,
    }),
    commitContentReservation({
      contentType: "tutorial",
      slug: tutorial.slug,
      reservationId: tutorial.reservationId,
      config,
    }),
  ]);

  assert.equal(
    guideCommit.articlePath,
    canonicalPaths(config, "guide", "shared-slug").articlePath,
  );
  assert.equal(
    tutorialCommit.articlePath,
    canonicalPaths(config, "tutorial", "shared-slug").articlePath,
  );
  assert.equal(
    JSON.parse(await readFile(guideCommit.articlePath, "utf8")).title,
    "guide",
  );
  assert.equal(
    JSON.parse(await readFile(tutorialCommit.articlePath, "utf8")).title,
    "tutorial",
  );
});

test("update preparation copies every asset and baseline detects an asset change", async () => {
  const config = await makeWorkspace();
  const created = await prepareContentPublish({
    contentType: "comparison",
    baseSlug: "asset-baseline",
    config,
  });
  await writeBundle(created, "original", {
    "hero.png": "original-hero",
    "download.pdf": "original-download",
  });
  await commitContentReservation({
    contentType: "comparison",
    slug: created.slug,
    reservationId: created.reservationId,
    config,
  });

  const update = await prepareContentUpdate({
    contentType: "comparison",
    slug: "asset-baseline",
    config,
  });
  assert.equal(update.mode, "update");
  assert.equal(
    await readFile(path.join(update.assetsDirectory, "download.pdf"), "utf8"),
    "original-download",
  );
  await writeBundle(update, "replacement", {
    "hero.png": "replacement-hero",
    "download.pdf": "replacement-download",
  });

  const canonical = canonicalPaths(config, "comparison", "asset-baseline");
  await writeFile(path.join(canonical.assetsPath, "hero.png"), "outside-change");
  await assert.rejects(
    commitContentReservation({
      contentType: "comparison",
      slug: update.slug,
      reservationId: update.reservationId,
      config,
    }),
    (error) =>
      error instanceof ContentWorkspaceError && error.code === "BASELINE_CHANGED",
  );
  assert.equal(
    await readFile(path.join(canonical.assetsPath, "hero.png"), "utf8"),
    "outside-change",
  );
  await releaseContentReservation({
    contentType: "comparison",
    slug: update.slug,
    reservationId: update.reservationId,
    config,
  });
});

test("failed directory replacement restores the complete original bundle", async () => {
  const config = await makeWorkspace();
  const created = await prepareContentPublish({
    contentType: "solution",
    baseSlug: "rollback-content",
    config,
  });
  await writeBundle(created, "original", { "hero.png": "original-asset" });
  await commitContentReservation({
    contentType: "solution",
    slug: created.slug,
    reservationId: created.reservationId,
    config,
  });

  const update = await prepareContentUpdate({
    contentType: "solution",
    slug: "rollback-content",
    config,
  });
  await writeBundle(update, "replacement", { "hero.png": "replacement-asset" });
  let calls = 0;
  await assert.rejects(
    commitContentReservation({
      contentType: "solution",
      slug: update.slug,
      reservationId: update.reservationId,
      config,
      fileOps: {
        async rename(from, to) {
          calls += 1;
          if (calls === 2) {
            throw new Error("simulated staged-directory move failure");
          }
          await rename(from, to);
        },
      },
    }),
    (error) =>
      error instanceof ContentWorkspaceError && error.code === "COMMIT_FAILED",
  );

  const canonical = canonicalPaths(config, "solution", "rollback-content");
  assert.equal(
    JSON.parse(await readFile(canonical.articlePath, "utf8")).title,
    "original",
  );
  assert.equal(
    await readFile(path.join(canonical.assetsPath, "hero.png"), "utf8"),
    "original-asset",
  );
  await releaseContentReservation({
    contentType: "solution",
    slug: update.slug,
    reservationId: update.reservationId,
    config,
  });
});

test("commit rejects symlinked and nested asset entries", async (t) => {
  const config = await makeWorkspace();
  const linked = await prepareContentPublish({
    contentType: "alternative",
    baseSlug: "linked-asset",
    config,
  });
  await writeBundle(linked, "linked", {});
  const target = path.join(config.workspaceRoot, "outside.png");
  await writeFile(target, "outside");
  try {
    await symlink(target, path.join(linked.assetsDirectory, "linked.png"), "file");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error?.code)) {
      await releaseContentReservation({
        contentType: "alternative",
        slug: linked.slug,
        reservationId: linked.reservationId,
        config,
      });
      t.skip("Creating file symlinks is unavailable on this platform.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    commitContentReservation({
      contentType: "alternative",
      slug: linked.slug,
      reservationId: linked.reservationId,
      config,
    }),
    (error) =>
      error instanceof ContentWorkspaceError &&
      error.code === "UNSAFE_WORKSPACE_ENTRY",
  );
  await releaseContentReservation({
    contentType: "alternative",
    slug: linked.slug,
    reservationId: linked.reservationId,
    config,
  });

  const nested = await prepareContentPublish({
    contentType: "alternative",
    baseSlug: "nested-asset",
    config,
  });
  await writeBundle(nested, "nested", {});
  await mkdir(path.join(nested.assetsDirectory, "nested"));
  await assert.rejects(
    commitContentReservation({
      contentType: "alternative",
      slug: nested.slug,
      reservationId: nested.reservationId,
      config,
    }),
    (error) =>
      error instanceof ContentWorkspaceError &&
      error.code === "UNSAFE_WORKSPACE_ENTRY",
  );
  await releaseContentReservation({
    contentType: "alternative",
    slug: nested.slug,
    reservationId: nested.reservationId,
    config,
  });
});

test("content type and slug validation happens before workspace writes", async () => {
  const config = await makeWorkspace();
  for (const request of [
    { contentType: "unknown", baseSlug: "valid-slug", config },
    { contentType: "guide", baseSlug: "../escape", config },
  ]) {
    await assert.rejects(
      prepareContentPublish(request),
      (error) =>
        error instanceof ContentWorkspaceError &&
        ["INVALID_CONTENT_TYPE", "INVALID_SLUG"].includes(error.code),
    );
  }
});
