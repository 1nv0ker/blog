import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ContentArticleValidationError,
  MAX_IMAGE_BYTES,
  describeContentSnapshot,
  materializeContentPreviewAssets,
  materializeContentRequest,
  prepareContentSnapshot,
} from "../src/content-article.mjs";
import {
  CONTENT_TYPE_IDS,
  UnsupportedContentTypeError,
  getContentTypeDefinition,
  requireContentType,
} from "../src/content-types.mjs";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
const MP4_HEADER = Buffer.from(
  "000000186674797069736f6d0000020069736f6d",
  "hex",
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "ascii");

const textBlock = (text, overrides = {}) => ({
  _type: "block",
  style: "normal",
  markDefs: [],
  children: [{ _type: "span", text, marks: [] }],
  ...overrides,
});

function validArticle(overrides = {}) {
  return {
    title: { en: "English title", zh: "中文标题" },
    slug: "example-post",
    excerpt: { en: "English excerpt.", zh: "中文摘要。" },
    coverImage: null,
    body: {
      en: [textBlock("English content.")],
      zh: [textBlock("中文内容。")],
    },
    seo: null,
    ...overrides,
  };
}

function blogEnSeo(origin = "https://content.example.com") {
  return {
    title: { en: "English SEO title", zh: "中文 SEO 标题" },
    description: {
      en: "English SEO description.",
      zh: "中文 SEO 描述。",
    },
    canonicalUrl: {
      en: `${origin}/en/blog/example-post`,
      zh: `${origin}/zh/blog/example-post`,
    },
  };
}

