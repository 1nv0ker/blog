import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  rename,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WorkspaceError,
  commitReservation,
  preparePublish,
  prepareUpdate,
  releaseReservation,
} from "../src/workspace.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const TWO_MIB = 2 * 1024 * 1024;
const TWENTY_MIB = 20 * 1024 * 1024;

const roots = new Set();

async function makeWorkspace({ initialize = true } = {}) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "sanityblog-workspace-"));
  roots.add(workspaceRoot);
  if (initialize) {
    await mkdir(path.join(workspaceRoot, "blog", "assets"), { recursive: true });
  }
  return { workspaceRoot };
}

async function permissionMode(entryPath) {
  return (await stat(entryPath)).mode & 0o777;
}

async function createDirectoryLink(target, linkPath) {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function livePaths(config, slug) {
  const blog = path.join(config.workspaceRoot, "blog");
  return {
    markdownPath: path.join(blog, `${slug}.md`),
    articlePath: path.join(blog, `${slug}.json`),
    coverPath: path.join(blog, "assets", `${slug}-cover.png`),
  };
}

async function writeBundle(paths, slug, marker = "original") {
  await mkdir(path.dirname(paths.coverPath), { recursive: true });
  await Promise.all([
    writeFile(paths.markdownPath, `# ${slug}\n\n${marker}\n`, "utf8"),
    writeFile(
      paths.articlePath,
      `${JSON.stringify({ slug, title: marker, body: [] }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(paths.coverPath, PNG_1X1),
  ]);
}

async function readBundle(paths) {
  return {
    markdown: await readFile(paths.markdownPath, "utf8"),
    article: await readFile(paths.articlePath, "utf8"),
    cover: await readFile(paths.coverPath),
  };
}

test.afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

test("rejects unsafe slugs before creating a reservation", async () => {
  const config = await makeWorkspace();
  await assert.rejects(
    preparePublish({ baseSlug: "../escape", config }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_SLUG",
  );
});

test("accepts a 96-character slug and rejects a longer slug", async () => {
  const config = await makeWorkspace();
  const maximumSlug = "a".repeat(96);
  const prepared = await preparePublish({ baseSlug: maximumSlug, config });

  await releaseReservation({
    slug: maximumSlug,
    reservationId: prepared.reservationId,
    config,
  });
  await assert.rejects(
    preparePublish({ baseSlug: "a".repeat(97), config }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_SLUG",
  );
});

test("requires pre-existing blog and assets directories without creating them", async () => {
  const config = await makeWorkspace({ initialize: false });
  const blogRoot = path.join(config.workspaceRoot, "blog");
  const assetsRoot = path.join(blogRoot, "assets");

  await assert.rejects(
    preparePublish({ baseSlug: "missing-blog", config }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_WORKSPACE",
  );
  await assert.rejects(lstat(blogRoot), { code: "ENOENT" });

  await mkdir(blogRoot);
  await assert.rejects(
    preparePublish({ baseSlug: "missing-assets", config }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_WORKSPACE",
  );
  await assert.rejects(lstat(assetsRoot), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(blogRoot, ".reservations")), {
    code: "ENOENT",
  });
  await assert.rejects(lstat(path.join(blogRoot, ".staging")), { code: "ENOENT" });
});

test("rejects symbolic-link blog and assets directories", async (t) => {
  for (const linkedDirectory of ["blog", "assets"]) {
    const config = await makeWorkspace({ initialize: false });
    const blogRoot = path.join(config.workspaceRoot, "blog");
    const target = path.join(config.workspaceRoot, `real-${linkedDirectory}`);

    if (linkedDirectory === "blog") {
      await mkdir(path.join(target, "assets"), { recursive: true });
    } else {
      await mkdir(blogRoot);
      await mkdir(target);
    }

    const linkPath =
      linkedDirectory === "blog" ? blogRoot : path.join(blogRoot, "assets");
    try {
      await createDirectoryLink(target, linkPath);
    } catch (error) {
      if (["EACCES", "EPERM"].includes(error?.code)) {
        t.skip("Directory symbolic links are unavailable on this platform.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      preparePublish({ baseSlug: `linked-${linkedDirectory}`, config }),
      (error) =>
        error instanceof WorkspaceError && error.code === "UNSAFE_WORKSPACE_PATH",
    );
  }
});

test(
  "preserves ordinary directory modes and restricts private control directories",
  { skip: process.platform === "win32" },
  async () => {
    const config = await makeWorkspace();
    const blogRoot = path.join(config.workspaceRoot, "blog");
    const assetsRoot = path.join(blogRoot, "assets");
    await chmod(config.workspaceRoot, 0o751);
    await chmod(blogRoot, 0o750);
    await chmod(assetsRoot, 0o755);

    const prepared = await preparePublish({ baseSlug: "permission-post", config });
    const stagingPath = path.dirname(prepared.markdownPath);

    assert.equal(await permissionMode(config.workspaceRoot), 0o751);
    assert.equal(await permissionMode(blogRoot), 0o750);
    assert.equal(await permissionMode(assetsRoot), 0o755);
    for (const controlPath of [
      path.join(blogRoot, ".reservations"),
      path.join(blogRoot, ".reservations", "permission-post"),
      path.join(blogRoot, ".staging"),
      stagingPath,
      path.join(stagingPath, "assets"),
    ]) {
      assert.equal(await permissionMode(controlPath), 0o700);
    }

    await releaseReservation({
      slug: "permission-post",
      reservationId: prepared.reservationId,
      config,
    });
  },
);

test("prepare publish creates an empty staging location for a new bundle", async () => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "new-post", config });

  assert.equal(prepared.mode, "create");
  assert.match(prepared.reservationId, /^[0-9a-f-]{36}$/i);
  assert.equal(path.basename(prepared.articlePath), "new-post.json");
  assert.equal(path.basename(prepared.markdownPath), "new-post.md");
  assert.equal(path.basename(prepared.coverPath), "new-post-cover.png");
  await assert.rejects(readFile(prepared.articlePath), { code: "ENOENT" });

  await releaseReservation({
    slug: "new-post",
    reservationId: prepared.reservationId,
    config,
  });
});

test("partial local bundles are rejected without leaving a reservation", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "partial-post");
  await mkdir(path.dirname(paths.coverPath), { recursive: true });
  await writeFile(paths.articlePath, '{"slug":"partial-post"}\n', "utf8");

  await assert.rejects(
    preparePublish({ baseSlug: "partial-post", config }),
    (error) =>
      error instanceof WorkspaceError && error.code === "LOCAL_BUNDLE_INCOMPLETE",
  );

  await assert.rejects(
    readFile(
      path.join(config.workspaceRoot, "blog", ".reservations", "partial-post", "reservation.json"),
    ),
    { code: "ENOENT" },
  );
});

test("only one concurrent reservation can own a slug", async () => {
  const config = await makeWorkspace();
  const results = await Promise.allSettled([
    preparePublish({ baseSlug: "contended-post", config }),
    preparePublish({ baseSlug: "contended-post", config }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "RESERVATION_CONFLICT");

  await releaseReservation({
    slug: "contended-post",
    reservationId: fulfilled[0].value.reservationId,
    config,
  });
});

test("prepare update requires a complete existing local bundle", async () => {
  const config = await makeWorkspace();
  await assert.rejects(
    prepareUpdate({ slug: "missing-post", config }),
    (error) =>
      error instanceof WorkspaceError && error.code === "LOCAL_ARTICLE_NOT_FOUND",
  );

  const paths = livePaths(config, "incomplete-post");
  await mkdir(path.dirname(paths.coverPath), { recursive: true });
  await writeFile(paths.markdownPath, "# incomplete\n", "utf8");
  await assert.rejects(
    prepareUpdate({ slug: "incomplete-post", config }),
    (error) =>
      error instanceof WorkspaceError && error.code === "LOCAL_BUNDLE_INCOMPLETE",
  );
});

test("prepare update bounds and rejects empty files in the live bundle", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "bounded-live");
  const oversizedCover = Buffer.alloc(TWENTY_MIB + 1);
  PNG_1X1.copy(oversizedCover);
  const invalidFiles = [
    [paths.markdownPath, Buffer.alloc(TWO_MIB + 1, 0x61)],
    [paths.articlePath, Buffer.alloc(TWO_MIB + 1, 0x61)],
    [paths.coverPath, Buffer.alloc(0)],
    [paths.coverPath, oversizedCover],
  ];

  for (const [entryPath, bytes] of invalidFiles) {
    await writeBundle(paths, "bounded-live", "valid");
    await writeFile(entryPath, bytes);
    await assert.rejects(
      prepareUpdate({ slug: "bounded-live", config }),
      (error) =>
        error instanceof WorkspaceError && error.code === "STAGING_BUNDLE_INVALID",
    );
  }
});

test("prepare update copies a complete immutable baseline and release must match", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "existing-post");
  await writeBundle(paths, "existing-post");
  const prepared = await prepareUpdate({ slug: "existing-post", config });

  assert.equal(prepared.mode, "update");
  assert.deepEqual(await readBundle(prepared), await readBundle(paths));

  await assert.rejects(
    releaseReservation({
      slug: "existing-post",
      reservationId: "00000000-0000-4000-8000-000000000000",
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "RESERVATION_MISMATCH",
  );
  await releaseReservation({
    slug: "existing-post",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects a symbolic-link staging directory", async (t) => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "linked-staging", config });
  await writeBundle(prepared, "linked-staging");
  const stagingPath = path.dirname(prepared.markdownPath);
  const movedStagingPath = path.join(config.workspaceRoot, "moved-staging");
  await rename(stagingPath, movedStagingPath);

  try {
    await createDirectoryLink(movedStagingPath, stagingPath);
  } catch (error) {
    await rename(movedStagingPath, stagingPath);
    await releaseReservation({
      slug: "linked-staging",
      reservationId: prepared.reservationId,
      config,
    });
    if (["EACCES", "EPERM"].includes(error?.code)) {
      t.skip("Directory symbolic links are unavailable on this platform.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    commitReservation({
      slug: "linked-staging",
      reservationId: prepared.reservationId,
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_RESERVATION",
  );

  await unlink(stagingPath);
  await rename(movedStagingPath, stagingPath);
  await releaseReservation({
    slug: "linked-staging",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects a symbolic-link staging assets directory", async (t) => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "linked-staging-assets", config });
  await writeBundle(prepared, "linked-staging-assets");
  const assetsPath = path.dirname(prepared.coverPath);
  const movedAssetsPath = path.join(config.workspaceRoot, "moved-staging-assets");
  await rename(assetsPath, movedAssetsPath);

  try {
    await createDirectoryLink(movedAssetsPath, assetsPath);
  } catch (error) {
    await rename(movedAssetsPath, assetsPath);
    await releaseReservation({
      slug: "linked-staging-assets",
      reservationId: prepared.reservationId,
      config,
    });
    if (["EACCES", "EPERM"].includes(error?.code)) {
      t.skip("Directory symbolic links are unavailable on this platform.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    commitReservation({
      slug: "linked-staging-assets",
      reservationId: prepared.reservationId,
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "INVALID_RESERVATION",
  );

  await unlink(assetsPath);
  await rename(movedAssetsPath, assetsPath);
  await releaseReservation({
    slug: "linked-staging-assets",
    reservationId: prepared.reservationId,
    config,
  });
});

test("baseline changes block commit and preserve both live and staged bundles", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "changed-post");
  await writeBundle(paths, "changed-post");
  const prepared = await prepareUpdate({ slug: "changed-post", config });
  await writeBundle(prepared, "changed-post", "replacement");
  await writeFile(paths.markdownPath, "# externally changed\n", "utf8");

  await assert.rejects(
    commitReservation({
      slug: "changed-post",
      reservationId: prepared.reservationId,
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "BASELINE_CHANGED",
  );

  assert.equal(await readFile(paths.markdownPath, "utf8"), "# externally changed\n");
  assert.match(await readFile(prepared.markdownPath, "utf8"), /replacement/);
  await releaseReservation({
    slug: "changed-post",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit atomically promotes a complete create staging bundle", async () => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "created-post", config });
  await writeBundle(prepared, "created-post", "created");

  const committed = await commitReservation({
    slug: "created-post",
    reservationId: prepared.reservationId,
    config,
  });

  assert.equal(committed.mode, "create");
  assert.deepEqual(await readBundle(committed), await readBundle(livePaths(config, "created-post")));
  assert.match((await readBundle(committed)).markdown, /created/);
  await assert.rejects(readFile(prepared.articlePath), { code: "ENOENT" });
});

test("a mid-commit failure rolls back live files and keeps staging retryable", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "rollback-post");
  await writeBundle(paths, "rollback-post", "original");
  const original = await readBundle(paths);
  const prepared = await prepareUpdate({ slug: "rollback-post", config });
  await writeBundle(prepared, "rollback-post", "replacement");

  let injected = false;
  const fileOps = {
    async rename(from, to) {
      if (!injected && to === paths.articlePath && from === prepared.articlePath) {
        injected = true;
        const error = new Error("injected failure");
        error.code = "EIO";
        throw error;
      }
      return rename(from, to);
    },
  };

  await assert.rejects(
    commitReservation({
      slug: "rollback-post",
      reservationId: prepared.reservationId,
      config,
      fileOps,
    }),
    (error) => error instanceof WorkspaceError && error.code === "COMMIT_FAILED",
  );

  const after = await readBundle(paths);
  assert.equal(after.markdown, original.markdown);
  assert.equal(after.article, original.article);
  assert.deepEqual(after.cover, original.cover);
  assert.match(await readFile(prepared.markdownPath, "utf8"), /replacement/);
  assert.match(await readFile(prepared.articlePath, "utf8"), /replacement/);

  await releaseReservation({
    slug: "rollback-post",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects an invalid cover before changing live files", async () => {
  const config = await makeWorkspace();
  const paths = livePaths(config, "bad-cover");
  await writeBundle(paths, "bad-cover", "original");
  const original = await readBundle(paths);
  const prepared = await prepareUpdate({ slug: "bad-cover", config });
  await writeBundle(prepared, "bad-cover", "replacement");
  await writeFile(prepared.coverPath, Buffer.from("not-png"));

  await assert.rejects(
    commitReservation({
      slug: "bad-cover",
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError && error.code === "STAGING_BUNDLE_INVALID",
  );
  assert.deepEqual(await readBundle(paths), original);
  await releaseReservation({
    slug: "bad-cover",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects staged markdown or JSON larger than 2 MiB", async () => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "oversized-text", config });

  for (const entryPath of [prepared.markdownPath, prepared.articlePath]) {
    await writeBundle(prepared, "oversized-text", "valid");
    await writeFile(entryPath, Buffer.alloc(TWO_MIB + 1, 0x61));
    await assert.rejects(
      commitReservation({
        slug: "oversized-text",
        reservationId: prepared.reservationId,
        config,
      }),
      (error) =>
        error instanceof WorkspaceError && error.code === "STAGING_BUNDLE_INVALID",
    );
  }

  await releaseReservation({
    slug: "oversized-text",
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects an empty or larger-than-20-MiB staged cover", async () => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "bounded-cover", config });
  const oversizedCover = Buffer.alloc(TWENTY_MIB + 1);
  PNG_1X1.copy(oversizedCover);

  for (const cover of [Buffer.alloc(0), oversizedCover]) {
    await writeBundle(prepared, "bounded-cover", "valid");
    await writeFile(prepared.coverPath, cover);
    await assert.rejects(
      commitReservation({
        slug: "bounded-cover",
        reservationId: prepared.reservationId,
        config,
      }),
      (error) =>
        error instanceof WorkspaceError && error.code === "STAGING_BUNDLE_INVALID",
    );
  }

  await releaseReservation({
    slug: "bounded-cover",
    reservationId: prepared.reservationId,
    config,
  });
});
