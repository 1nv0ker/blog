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
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
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

function assetPath(paths, filename) {
  return path.join(path.dirname(paths.coverPath), filename);
}

function articleWithLocalImages(
  slug,
  {
    bodyEn = [],
    bodyZh = bodyEn,
    openGraphImage,
    coverImage = `${slug}-cover.png`,
    marker = "article",
  } = {},
) {
  const image = (filename, locale) => ({
    _type: "image",
    source: { path: `./assets/${filename}` },
    alt: `${locale} ${filename}`,
  });
  return {
    slug,
    title: marker,
    coverImage: {
      source: { path: `./assets/${coverImage}` },
      alt: { en: "Cover", zh: "封面" },
    },
    body: {
      en: bodyEn.map((filename) => image(filename, "English")),
      zh: bodyZh.map((filename) => image(filename, "Chinese")),
    },
    ...(openGraphImage
      ? {
          seo: {
            openGraph: {
              image: {
                source: { path: `./assets/${openGraphImage}` },
                alt: { en: "Social image", zh: "社交图片" },
              },
            },
          },
        }
      : {}),
  };
}

async function writeArticleAndAssets(
  paths,
  slug,
  article,
  { marker = "article", assets = {} } = {},
) {
  await writeBundle(paths, slug, marker);
  await writeFile(paths.articlePath, `${JSON.stringify(article, null, 2)}\n`, "utf8");
  await Promise.all(
    Object.entries(assets).map(([filename, bytes]) =>
      writeFile(assetPath(paths, filename), bytes),
    ),
  );
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

test("prepare update snapshots each referenced local image once and preserves its public shape", async () => {
  const config = await makeWorkspace();
  const slug = "media-post";
  const paths = livePaths(config, slug);
  const diagram = `${slug}-diagram.png`;
  const social = `${slug}-social.png`;
  const article = articleWithLocalImages(slug, {
    bodyEn: [diagram],
    bodyZh: [diagram],
    openGraphImage: social,
  });
  await writeArticleAndAssets(paths, slug, article, {
    assets: {
      [diagram]: PNG_1X1,
      [social]: Buffer.concat([PNG_1X1, Buffer.from("social")]),
    },
  });
  const unrelated = assetPath(paths, "another-post-diagram.png");
  await writeFile(unrelated, Buffer.from("unrelated"));

  const prepared = await prepareUpdate({ slug, config });

  assert.deepEqual(Object.keys(prepared).sort(), [
    "articlePath",
    "coverPath",
    "markdownPath",
    "mode",
    "reservationId",
    "slug",
  ]);
  assert.deepEqual(await readFile(assetPath(prepared, diagram)), PNG_1X1);
  assert.deepEqual(
    await readFile(assetPath(prepared, social)),
    Buffer.concat([PNG_1X1, Buffer.from("social")]),
  );
  await assert.rejects(readFile(assetPath(prepared, "another-post-diagram.png")), {
    code: "ENOENT",
  });

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("prepare and commit recursively preserve referenced image, video, and attachment assets", async () => {
  const config = await makeWorkspace();
  const slug = "mixed-workspace-assets";
  const paths = livePaths(config, slug);
  const video = `${slug}-demo.mp4`;
  const sharedImage = `${slug}-shared.png`;
  const attachment = `${slug}-guide.pdf`;
  const block = (text) => ({
    _type: "block",
    children: [{ _type: "span", text }],
  });
  const article = {
    slug,
    title: "Mixed assets",
    coverImage: {
      source: { path: `./assets/${slug}-cover.png` },
      alt: { en: "Cover", zh: "封面" },
    },
    body: {
      en: [
        {
          _type: "video",
          sourceType: "upload",
          source: { path: `./assets/${video}` },
          poster: {
            source: { path: `./assets/${sharedImage}` },
            alt: "Poster",
          },
        },
        {
          _type: "attachment",
          source: { path: `./assets/${attachment}` },
        },
        {
          _type: "tutorialSteps",
          steps: [
            {
              image: {
                source: { path: `./assets/${sharedImage}` },
                alt: "Step",
              },
              body: [block("Step body")],
            },
          ],
        },
      ],
      zh: [],
    },
  };
  await writeArticleAndAssets(paths, slug, article, {
    assets: {
      [video]: MP4_BYTES,
      [sharedImage]: PNG_1X1,
      [attachment]: PDF_BYTES,
    },
  });

  const prepared = await prepareUpdate({ slug, config });
  assert.deepEqual(await readFile(assetPath(prepared, video)), MP4_BYTES);
  assert.deepEqual(await readFile(assetPath(prepared, sharedImage)), PNG_1X1);
  assert.deepEqual(await readFile(assetPath(prepared, attachment)), PDF_BYTES);

  const committed = await commitReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
  assert.deepEqual(await readFile(assetPath(committed, video)), MP4_BYTES);
  assert.deepEqual(await readFile(assetPath(committed, attachment)), PDF_BYTES);
});

test("a referenced image byte change invalidates the reserved baseline", async () => {
  const config = await makeWorkspace();
  const slug = "asset-baseline";
  const paths = livePaths(config, slug);
  const diagram = `${slug}-diagram.png`;
  const article = articleWithLocalImages(slug, { bodyEn: [diagram] });
  await writeArticleAndAssets(paths, slug, article, {
    assets: { [diagram]: PNG_1X1 },
  });
  const prepared = await prepareUpdate({ slug, config });
  await writeFile(
    assetPath(paths, diagram),
    Buffer.concat([PNG_1X1, Buffer.from("externally changed")]),
  );

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "BASELINE_CHANGED",
  );
  assert.deepEqual(await readFile(assetPath(prepared, diagram)), PNG_1X1);

  await releaseReservation({
    slug,
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

test("commit rejects unsafe, unsupported, case-ambiguous, and excessive local image references", async () => {
  const config = await makeWorkspace();
  const slug = "asset-policy";
  const prepared = await preparePublish({ baseSlug: slug, config });
  await writeBundle(prepared, slug);

  const invalidArticles = [
    {
      ...articleWithLocalImages(slug),
      body: {
        en: [
          {
            _type: "image",
            source: { path: "./assets/nested/image.png" },
            alt: "Nested",
          },
        ],
        zh: [],
      },
    },
    articleWithLocalImages(slug, { bodyEn: [`${slug}-diagram.svg`] }),
    articleWithLocalImages(slug, {
      bodyEn: [`${slug}-diagram.png`, `${slug}-DIAGRAM.png`],
    }),
    articleWithLocalImages(slug, {
      bodyEn: Array.from(
        { length: 10 },
        (_, index) => `${slug}-body-${index}.png`,
      ),
    }),
  ];

  for (const article of invalidArticles) {
    await writeFile(
      prepared.articlePath,
      `${JSON.stringify(article, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      commitReservation({
        slug,
        reservationId: prepared.reservationId,
        config,
      }),
      (error) =>
        error instanceof WorkspaceError &&
        error.code === "STAGING_BUNDLE_INVALID",
    );
  }

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("fixed bundle cover does not consume the ten-image JSON limit when cover uses assetRef", async () => {
  const config = await makeWorkspace();
  const slug = "remote-cover-limit";
  const prepared = await preparePublish({ baseSlug: slug, config });
  const bodyImages = Array.from(
    { length: 10 },
    (_, index) => `${slug}-body-${index}.png`,
  );
  const article = articleWithLocalImages(slug, {
    bodyEn: bodyImages,
    bodyZh: [],
  });
  article.coverImage.source = {
    assetRef: "image-existing-1200x630-webp",
  };
  await writeArticleAndAssets(prepared, slug, article, {
    assets: Object.fromEntries(
      bodyImages.map((filename, index) => [
        filename,
        Buffer.concat([PNG_1X1, Buffer.from(String(index))]),
      ]),
    ),
  });

  const committed = await commitReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });

  assert.equal(JSON.parse(await readFile(committed.articlePath, "utf8")).slug, slug);
  for (const filename of bodyImages) {
    assert.equal((await stat(assetPath(committed, filename))).isFile(), true);
  }
  assert.equal((await stat(committed.coverPath)).isFile(), true);
});

test("commit rejects referenced local images that are not ordinary files", async () => {
  const config = await makeWorkspace();
  const slug = "ordinary-assets";
  const prepared = await preparePublish({ baseSlug: slug, config });
  const diagram = `${slug}-diagram.png`;
  await writeArticleAndAssets(
    prepared,
    slug,
    articleWithLocalImages(slug, { bodyEn: [diagram] }),
  );
  await mkdir(assetPath(prepared, diagram));

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError && error.code === "UNSAFE_WORKSPACE_ENTRY",
  );

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects body and Open Graph images whose bytes disguise their extension", async () => {
  const config = await makeWorkspace();
  const slug = "disguised-images";
  const prepared = await preparePublish({ baseSlug: slug, config });
  const bodyImage = `${slug}-body.png`;
  const socialImage = `${slug}-social.jpg`;
  const article = articleWithLocalImages(slug, {
    bodyEn: [bodyImage],
    openGraphImage: socialImage,
  });
  await writeArticleAndAssets(prepared, slug, article, {
    assets: {
      [bodyImage]: Buffer.from("not a PNG"),
      [socialImage]: PNG_1X1,
    },
  });

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError &&
      error.code === "STAGING_BUNDLE_INVALID" &&
      /bytes do not match the extension/u.test(error.message),
  );

  await writeFile(assetPath(prepared, bodyImage), PNG_1X1);
  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError &&
      error.code === "STAGING_BUNDLE_INVALID" &&
      /bytes do not match the extension/u.test(error.message),
  );

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit rejects a referenced local image symbolic link", async (t) => {
  const config = await makeWorkspace();
  const slug = "linked-image";
  const prepared = await preparePublish({ baseSlug: slug, config });
  const diagram = `${slug}-diagram.png`;
  await writeArticleAndAssets(
    prepared,
    slug,
    articleWithLocalImages(slug, { bodyEn: [diagram] }),
  );
  const target = path.join(config.workspaceRoot, "linked-image-target.png");
  await writeFile(target, PNG_1X1);
  try {
    await symlink(target, assetPath(prepared, diagram), "file");
  } catch (error) {
    await releaseReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    });
    if (["EACCES", "EPERM"].includes(error?.code)) {
      t.skip("File symbolic links are unavailable on this platform.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError && error.code === "UNSAFE_WORKSPACE_ENTRY",
  );

  await releaseReservation({
    slug,
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

test("update atomically adds, replaces, and removes referenced images without touching unrelated assets", async () => {
  const config = await makeWorkspace();
  const slug = "asset-update";
  const paths = livePaths(config, slug);
  const kept = `${slug}-kept.png`;
  const removed = `${slug}-removed.png`;
  const added = `${slug}-added.png`;
  const oldArticle = articleWithLocalImages(slug, {
    bodyEn: [kept, removed],
    bodyZh: [kept],
  });
  await writeArticleAndAssets(paths, slug, oldArticle, {
    assets: {
      [kept]: Buffer.concat([PNG_1X1, Buffer.from("old kept")]),
      [removed]: Buffer.concat([PNG_1X1, Buffer.from("remove me")]),
    },
  });
  const unrelated = assetPath(paths, "other-post-private.png");
  await writeFile(unrelated, Buffer.from("leave me alone"));

  const prepared = await prepareUpdate({ slug, config });
  const nextArticle = articleWithLocalImages(slug, {
    bodyEn: [kept, added],
    bodyZh: [kept, added],
    openGraphImage: added,
  });
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify(nextArticle, null, 2)}\n`,
    "utf8",
  );
  const nextKept = Buffer.concat([PNG_1X1, Buffer.from("new kept")]);
  const nextAdded = Buffer.concat([PNG_1X1, Buffer.from("new added")]);
  await writeFile(assetPath(prepared, kept), nextKept);
  await writeFile(assetPath(prepared, added), nextAdded);

  const committed = await commitReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });

  assert.deepEqual(await readFile(assetPath(committed, kept)), nextKept);
  assert.deepEqual(await readFile(assetPath(committed, added)), nextAdded);
  await assert.rejects(readFile(assetPath(committed, removed)), { code: "ENOENT" });
  assert.equal(await readFile(unrelated, "utf8"), "leave me alone");
  assert.deepEqual(JSON.parse(await readFile(committed.articlePath, "utf8")), nextArticle);
});

test("a new referenced image cannot overwrite an untracked live file", async () => {
  const config = await makeWorkspace();
  const slug = "asset-collision";
  const paths = livePaths(config, slug);
  await writeBundle(paths, slug, "original");
  const colliding = `${slug}-diagram.png`;
  const collisionPath = assetPath(paths, colliding);
  await writeFile(collisionPath, Buffer.from("untracked owner"));
  const prepared = await prepareUpdate({ slug, config });
  const article = articleWithLocalImages(slug, { bodyEn: [colliding] });
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify(article, null, 2)}\n`,
    "utf8",
  );
  await writeFile(assetPath(prepared, colliding), PNG_1X1);

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) => error instanceof WorkspaceError && error.code === "BASELINE_CHANGED",
  );
  assert.equal(await readFile(collisionPath, "utf8"), "untracked owner");

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("overlapping slug prefixes cannot claim an image referenced by another article", async () => {
  const config = await makeWorkspace();
  const currentSlug = "post";
  const otherSlug = "post-two";
  const currentPaths = livePaths(config, currentSlug);
  const otherPaths = livePaths(config, otherSlug);
  const otherDiagram = `${otherSlug}-diagram.png`;
  await writeBundle(currentPaths, currentSlug, "current");
  await writeArticleAndAssets(
    otherPaths,
    otherSlug,
    articleWithLocalImages(otherSlug, { bodyEn: [otherDiagram] }),
    { assets: { [otherDiagram]: PNG_1X1 } },
  );
  const originalOtherDiagram = await readFile(assetPath(otherPaths, otherDiagram));

  const prepared = await prepareUpdate({ slug: currentSlug, config });
  const stealingArticle = articleWithLocalImages(currentSlug, {
    bodyEn: [otherDiagram],
  });
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify(stealingArticle, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    assetPath(prepared, otherDiagram),
    Buffer.concat([PNG_1X1, Buffer.from("replacement")]),
  );

  await assert.rejects(
    commitReservation({
      slug: currentSlug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError &&
      error.code === "ASSET_OWNERSHIP_CONFLICT",
  );
  assert.deepEqual(
    await readFile(assetPath(otherPaths, otherDiagram)),
    originalOtherDiagram,
  );

  await releaseReservation({
    slug: currentSlug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("shared asset commits refuse to run while another asset transaction holds the lock", async () => {
  const config = await makeWorkspace();
  const slug = "asset-lock";
  const prepared = await preparePublish({ baseSlug: slug, config });
  await writeBundle(prepared, slug);
  const transactionLock = path.join(
    config.workspaceRoot,
    "blog",
    ".reservations",
    ".asset-transaction",
  );
  await mkdir(transactionLock);

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
    }),
    (error) =>
      error instanceof WorkspaceError &&
      error.code === "ASSET_TRANSACTION_CONFLICT",
  );

  await rm(transactionLock, { recursive: true });
  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("commit cleanup failure reports a trustworthy committed receipt", async () => {
  const config = await makeWorkspace();
  const prepared = await preparePublish({ baseSlug: "cleanup-warning", config });
  await writeBundle(prepared, "cleanup-warning", "committed");
  const destination = livePaths(config, "cleanup-warning");

  await assert.rejects(
    commitReservation({
      slug: "cleanup-warning",
      reservationId: prepared.reservationId,
      config,
      cleanupOps: {
        async rm() {
          throw new Error("injected cleanup failure");
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof WorkspaceError, true);
      assert.equal(error.code, "COMMIT_CLEANUP_FAILED");
      assert.deepEqual(error.details, {
        committed: true,
        slug: "cleanup-warning",
        reservationId: prepared.reservationId,
        mode: "create",
        ...destination,
      });
      return true;
    },
  );

  assert.match((await readBundle(destination)).markdown, /committed/);
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

test("a failed asset-set update restores removed images and keeps new images staged", async () => {
  const config = await makeWorkspace();
  const slug = "asset-rollback";
  const paths = livePaths(config, slug);
  const kept = `${slug}-kept.png`;
  const removed = `${slug}-removed.png`;
  const added = `${slug}-added.png`;
  const originalKept = Buffer.concat([PNG_1X1, Buffer.from("original kept")]);
  const originalRemoved = Buffer.concat([PNG_1X1, Buffer.from("original removed")]);
  const oldArticle = articleWithLocalImages(slug, {
    bodyEn: [kept, removed],
  });
  await writeArticleAndAssets(paths, slug, oldArticle, {
    marker: "original",
    assets: {
      [kept]: originalKept,
      [removed]: originalRemoved,
    },
  });
  const original = await readBundle(paths);
  const prepared = await prepareUpdate({ slug, config });
  const nextArticle = articleWithLocalImages(slug, {
    bodyEn: [kept, added],
    marker: "replacement",
  });
  await writeFile(prepared.markdownPath, "# replacement\n", "utf8");
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify(nextArticle, null, 2)}\n`,
    "utf8",
  );
  const nextKept = Buffer.concat([PNG_1X1, Buffer.from("next kept")]);
  const nextAdded = Buffer.concat([PNG_1X1, Buffer.from("next added")]);
  await writeFile(assetPath(prepared, kept), nextKept);
  await writeFile(assetPath(prepared, added), nextAdded);

  const fileOps = {
    async rename(from, to) {
      if (from === assetPath(prepared, added) && to === assetPath(paths, added)) {
        const error = new Error("injected asset move failure");
        error.code = "EIO";
        throw error;
      }
      return rename(from, to);
    },
  };

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
      fileOps,
    }),
    (error) => error instanceof WorkspaceError && error.code === "COMMIT_FAILED",
  );

  assert.deepEqual(await readBundle(paths), original);
  assert.deepEqual(await readFile(assetPath(paths, kept)), originalKept);
  assert.deepEqual(await readFile(assetPath(paths, removed)), originalRemoved);
  await assert.rejects(readFile(assetPath(paths, added)), { code: "ENOENT" });
  assert.equal(await readFile(prepared.markdownPath, "utf8"), "# replacement\n");
  assert.deepEqual(await readFile(assetPath(prepared, kept)), nextKept);
  assert.deepEqual(await readFile(assetPath(prepared, added)), nextAdded);

  await releaseReservation({
    slug,
    reservationId: prepared.reservationId,
    config,
  });
});