async function fixture(
  contentType,
  article,
  assets = {},
  {
    publicSiteOrigin = "https://content.example.com",
    staging = false,
  } = {},
) {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "sanityblog-content-"),
  );
  const slug = article.slug;
  const articleDirectory = staging
    ? path.join(
        workspaceRoot,
        "contents",
        ".staging",
        contentType,
        randomUUID(),
        slug,
      )
    : path.join(workspaceRoot, "contents", contentType, slug);
  await mkdir(path.join(articleDirectory, "assets"), { recursive: true });
  const articlePath = path.join(articleDirectory, `${slug}.json`);
  await writeFile(articlePath, `${JSON.stringify(article)}\n`);
  for (const [filename, bytes] of Object.entries(assets)) {
    await writeFile(path.join(articleDirectory, "assets", filename), bytes);
  }
  return {
    workspaceRoot,
    articlePath,
    config: { workspaceRoot, publicSiteOrigin },
    async cleanup() {
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

describe("independent content type contract", () => {
  it("exposes exactly the six content 1.1 types as immutable definitions", () => {
    assert.deepEqual(CONTENT_TYPE_IDS, [
      "blog-en",
      "guide",
      "comparison",
      "solution",
      "alternative",
      "tutorial",
    ]);
    assert.equal(requireContentType("blog-en"), "blog-en");
    assert.equal(requireContentType("guide"), "guide");
    assert.equal(getContentTypeDefinition("blog-en").documentType, "blogEn");
    assert.equal(getContentTypeDefinition("guide").documentType, "guide");
    assert.equal(Object.isFrozen(CONTENT_TYPE_IDS), true);
    assert.equal(Object.isFrozen(getContentTypeDefinition("tutorial")), true);
    assert.throws(
      () => requireContentType("blog-post"),
      UnsupportedContentTypeError,
    );
  });
});

describe("prepareContentSnapshot", () => {
  it("accepts every rich type, optional null fields, and generates stable nested keys", async () => {
    for (const contentType of CONTENT_TYPE_IDS) {
      const body = {
        en: [
          textBlock("Heading", {
            style: "h6",
            markDefs: [
              {
                _type: "link",
                _key: "docs",
                href: "https://example.com/docs",
              },
            ],
            children: [
              {
                _type: "span",
                text: "Docs",
                marks: ["strong", "underline", "docs"],
              },
            ],
          }),
          {
            _type: "callout",
            body: [textBlock("Nested callout")],
          },
          {
            _type: "table",
            rows: [
              {
                _type: "row",
                cells: [
                  {
                    _type: "cell",
                    value: [textBlock("Cell")],
                  },
                ],
              },
            ],
          },
        ],
        zh: [textBlock("中文内容。")],
      };
      const article = validArticle({
        author: null,
        body,
        seo: contentType === "blog-en" ? blogEnSeo() : null,
      });
      const context = await fixture(contentType, article);
      try {
        const first = await prepareContentSnapshot(
          contentType,
          context.articlePath,
          { config: context.config },
        );
        const second = await prepareContentSnapshot(
          contentType,
          context.articlePath,
          { config: context.config },
        );

        assert.equal(first.contentType, contentType);
        assert.equal(first.slug, "example-post");
        assert.match(first.contentSha256, /^[0-9a-f]{64}$/u);
        assert.equal(Object.isFrozen(first), true);
        assert.equal(Object.isFrozen(first.article), true);
        assert.equal(Object.isFrozen(first.article.body.en), true);
        assert.match(first.article.body.en[1].body[0]._key, /^k_[a-f0-9]{16}$/u);
        assert.match(
          first.article.body.en[2].rows[0].cells[0].value[0]._key,
          /^k_[a-f0-9]{16}$/u,
        );
        assert.equal(
          first.article.body.en[2].rows[0]._key,
          second.article.body.en[2].rows[0]._key,
        );
        assert.equal(first.article.body.en[0].markDefs[0].openInNewTab, true);
        if (contentType === "blog-en") {
          assert.deepEqual(first.article.seo.robots, {
            index: true,
            follow: true,
          });
        } else {
          assert.equal(first.article.seo, null);
        }
      } finally {
        await context.cleanup();
      }
    }
  });

  it("accepts normal nested text and rejects blockquote text inside callouts and tables", async () => {
    const accepted = validArticle({
      body: {
        en: [
          {
            _type: "callout",
            body: [textBlock("Normal callout text")],
          },
          {
            _type: "table",
            rows: [
              {
                _type: "row",
                cells: [
                  {
                    _type: "cell",
                    value: [textBlock("Normal cell text")],
                  },
                ],
              },
            ],
          },
        ],
        zh: [textBlock("涓枃")],
      },
    });
    const acceptedContext = await fixture("guide", accepted);
    try {
      const snapshot = await prepareContentSnapshot(
        "guide",
        acceptedContext.articlePath,
        { config: acceptedContext.config },
      );
      assert.equal(snapshot.article.body.en[0].body[0].style, "normal");
      assert.equal(
        snapshot.article.body.en[1].rows[0].cells[0].value[0].style,
        "normal",
      );
    } finally {
      await acceptedContext.cleanup();
    }

    const invalidNestedBodies = [
      [
        {
          _type: "callout",
          body: [textBlock("Nested quote", { style: "blockquote" })],
        },
      ],
      [
        {
          _type: "table",
          rows: [
            {
              _type: "row",
              cells: [
                {
                  _type: "cell",
                  value: [
                    textBlock("Nested quote", { style: "blockquote" }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    ];

    for (const en of invalidNestedBodies) {
      const context = await fixture(
        "guide",
        validArticle({
          body: {
            en,
            zh: [textBlock("涓枃")],
          },
        }),
      );
      try {
        await assert.rejects(
          () =>
            prepareContentSnapshot("guide", context.articlePath, {
              config: context.config,
            }),
          (error) =>
            error instanceof ContentArticleValidationError &&
            error.code === "ARTICLE_SCHEMA_INVALID",
        );
      } finally {
        await context.cleanup();
      }
    }
  });

  it("requires blog-en SEO/canonical URLs on the configured public origin", async () => {
    const scenarios = [
      validArticle({ seo: null }),
      validArticle({
        seo: {
          ...blogEnSeo(),
          canonicalUrl: undefined,
        },
      }),
      validArticle({
        seo: blogEnSeo("https://other.example.com"),
      }),
    ];
    for (const article of scenarios) {
      const context = await fixture("blog-en", article);
      try {
        await assert.rejects(
          () =>
            prepareContentSnapshot("blog-en", context.articlePath, {
              config: context.config,
            }),
          (error) =>
            error instanceof ContentArticleValidationError &&
            error.code === "ARTICLE_SCHEMA_INVALID",
        );
      } finally {
        await context.cleanup();
      }
    }
  });

  it("rejects unsafe links, malformed tables, and non-canonical article paths", async () => {
    const badLink = validArticle();
    badLink.body.en[0].markDefs = [
      {
        _type: "link",
        _key: "bad",
        href: "javascript:alert(1)",
      },
    ];
    badLink.body.en[0].children[0].marks = ["bad"];
    const linkContext = await fixture("guide", badLink);
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", linkContext.articlePath, {
            config: linkContext.config,
          }),
        ContentArticleValidationError,
      );
    } finally {
      await linkContext.cleanup();
    }

    const badTable = validArticle({
      body: {
        en: [
          {
            _type: "table",
            rows: [
              {
                _type: "row",
                cells: [
                  { _type: "cell", value: [textBlock("A")] },
                  { _type: "cell", value: [textBlock("B")] },
                ],
              },
              {
                _type: "row",
                cells: [{ _type: "cell", value: [textBlock("C")] }],
              },
            ],
          },
        ],
        zh: [textBlock("中文")],
      },
    });
    const tableContext = await fixture("comparison", badTable);
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("comparison", tableContext.articlePath, {
            config: tableContext.config,
          }),
        ContentArticleValidationError,
      );
    } finally {
      await tableContext.cleanup();
    }

    const pathContext = await fixture("guide", validArticle());
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("tutorial", pathContext.articlePath, {
            config: pathContext.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ARTICLE_LOCATION_INVALID",
      );
    } finally {
      await pathContext.cleanup();
    }
  });

  it("accepts exact UUID v4 staging paths and rejects staging under another type", async () => {
    const staged = await fixture("tutorial", validArticle(), {}, {
      staging: true,
    });
    try {
      const snapshot = await prepareContentSnapshot(
        "tutorial",
        staged.articlePath,
        { config: staged.config },
      );
      assert.equal(snapshot.contentType, "tutorial");
      assert.equal(snapshot.slug, "example-post");
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", staged.articlePath, {
            config: staged.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ARTICLE_LOCATION_INVALID",
      );
    } finally {
      await staged.cleanup();
    }
  });

  it("recursively snapshots and deduplicates image, video, attachment, poster, and OG assets", async () => {
    const article = validArticle({
      coverImage: {
        source: { path: "./assets/shared.png" },
        alt: { en: "Cover", zh: "封面" },
      },
      body: {
        en: [
          {
            _type: "image",
            source: { path: "./assets/shared.png" },
            alt: "Image",
          },
          {
            _type: "video",
            sourceType: "upload",
            source: { path: "./assets/demo.mp4" },
            title: "Demo",
            poster: {
              source: { path: "./assets/shared.png" },
              alt: "Poster",
            },
          },
          {
            _type: "attachment",
            source: { path: "./assets/handbook.pdf" },
            title: "Handbook",
          },
        ],
        zh: [textBlock("中文")],
      },
      seo: {
        title: { en: "SEO", zh: "SEO 中文" },
        description: { en: "Description", zh: "中文描述" },
        openGraph: {
          image: {
            source: { path: "./assets/shared.png" },
            alt: { en: "Open Graph", zh: "开放图谱" },
          },
        },
      },
    });
    const context = await fixture(
      "guide",
      article,
      {
        "shared.png": PNG_1X1,
        "demo.mp4": MP4_HEADER,
        "handbook.pdf": PDF,
      },
    );
    try {
      const snapshot = await prepareContentSnapshot(
        "guide",
        context.articlePath,
        { config: context.config },
      );
      assert.equal(snapshot.localAssetCount, 3);
      assert.deepEqual(snapshot.assetCounts, {
        image: 1,
        video: 1,
        attachment: 1,
      });

      const previewAssets = materializeContentPreviewAssets(snapshot);
      assert.deepEqual(
        previewAssets.map(({ kind, sourcePath, mimeType }) => ({
          kind,
          sourcePath,
          mimeType,
        })),
        [
          {
            kind: "image",
            sourcePath: "./assets/shared.png",
            mimeType: "image/png",
          },
          {
            kind: "video",
            sourcePath: "./assets/demo.mp4",
            mimeType: "video/mp4",
          },
          {
            kind: "attachment",
            sourcePath: "./assets/handbook.pdf",
            mimeType: "application/pdf",
          },
        ],
      );
      previewAssets[0].bytes[0] = 0;
      assert.equal(
        materializeContentPreviewAssets(snapshot)[0].bytes[0],
        PNG_1X1[0],
      );

      const request = materializeContentRequest(snapshot);
      assert.equal(request.body instanceof FormData, true);
      assert.deepEqual(
        [...request.body.entries()].map(([name, value]) => [
          name,
          value.name,
          value.type,
        ]),
        [
          ["article", "example-post.json", "application/json"],
          ["assets", "shared.png", "image/png"],
          ["assets", "demo.mp4", "video/mp4"],
          ["assets", "handbook.pdf", "application/pdf"],
        ],
      );
      assert.deepEqual(describeContentSnapshot(snapshot).assetCounts, {
        image: 1,
        video: 1,
        attachment: 1,
      });
    } finally {
      await context.cleanup();
    }
  });

  it("accepts ten unique local assets and rejects an eleventh before materialization", async () => {
    const images = Array.from({ length: 11 }, (_, index) => ({
      _type: "image",
      source: { path: `./assets/image-${index}.png` },
      alt: `Image ${index}`,
    }));
    const assetFiles = Object.fromEntries(
      images.map((_, index) => [`image-${index}.png`, PNG_1X1]),
    );

    const accepted = await fixture(
      "guide",
      validArticle({
        body: {
          en: images.slice(0, 10),
          zh: [textBlock("中文")],
        },
      }),
      Object.fromEntries(Object.entries(assetFiles).slice(0, 10)),
    );
    try {
      const snapshot = await prepareContentSnapshot(
        "guide",
        accepted.articlePath,
        { config: accepted.config },
      );
      assert.equal(snapshot.localAssetCount, 10);
    } finally {
      await accepted.cleanup();
    }

    const rejected = await fixture(
      "guide",
      validArticle({
        body: {
          en: images,
          zh: [textBlock("中文")],
        },
      }),
      assetFiles,
    );
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", rejected.articlePath, {
            config: rejected.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ASSET_COUNT_EXCEEDED",
      );
    } finally {
      await rejected.cleanup();
    }
  });

  it("rejects asset filenames that collide case-insensitively", async (t) => {
    if (process.platform === "win32") {
      t.skip("A case-sensitive asset fixture is unavailable on Windows.");
      return;
    }
    const context = await fixture(
      "guide",
      validArticle({
        body: {
          en: [
            {
              _type: "image",
              source: { path: "./assets/Hero.png" },
              alt: "Hero",
            },
            {
              _type: "image",
              source: { path: "./assets/hero.png" },
              alt: "Second hero",
            },
          ],
          zh: [textBlock("中文")],
        },
      }),
      {
        "Hero.png": PNG_1X1,
        "hero.png": PNG_1X1,
      },
    );
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", context.articlePath, {
            config: context.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ASSET_FILENAME_CONFLICT",
      );
    } finally {
      await context.cleanup();
    }
  });

  it("rejects disguised assets and per-kind size overflow before reading content", async () => {
    const disguised = validArticle({
      body: {
        en: [
          {
            _type: "image",
            source: { path: "./assets/fake.png" },
            alt: "Fake",
          },
        ],
        zh: [textBlock("中文")],
      },
    });
    const disguisedContext = await fixture("guide", disguised, {
      "fake.png": Buffer.from("not a png"),
    });
    try {
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", disguisedContext.articlePath, {
            config: disguisedContext.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ASSET_FORMAT_INVALID",
      );
    } finally {
      await disguisedContext.cleanup();
    }

    const oversized = validArticle({
      body: {
        en: [
          {
            _type: "image",
            source: { path: "./assets/huge.png" },
            alt: "Huge",
          },
        ],
        zh: [textBlock("中文")],
      },
    });
    const oversizedContext = await fixture("guide", oversized, {
      "huge.png": PNG_1X1,
    });
    try {
      await truncate(
        path.join(
          path.dirname(oversizedContext.articlePath),
          "assets",
          "huge.png",
        ),
        MAX_IMAGE_BYTES + 1,
      );
      await assert.rejects(
        () =>
          prepareContentSnapshot("guide", oversizedContext.articlePath, {
            config: oversizedContext.config,
          }),
        (error) =>
          error instanceof ContentArticleValidationError &&
          error.code === "ASSET_SIZE_INVALID",
      );
    } finally {
      await oversizedContext.cleanup();
    }
  });
});

describe("materializeContentRequest", () => {
  it("uses exact JSON without assets and applies a normalized create timestamp on demand", async () => {
    const sourceArticle = validArticle();
    const context = await fixture("solution", sourceArticle);
    try {
      const snapshot = await prepareContentSnapshot(
        "solution",
        context.articlePath,
        { config: context.config },
      );
      const exact = materializeContentRequest(snapshot);
      assert.deepEqual(exact.headers, {
        "Content-Type": "application/json",
      });
      assert.equal(
        exact.body.toString("utf8"),
        `${JSON.stringify(sourceArticle)}\n`,
      );

      const created = materializeContentRequest(snapshot, {
        createPublishedAt: "2026-07-31T08:00:00+08:00",
      });
      assert.equal(
        JSON.parse(created.body.toString("utf8")).publishedAt,
        "2026-07-31T00:00:00.000Z",
      );
      assert.equal(Object.isFrozen(created.article), true);
      assert.throws(
        () =>
          materializeContentRequest(snapshot, {
            createPublishedAt: "2026-07-31",
          }),
        ContentArticleValidationError,
      );
      assert.throws(
        () => materializeContentRequest({ ...snapshot }),
        ContentArticleValidationError,
      );
    } finally {
      await context.cleanup();
    }
  });
});