test("post-move digest verification rolls back a staged image swapped after validation", async () => {
  const config = await makeWorkspace();
  const slug = "swap-rollback";
  const paths = livePaths(config, slug);
  const diagram = `${slug}-diagram.png`;
  const originalDiagram = Buffer.concat([PNG_1X1, Buffer.from("original")]);
  const article = articleWithLocalImages(slug, { bodyEn: [diagram] });
  await writeArticleAndAssets(paths, slug, article, {
    marker: "original",
    assets: { [diagram]: originalDiagram },
  });
  const originalBundle = await readBundle(paths);
  const prepared = await prepareUpdate({ slug, config });
  await writeFile(prepared.markdownPath, "# replacement\n", "utf8");
  await writeFile(
    prepared.articlePath,
    `${JSON.stringify(articleWithLocalImages(slug, {
      bodyEn: [diagram],
      marker: "replacement",
    }), null, 2)}\n`,
    "utf8",
  );
  const validatedDiagram = Buffer.concat([PNG_1X1, Buffer.from("validated")]);
  const swappedDiagram = Buffer.concat([PNG_1X1, Buffer.from("swapped")]);
  await writeFile(assetPath(prepared, diagram), validatedDiagram);

  let injected = false;
  const fileOps = {
    async rename(from, to) {
      if (
        !injected &&
        from === assetPath(prepared, diagram) &&
        to === assetPath(paths, diagram)
      ) {
        injected = true;
        await writeFile(from, swappedDiagram);
      }
      return rename(from, to);
    },
  };

  await assert.rejects(
    commitReservation({
      slug,
      reservationId: prepared.reservationId,
      config,
      fileOps,
    }),
    (error) => error instanceof WorkspaceError && error.code === "COMMIT_FAILED",
  );

  assert.deepEqual(await readBundle(paths), originalBundle);
  assert.deepEqual(await readFile(assetPath(paths, diagram)), originalDiagram);
  assert.deepEqual(await readFile(assetPath(prepared, diagram)), swappedDiagram);

  await releaseReservation({
    slug,
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
