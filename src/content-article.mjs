import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z, ZodError } from "zod";

import { DEFAULT_PUBLIC_SITE_ORIGIN } from "./constants.mjs";
import {
  getContentTypeDefinition,
  requireContentType,
} from "./content-types.mjs";

export const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_ASSETS = 10;
export const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;

const SAFE_LOCAL_ASSET_PATH =
  /^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_KEY = /^[A-Za-z0-9_-]+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const snapshotState = new WeakMap();

const ASSET_FORMATS = new Map([
  [".jpg", { kind: "image", format: "jpeg", mimeType: "image/jpeg" }],
  [".jpeg", { kind: "image", format: "jpeg", mimeType: "image/jpeg" }],
  [".png", { kind: "image", format: "png", mimeType: "image/png" }],
  [".gif", { kind: "image", format: "gif", mimeType: "image/gif" }],
  [".webp", { kind: "image", format: "webp", mimeType: "image/webp" }],
  [".avif", { kind: "image", format: "avif", mimeType: "image/avif" }],
  [".mp4", { kind: "video", format: "mp4", mimeType: "video/mp4" }],
  [".webm", { kind: "video", format: "webm", mimeType: "video/webm" }],
  [
    ".pdf",
    { kind: "attachment", format: "pdf", mimeType: "application/pdf" },
  ],
  [".txt", { kind: "attachment", format: "txt", mimeType: "text/plain" }],
  [".csv", { kind: "attachment", format: "csv", mimeType: "text/csv" }],
  [
    ".docx",
    {
      kind: "attachment",
      format: "docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  [
    ".xlsx",
    {
      kind: "attachment",
      format: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  [
    ".pptx",
    {
      kind: "attachment",
      format: "pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ],
]);

const ASSET_LIMITS = Object.freeze({
  image: MAX_IMAGE_BYTES,
  video: MAX_VIDEO_BYTES,
  attachment: MAX_ATTACHMENT_BYTES,
});

export class ContentArticleValidationError extends Error {
  constructor(code, message, details, options) {
    super(message, options);
    this.name = "ContentArticleValidationError";
    this.category = "validation";
    this.code = code;
    this.retryable = false;
    this.resultUnknown = false;
    if (details !== undefined) {
      this.details = details;
      if (Array.isArray(details.issues)) this.issues = details.issues;
    }
  }
}

export { ContentArticleValidationError as ArticleValidationError };

function validationError(code, message, details, cause) {
  return new ContentArticleValidationError(
    code,
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

const nonEmptyString = (label, max) => {
  let schema = z
    .string({ required_error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`);
  if (max !== undefined) {
    schema = schema.max(max, `${label} cannot exceed ${max} characters.`);
  }
  return schema;
};

const optionalNonEmptyString = (label, max) =>
  nonEmptyString(label, max).optional();

const keySchema = z.string().min(1).max(128).regex(SAFE_KEY).optional();

const localizedStringSchema = z
  .object({
    en: nonEmptyString("English content"),
    zh: nonEmptyString("Chinese content"),
  })
  .strict();

const excerptSchema = z
  .object({
    en: nonEmptyString("English excerpt", 240),
    zh: nonEmptyString("Chinese excerpt", 240),
  })
  .strict();

const seoDescriptionSchema = z
  .object({
    en: nonEmptyString("English SEO description", 180),
    zh: nonEmptyString("Chinese SEO description", 180),
  })
  .strict();

const localPathSchema = nonEmptyString("Asset path").regex(
  SAFE_LOCAL_ASSET_PATH,
  "Local assets must use ./assets/<safe filename>.",
);

const imageAssetRefSchema = nonEmptyString("Image assetRef").regex(
  /^image-[A-Za-z0-9]+-\d+x\d+-(?:jpg|jpeg|png|gif|webp|avif)$/iu,
  "assetRef must reference a supported Sanity image asset.",
);

const videoAssetRefSchema = nonEmptyString("Video assetRef").regex(
  /^file-[A-Za-z0-9]+-(?:mp4|webm)$/iu,
  "Video assetRef must reference an MP4 or WebM Sanity file asset.",
);

const attachmentAssetRefSchema = nonEmptyString("Attachment assetRef").regex(
  /^file-[A-Za-z0-9]+-(?:pdf|txt|csv|docx|xlsx|pptx)$/iu,
  "Attachment assetRef must reference a supported document Sanity file asset.",
);

const imageSourceSchema = z.union([
  z.object({ path: localPathSchema }).strict(),
  z.object({ assetRef: imageAssetRefSchema }).strict(),
]);

const videoSourceSchema = z.union([
  z.object({ path: localPathSchema }).strict(),
  z.object({ assetRef: videoAssetRefSchema }).strict(),
]);

const attachmentSourceSchema = z.union([
  z.object({ path: localPathSchema }).strict(),
  z.object({ assetRef: attachmentAssetRefSchema }).strict(),
]);

export function isSafeContentHref(href) {
  if (typeof href !== "string" || /[\u0000-\u001f\u007f]/u.test(href)) {
    return false;
  }
  if (href.startsWith("//") || href.startsWith("\\\\")) return false;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(href);
  if (!scheme) return true;
  const protocol = scheme[1].toLowerCase();
  if (!["http", "https", "mailto", "tel"].includes(protocol)) return false;
  if (protocol === "mailto" || protocol === "tel") {
    return Boolean(href.slice(scheme[0].length).trim());
  }
  try {
    const url = new URL(href);
    return url.protocol === `${protocol}:` && Boolean(url.hostname);
  } catch {
    return false;
  }
}

const linkSchema = z
  .object({
    _type: z.literal("link"),
    _key: keySchema,
    href: nonEmptyString("Link href", 2048).refine(
      isSafeContentHref,
      "Links only support relative paths, http, https, mailto, or tel.",
    ),
    openInNewTab: z.boolean().default(true),
  })
  .strict();

const spanSchema = z
  .object({
    _type: z.literal("span"),
    _key: keySchema,
    text: z.string(),
    marks: z.array(z.string().min(1)).default([]),
  })
  .strict();

function createBlockSchema(styles) {
  return z
    .object({
      _type: z.literal("block"),
      _key: keySchema,
      style: z.enum(styles).default("normal"),
      listItem: z.enum(["bullet", "number"]).optional(),
      level: z.number().int().min(1).max(10).optional(),
      markDefs: z.array(linkSchema).default([]),
      children: z
        .array(spanSchema)
        .min(1, "A text block requires at least one span."),
    })
    .strict()
    .superRefine((block, context) => {
      if (block.level !== undefined && block.listItem === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["level"],
          message: "Only list blocks may set level.",
        });
      }
    });
}

const richBlockSchema = createBlockSchema([
  "normal",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
]);
const nestedBlockSchema = createBlockSchema(["normal"]);

const cropSchema = z
  .object({
    _type: z.literal("sanity.imageCrop").optional(),
    top: z.number().min(0).max(1),
    bottom: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
  })
  .strict();

const hotspotSchema = z
  .object({
    _type: z.literal("sanity.imageHotspot").optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
  })
  .strict();

const richBodyImageSchema = z
  .object({
    _type: z.literal("image"),
    _key: keySchema,
    source: imageSourceSchema,
    alt: nonEmptyString("Body image alt"),
    caption: optionalNonEmptyString("Body image caption", 500),
    crop: cropSchema.optional(),
    hotspot: hotspotSchema.optional(),
  })
  .strict();

const codeSchema = z
  .object({
    _type: z.literal("code"),
    _key: keySchema,
    language: nonEmptyString("Code language").default("javascript"),
    code: z.string(),
    highlightedLines: z.array(z.number().int().positive()).optional(),
  })
  .strict();

const posterSchema = z
  .object({
    source: imageSourceSchema,
    alt: nonEmptyString("Video poster alt"),
    crop: cropSchema.optional(),
    hotspot: hotspotSchema.optional(),
  })
  .strict();

const hasHostname = (hostname, allowed) =>
  hostname === allowed || hostname.endsWith(`.${allowed}`);

export function isAllowedExternalVideoUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      [
        "youtube.com",
        "youtube-nocookie.com",
        "vimeo.com",
        "bilibili.com",
        "youtu.be",
        "b23.tv",
      ].some((allowed) => hasHostname(hostname, allowed))
    ) {
      return true;
    }
    return /\.(?:mp4|webm)$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

const uploadVideoSchema = z
  .object({
    _type: z.literal("video"),
    _key: keySchema,
    sourceType: z.literal("upload"),
    source: videoSourceSchema,
    title: nonEmptyString("Video title", 240),
    caption: optionalNonEmptyString("Video caption", 500),
    poster: posterSchema.optional(),
  })
  .strict();

const externalVideoSchema = z
  .object({
    _type: z.literal("video"),
    _key: keySchema,
    sourceType: z.literal("external"),
    url: nonEmptyString("Video URL", 2048).refine(
      isAllowedExternalVideoUrl,
      "External video URL is not on the supported HTTPS allowlist.",
    ),
    title: nonEmptyString("Video title", 240),
    caption: optionalNonEmptyString("Video caption", 500),
    poster: posterSchema.optional(),
  })
  .strict();

const videoSchema = z.discriminatedUnion("sourceType", [
  uploadVideoSchema,
  externalVideoSchema,
]);

const attachmentSchema = z
  .object({
    _type: z.literal("attachment"),
    _key: keySchema,
    source: attachmentSourceSchema,
    title: nonEmptyString("Attachment title", 240),
  })
  .strict();

const calloutSchema = z
  .object({
    _type: z.literal("callout"),
    _key: keySchema,
    tone: z.enum(["info", "success", "warning", "error"]).default("info"),
    title: optionalNonEmptyString("Callout title", 240),
    body: z
      .array(nestedBlockSchema)
      .min(1, "A callout requires at least one text block."),
  })
  .strict();

const tableCellSchema = z
  .object({
    _type: z.literal("cell"),
    _key: keySchema,
    value: z
      .array(nestedBlockSchema)
      .min(1, "A table cell requires at least one text block."),
  })
  .strict();

const tableRowSchema = z
  .object({
    _type: z.literal("row"),
    _key: keySchema,
    cells: z
      .array(tableCellSchema)
      .min(1, "A table row requires at least one cell."),
  })
  .strict();

const tableSchema = z
  .object({
    _type: z.literal("table"),
    _key: keySchema,
    headerRows: z.number().int().min(0).max(1).default(1),
    rows: z.array(tableRowSchema).min(1, "A table requires at least one row."),
  })
  .strict()
  .superRefine((table, context) => {
    if (table.headerRows > table.rows.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headerRows"],
        message: "headerRows cannot exceed the number of rows.",
      });
    }
    const width = table.rows[0]?.cells.length;
    table.rows.forEach((row, index) => {
      if (row.cells.length !== width) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index, "cells"],
          message: "Every table row must contain the same number of cells.",
        });
      }
    });
  });

const richPortableTextItemSchema = z.union([
  richBlockSchema,
  richBodyImageSchema,
  codeSchema,
  videoSchema,
  attachmentSchema,
  calloutSchema,
  tableSchema,
]);

const richBodySchema = z
  .object({
    en: z
      .array(richPortableTextItemSchema)
      .min(1, "English body requires at least one content block."),
    zh: z
      .array(richPortableTextItemSchema)
      .min(1, "Chinese body requires at least one content block."),
  })
  .strict();

const authorSchema = z.union([
  z
    .object({
      id: nonEmptyString("Author ID").refine(
        (id) => !id.startsWith("drafts.") && !id.startsWith("versions."),
        "Author ID must point to a published document.",
      ),
    })
    .strict(),
  z.object({ slug: nonEmptyString("Author slug", 96) }).strict(),
]);

const coverImageSchema = z
  .object({
    source: imageSourceSchema,
    alt: localizedStringSchema,
    crop: cropSchema.optional(),
    hotspot: hotspotSchema.optional(),
  })
  .strict();

const localizedKeywordsSchema = z
  .object({
    en: z
      .array(nonEmptyString("English SEO keyword", 100))
      .min(1)
      .max(50)
      .refine(
        (values) => new Set(values).size === values.length,
        "SEO keywords must be unique.",
      ),
    zh: z
      .array(nonEmptyString("Chinese SEO keyword", 100))
      .min(1)
      .max(50)
      .refine(
        (values) => new Set(values).size === values.length,
        "SEO keywords must be unique.",
      ),
  })
  .strict();

const canonicalUrlSchema = nonEmptyString("Canonical URL", 2048).refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  },
  "Canonical URL must be an absolute HTTPS URL without credentials or a fragment.",
);

const localizedCanonicalUrlSchema = z
  .object({
    en: canonicalUrlSchema,
    zh: canonicalUrlSchema,
  })
  .strict()
  .superRefine((value, context) => {
    let englishUrl;
    let chineseUrl;
    try {
      englishUrl = new URL(value.en);
      chineseUrl = new URL(value.zh);
    } catch {
      return;
    }
    if (englishUrl.href === chineseUrl.href) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zh"],
        message: "English and Chinese canonical URLs must be different.",
      });
    }
  });

const openGraphImageSchema = z
  .object({
    source: imageSourceSchema,
    alt: localizedStringSchema,
    crop: cropSchema.optional(),
    hotspot: hotspotSchema.optional(),
  })
  .strict();

const openGraphSchema = z
  .object({
    title: localizedStringSchema.optional(),
    description: seoDescriptionSchema.optional(),
    image: openGraphImageSchema.optional(),
  })
  .strict();

const robotsSchema = z
  .object({
    index: z.boolean().default(true),
    follow: z.boolean().default(true),
  })
  .strict();

const contentSeoSchema = z
  .object({
    title: localizedStringSchema,
    description: seoDescriptionSchema,
    keywords: localizedKeywordsSchema.optional(),
    canonicalUrl: localizedCanonicalUrlSchema.optional(),
    openGraph: openGraphSchema.optional(),
    robots: robotsSchema.default({ index: true, follow: true }),
  })
  .strict();

function isStrictIsoDateTime(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

const publishedAtSchema = z
  .string()
  .trim()
  .refine(
    isStrictIsoDateTime,
    "publishedAt must be a valid ISO date-time with a time zone.",
  )
  .transform((value) => new Date(value).toISOString());

const contentArticleSchema = z
  .object({
    title: localizedStringSchema,
    slug: nonEmptyString("slug", 96).regex(
      SLUG_PATTERN,
      "slug must contain only lowercase letters, numbers, and single hyphens.",
    ),
    publishedAt: publishedAtSchema.optional(),
    author: authorSchema.nullable().optional(),
    excerpt: excerptSchema,
    coverImage: coverImageSchema.nullable().optional(),
    body: richBodySchema,
    seo: contentSeoSchema.nullable().optional(),
  })
  .strict();

const stableKey = (scope, value) => {
  const cleanValue = { ...value };
  delete cleanValue._key;
  return `k_${createHash("sha256")
    .update(`${scope}:${JSON.stringify(cleanValue)}`)
    .digest("hex")
    .slice(0, 16)}`;
};

function assignKeys(items, scope, issues) {
  const used = new Set();
  items.forEach((item, index) => {
    const key = item._key || stableKey(`${scope}.${index}`, item);
    if (used.has(key)) {
      issues.push({
        path: [...scope.split("."), index, "_key"],
        message: `_key "${key}" is duplicated.`,
      });
    }
    used.add(key);
    item._key = key;
  });
}

function normalizeBlocks(items, scope, issues) {
  assignKeys(items, scope, issues);
  const decorators = new Set([
    "strong",
    "em",
    "underline",
    "strike-through",
    "code",
  ]);
  items.forEach((block, blockIndex) => {
    const blockScope = `${scope}.${blockIndex}`;
    assignKeys(block.markDefs, `${blockScope}.markDefs`, issues);
    assignKeys(block.children, `${blockScope}.children`, issues);
    const annotationKeys = new Set(
      block.markDefs.map((definition) => definition._key),
    );
    block.children.forEach((span, spanIndex) => {
      span.marks.forEach((mark, markIndex) => {
        if (!decorators.has(mark) && !annotationKeys.has(mark)) {
          issues.push({
            path: [
              ...scope.split("."),
              blockIndex,
              "children",
              spanIndex,
              "marks",
              markIndex,
            ],
            message: `mark "${mark}" has no matching link markDef.`,
          });
        }
      });
    });
  });
}

function normalizePortableText(items, locale, issues) {
  const scope = `body.${locale}`;
  assignKeys(items, scope, issues);
  const decorators = new Set([
    "strong",
    "em",
    "underline",
    "strike-through",
    "code",
  ]);

  items.forEach((item, itemIndex) => {
    const itemScope = `${scope}.${itemIndex}`;
    if (item._type === "block") {
      assignKeys(item.markDefs, `${itemScope}.markDefs`, issues);
      assignKeys(item.children, `${itemScope}.children`, issues);
      const annotationKeys = new Set(
        item.markDefs.map((definition) => definition._key),
      );
      item.children.forEach((span, spanIndex) => {
        span.marks.forEach((mark, markIndex) => {
          if (!decorators.has(mark) && !annotationKeys.has(mark)) {
            issues.push({
              path: [
                "body",
                locale,
                itemIndex,
                "children",
                spanIndex,
                "marks",
                markIndex,
              ],
              message: `mark "${mark}" has no matching link markDef.`,
            });
          }
        });
      });
      return;
    }
    if (item._type === "callout") {
      normalizeBlocks(item.body, `${itemScope}.body`, issues);
      return;
    }
    if (item._type === "table") {
      assignKeys(item.rows, `${itemScope}.rows`, issues);
      item.rows.forEach((row, rowIndex) => {
        const rowScope = `${itemScope}.rows.${rowIndex}`;
        assignKeys(row.cells, `${rowScope}.cells`, issues);
        row.cells.forEach((cell, cellIndex) => {
          normalizeBlocks(
            cell.value,
            `${rowScope}.cells.${cellIndex}.value`,
            issues,
          );
        });
      });
    }
  });
}

function normalizePublicSiteOrigin(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(
      "PUBLIC_SITE_ORIGIN_INVALID",
      "config.publicSiteOrigin must be a non-empty HTTPS origin.",
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw validationError(
      "PUBLIC_SITE_ORIGIN_INVALID",
      "config.publicSiteOrigin must be a valid absolute HTTPS origin.",
      undefined,
      error,
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw validationError(
      "PUBLIC_SITE_ORIGIN_INVALID",
      "config.publicSiteOrigin must be an HTTPS origin without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}

function normalizeCanonicalUrl(value, publicSiteOrigin) {
  const url = new URL(value);
  if (url.origin !== publicSiteOrigin) {
    throw new TypeError(
      `Canonical URL must use the configured public site origin ${publicSiteOrigin}.`,
    );
  }
  return url.href;
}

function schemaIssues(error) {
  return error.issues.slice(0, 40).map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

function parseContentArticle(candidate, contentType, publicSiteOrigin) {
  let article;
  try {
    article = contentArticleSchema.parse(candidate);
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError(
        "ARTICLE_SCHEMA_INVALID",
        "The article does not satisfy the content 1.1 contract.",
        { issues: schemaIssues(error) },
        error,
      );
    }
    throw error;
  }

  const issues = [];
  if (contentType === "blog-en") {
    if (article.seo === undefined || article.seo === null) {
      issues.push({ path: "seo", message: "SEO is required for blog-en." });
    } else if (!article.seo.canonicalUrl) {
      issues.push({
        path: "seo.canonicalUrl",
        message:
          "English and Chinese canonical URLs are required for blog-en.",
      });
    }
  }
  if (article.seo?.canonicalUrl) {
    for (const locale of ["en", "zh"]) {
      try {
        article.seo.canonicalUrl[locale] = normalizeCanonicalUrl(
          article.seo.canonicalUrl[locale],
          publicSiteOrigin,
        );
      } catch (error) {
        issues.push({
          path: `seo.canonicalUrl.${locale}`,
          message: error.message,
        });
      }
    }
  }
  normalizePortableText(article.body.en, "en", issues);
  normalizePortableText(article.body.zh, "zh", issues);
  if (issues.length > 0) {
    throw validationError(
      "ARTICLE_SCHEMA_INVALID",
      "The article does not satisfy the content 1.1 contract.",
      { issues: issues.slice(0, 40) },
    );
  }
  return article;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

async function requireOrdinaryDirectory(directoryPath, code, message) {
  try {
    const metadata = await lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not an ordinary directory");
    }
    const resolved = await realpath(directoryPath);
    if (resolved !== directoryPath) throw new Error("redirected directory");
    return resolved;
  } catch (error) {
    throw validationError(code, message, undefined, error);
  }
}

async function inspectArticleFile(contentType, articlePath, config) {
  if (
    !config ||
    typeof config.workspaceRoot !== "string" ||
    !path.isAbsolute(config.workspaceRoot)
  ) {
    throw validationError(
      "WORKSPACE_ROOT_REQUIRED",
      "A fixed absolute config.workspaceRoot is required.",
    );
  }

  const workspaceRoot = path.resolve(config.workspaceRoot);
  await requireOrdinaryDirectory(
    workspaceRoot,
    "WORKSPACE_ROOT_INVALID",
    "The configured workspace root is missing or unsafe.",
  );
  const contentsRoot = path.join(workspaceRoot, "contents");
  await requireOrdinaryDirectory(
    contentsRoot,
    "CONTENTS_DIRECTORY_INVALID",
    "The configured contents directory is missing or unsafe.",
  );

  if (
    typeof articlePath !== "string" ||
    articlePath.length === 0 ||
    !path.isAbsolute(articlePath)
  ) {
    throw validationError(
      "ARTICLE_PATH_INVALID",
      "articlePath must be an absolute path.",
    );
  }
  const requested = path.resolve(articlePath);
  const liveTypeRoot = path.join(contentsRoot, contentType);
  const liveArticleDirectory = path.dirname(requested);
  const isLivePath = path.dirname(liveArticleDirectory) === liveTypeRoot;
  const stagingRoot = path.join(contentsRoot, ".staging");
  const stagingTypeRoot = path.join(stagingRoot, contentType);
  const stagingArticleDirectory = path.dirname(requested);
  const reservationDirectory = path.dirname(stagingArticleDirectory);
  const reservationId = path.basename(reservationDirectory);
  const isStagingPath =
    path.dirname(reservationDirectory) === stagingTypeRoot &&
    UUID_V4_PATTERN.test(reservationId);

  if (!isLivePath && !isStagingPath) {
    throw validationError(
      "ARTICLE_LOCATION_INVALID",
      "The article JSON must use a live content directory or a UUID v4 staging directory.",
    );
  }
  if (isLivePath) {
    await requireOrdinaryDirectory(
      liveTypeRoot,
      "CONTENT_TYPE_DIRECTORY_INVALID",
      "The configured content-type directory is missing or unsafe.",
    );
    await requireOrdinaryDirectory(
      liveArticleDirectory,
      "ARTICLE_DIRECTORY_INVALID",
      "The article directory is missing or unsafe.",
    );
  } else {
    await requireOrdinaryDirectory(
      stagingRoot,
      "STAGING_DIRECTORY_INVALID",
      "The content staging directory is missing or unsafe.",
    );
    await requireOrdinaryDirectory(
      stagingTypeRoot,
      "STAGING_CONTENT_TYPE_DIRECTORY_INVALID",
      "The staging content-type directory is missing or unsafe.",
    );
    await requireOrdinaryDirectory(
      reservationDirectory,
      "STAGING_RESERVATION_DIRECTORY_INVALID",
      "The staging reservation directory is missing or unsafe.",
    );
    await requireOrdinaryDirectory(
      stagingArticleDirectory,
      "ARTICLE_DIRECTORY_INVALID",
      "The staged article directory is missing or unsafe.",
    );
  }

  let metadata;
  let resolvedArticle;
  try {
    metadata = await lstat(requested);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      path.extname(requested).toLowerCase() !== ".json"
    ) {
      throw new Error("not an ordinary JSON file");
    }
    resolvedArticle = await realpath(requested);
  } catch (error) {
    throw validationError(
      "ARTICLE_INVALID",
      "The article JSON is missing or is not a regular non-symbolic-link file.",
      undefined,
      error,
    );
  }
  if (
    resolvedArticle !== requested ||
    (isLivePath && !isInside(liveTypeRoot, resolvedArticle)) ||
    (isStagingPath && !isInside(stagingTypeRoot, resolvedArticle))
  ) {
    throw validationError(
      "ARTICLE_LOCATION_INVALID",
      "The article JSON must use contents/<content-type>/<slug>/<slug>.json or contents/.staging/<content-type>/<uuid-v4>/<slug>/<slug>.json.",
    );
  }
  if (metadata.size <= 0 || metadata.size > MAX_ARTICLE_BYTES) {
    throw validationError(
      "ARTICLE_SIZE_INVALID",
      `The article JSON must be non-empty and no larger than ${MAX_ARTICLE_BYTES} bytes.`,
    );
  }

  let handle;
  let articleBytes;
  try {
    handle = await open(requested, fsConstants.O_RDONLY);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      !sameFileIdentity(metadata, openedMetadata) ||
      openedMetadata.size !== metadata.size
    ) {
      throw new Error("article changed while opening");
    }
    articleBytes = await handle.readFile();
    const finalMetadata = await handle.stat();
    if (
      articleBytes.length !== metadata.size ||
      !sameFileIdentity(openedMetadata, finalMetadata) ||
      finalMetadata.size !== articleBytes.length
    ) {
      throw new Error("article changed while reading");
    }
  } catch (error) {
    throw validationError(
      "ARTICLE_CHANGED",
      "The article changed while it was inspected.",
      undefined,
      error,
    );
  } finally {
    await handle?.close().catch(() => {});
  }

  let candidate;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      articleBytes,
    );
    candidate = JSON.parse(source);
  } catch (error) {
    throw validationError(
      "ARTICLE_JSON_INVALID",
      "The article is not valid UTF-8 JSON.",
      undefined,
      error,
    );
  }
  const publicSiteOrigin = normalizePublicSiteOrigin(
    config.publicSiteOrigin ?? DEFAULT_PUBLIC_SITE_ORIGIN,
  );
  const article = parseContentArticle(
    candidate,
    contentType,
    publicSiteOrigin,
  );
  if (
    path.basename(resolvedArticle, ".json") !== article.slug ||
    path.basename(path.dirname(resolvedArticle)) !== article.slug
  ) {
    throw validationError(
      "ARTICLE_SLUG_MISMATCH",
      "The article slug must match both its directory and JSON filename.",
    );
  }
  return {
    article,
    articleBytes,
    articlePath: resolvedArticle,
  };
}

function appendAssetReference(references, kind, source, location) {
  if (source && typeof source.path === "string") {
    references.push({ kind, sourcePath: source.path, location });
  }
}

function collectLocalAssetReferences(article) {
  const references = [];
  appendAssetReference(
    references,
    "image",
    article.coverImage?.source,
    "coverImage.source",
  );

  function visit(value, location) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}.${index}`));
      return;
    }
    if (value._type === "image") {
      appendAssetReference(
        references,
        "image",
        value.source,
        `${location}.source`,
      );
    } else if (value._type === "video") {
      if (value.sourceType === "upload") {
        appendAssetReference(
          references,
          "video",
          value.source,
          `${location}.source`,
        );
      }
      appendAssetReference(
        references,
        "image",
        value.poster?.source,
        `${location}.poster.source`,
      );
    } else if (value._type === "attachment") {
      appendAssetReference(
        references,
        "attachment",
        value.source,
        `${location}.source`,
      );
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "source" && key !== "poster") {
        visit(child, `${location}.${key}`);
      }
    }
  }

  visit(article.body, "body");
  appendAssetReference(
    references,
    "image",
    article.seo?.openGraph?.image?.source,
    "seo.openGraph.image.source",
  );
  return references;
}

function detectImageFormat(bytes) {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
  ) {
    return "png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  const ascii = bytes.toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "webp";
  }
  if (
    ascii.slice(4, 8) === "ftyp" &&
    ["avif", "avis"].some((brand) => ascii.slice(8).includes(brand))
  ) {
    return "avif";
  }
  return null;
}

function detectVideoFormat(bytes) {
  const ascii = bytes.toString("ascii");
  if (bytes.length >= 12 && ascii.slice(4, 8) === "ftyp") {
    const mp4Brands = new Set([
      "isom",
      "iso2",
      "iso3",
      "iso4",
      "iso5",
      "iso6",
      "iso8",
      "iso9",
      "mp41",
      "mp42",
      "avc1",
      "dash",
      "MSNV",
    ]);
    if (mp4Brands.has(ascii.slice(8, 12))) return "mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes
      .subarray(0, 4)
      .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.toString("latin1").toLowerCase().includes("webm")
  ) {
    return "webm";
  }
  return null;
}

function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function detectAttachmentFormat(bytes, expectedFormat) {
  if (expectedFormat === "pdf") {
    return bytes.subarray(0, 5).toString("ascii") === "%PDF-" ? "pdf" : null;
  }
  if (expectedFormat === "txt" || expectedFormat === "csv") {
    return isUtf8Text(bytes) ? expectedFormat : null;
  }
  if (
    !bytes
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    !bytes
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  ) {
    return null;
  }
  const archiveIndex = bytes.toString("latin1");
  if (!archiveIndex.includes("[Content_Types].xml")) return null;
  if (expectedFormat === "docx" && archiveIndex.includes("word/")) {
    return "docx";
  }
  if (expectedFormat === "xlsx" && archiveIndex.includes("xl/")) {
    return "xlsx";
  }
  if (expectedFormat === "pptx" && archiveIndex.includes("ppt/")) {
    return "pptx";
  }
  return null;
}

function detectedFormat(kind, bytes, expectedFormat) {
  if (kind === "image") return detectImageFormat(bytes.subarray(0, 64));
  if (kind === "video") return detectVideoFormat(bytes.subarray(0, 4096));
  return detectAttachmentFormat(bytes, expectedFormat);
}

async function inspectAsset(assetRoot, reference) {
  const filename = reference.sourcePath.slice("./assets/".length);
  const candidate = path.join(assetRoot, filename);
  const definition = ASSET_FORMATS.get(path.extname(filename).toLowerCase());
  if (!definition || definition.kind !== reference.kind) {
    throw validationError(
      "ASSET_FORMAT_INVALID",
      `Unsupported ${reference.kind} asset extension: ${filename}.`,
      { location: reference.location },
    );
  }

  let metadata;
  let resolved;
  try {
    metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not an ordinary file");
    }
    resolved = await realpath(candidate);
  } catch (error) {
    throw validationError(
      "ASSET_FILE_INVALID",
      `A referenced local asset is missing or unsafe: ${filename}.`,
      { location: reference.location },
      error,
    );
  }
  if (!isInside(assetRoot, resolved) || resolved !== candidate) {
    throw validationError(
      "ASSET_PATH_INVALID",
      `A referenced local asset escapes or redirects outside the assets directory: ${filename}.`,
      { location: reference.location },
    );
  }
  const limit = ASSET_LIMITS[reference.kind];
  if (metadata.size <= 0 || metadata.size > limit) {
    throw validationError(
      "ASSET_SIZE_INVALID",
      `The ${reference.kind} asset must be non-empty and no larger than ${limit} bytes: ${filename}.`,
      { location: reference.location },
    );
  }

  let handle;
  let bytes;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      !sameFileIdentity(metadata, openedMetadata) ||
      openedMetadata.size !== metadata.size
    ) {
      throw new Error("asset changed while opening");
    }
    bytes = await handle.readFile();
    const finalMetadata = await handle.stat();
    if (
      bytes.length !== metadata.size ||
      !sameFileIdentity(openedMetadata, finalMetadata) ||
      finalMetadata.size !== bytes.length
    ) {
      throw new Error("asset changed while reading");
    }
  } catch (error) {
    throw validationError(
      "ASSET_CHANGED",
      `A local asset changed or could not be read while it was inspected: ${filename}.`,
      { location: reference.location },
      error,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
  if (bytes.length !== metadata.size || bytes.length > limit) {
    throw validationError(
      "ASSET_CHANGED",
      `A local asset changed while it was inspected: ${filename}.`,
      { location: reference.location },
    );
  }
  if (detectedFormat(reference.kind, bytes, definition.format) !== definition.format) {
    throw validationError(
      "ASSET_FORMAT_INVALID",
      `Asset bytes do not match the extension and expected MIME type: ${filename}.`,
      { location: reference.location },
    );
  }
  return {
    kind: reference.kind,
    sourcePath: reference.sourcePath,
    path: resolved,
    filename,
    mimeType: definition.mimeType,
    size: bytes.length,
    bytes: Buffer.from(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function inspectAssets(article, articlePath) {
  const references = collectLocalAssetReferences(article);
  const uniqueReferences = new Map();
  for (const reference of references) {
    const identity = `${reference.kind}:${reference.sourcePath}`;
    uniqueReferences.set(identity, reference);
  }
  if (uniqueReferences.size > MAX_LOCAL_ASSETS) {
    throw validationError(
      "ASSET_COUNT_EXCEEDED",
      `An article may reference at most ${MAX_LOCAL_ASSETS} local assets.`,
    );
  }
  if (uniqueReferences.size === 0) return [];

  const assetRoot = path.join(path.dirname(articlePath), "assets");
  await requireOrdinaryDirectory(
    assetRoot,
    "ASSET_DIRECTORY_INVALID",
    "The article assets directory is missing or unsafe.",
  );

  const byResolvedPath = new Map();
  const byFilenameKey = new Map();
  for (const reference of uniqueReferences.values()) {
    const asset = await inspectAsset(assetRoot, reference);
    const filenameKey = asset.filename.toLowerCase();
    const sameFilename = byFilenameKey.get(filenameKey);
    if (sameFilename && sameFilename.path !== asset.path) {
      throw validationError(
        "ASSET_FILENAME_CONFLICT",
        `Local asset filenames must be unique without regard to case: ${asset.filename}.`,
      );
    }
    byFilenameKey.set(filenameKey, asset);
    const identity =
      process.platform === "win32" ? asset.path.toLowerCase() : asset.path;
    const previous = byResolvedPath.get(identity);
    if (previous && previous.kind !== asset.kind) {
      throw validationError(
        "ASSET_KIND_CONFLICT",
        `The same local file cannot be used as both ${previous.kind} and ${asset.kind}: ${asset.filename}.`,
      );
    }
    if (!previous) byResolvedPath.set(identity, asset);
  }
  const assets = [...byResolvedPath.values()];
  if (assets.length > MAX_LOCAL_ASSETS) {
    throw validationError(
      "ASSET_COUNT_EXCEEDED",
      `An article may reference at most ${MAX_LOCAL_ASSETS} local assets.`,
    );
  }
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
    throw validationError(
      "ASSET_TOTAL_SIZE_EXCEEDED",
      `Article local assets exceed the ${MAX_TOTAL_ASSET_BYTES} byte combined limit.`,
    );
  }
  return assets;
}

function requireSnapshot(snapshot) {
  const state = snapshotState.get(snapshot);
  if (!state) {
    throw validationError(
      "CONTENT_SNAPSHOT_INVALID",
      "The content snapshot is invalid.",
    );
  }
  return state;
}

function countAssets(assets) {
  return Object.freeze({
    image: assets.filter((asset) => asset.kind === "image").length,
    video: assets.filter((asset) => asset.kind === "video").length,
    attachment: assets.filter((asset) => asset.kind === "attachment").length,
  });
}

export async function prepareContentSnapshot(
  contentType,
  articlePath,
  { config } = {},
) {
  const validatedContentType = requireContentType(contentType);
  const definition = getContentTypeDefinition(validatedContentType);
  const articleInfo = await inspectArticleFile(
    definition.id,
    articlePath,
    config,
  );
  const assets = await inspectAssets(
    articleInfo.article,
    articleInfo.articlePath,
  );
  const article = deepFreeze(structuredClone(articleInfo.article));
  const articleSha256 = createHash("sha256")
    .update(articleInfo.articleBytes)
    .digest("hex");
  const contentHash = createHash("sha256")
    .update("content-type\0")
    .update(definition.id)
    .update("\0article\0")
    .update(articleInfo.articleBytes);
  for (const asset of [...assets].sort((left, right) =>
    `${left.kind}:${left.sourcePath}`.localeCompare(
      `${right.kind}:${right.sourcePath}`,
    ),
  )) {
    contentHash
      .update("\0asset\0")
      .update(asset.kind)
      .update("\0")
      .update(asset.sourcePath)
      .update("\0")
      .update(asset.sha256);
  }
  const contentSha256 = contentHash.digest("hex");
  const assetCounts = countAssets(assets);
  const totalAssetBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  const snapshot = Object.freeze({
    contentType: definition.id,
    slug: article.slug,
    articlePath: articleInfo.articlePath,
    article,
    sha256: articleSha256,
    contentSha256,
    localAssetCount: assets.length,
    assetCounts,
    totalAssetBytes,
  });
  snapshotState.set(snapshot, {
    article,
    articleBytes: Buffer.from(articleInfo.articleBytes),
    articlePath: articleInfo.articlePath,
    assets,
  });
  return snapshot;
}

function normalizeCreatePublishedAt(value) {
  if (typeof value !== "string" || !isStrictIsoDateTime(value)) {
    throw validationError(
      "ARTICLE_PUBLISHED_AT_INVALID",
      "createPublishedAt must be a valid ISO date-time with a time zone.",
    );
  }
  return new Date(value).toISOString();
}

export function materializeContentRequest(
  snapshot,
  { createPublishedAt } = {},
) {
  const state = requireSnapshot(snapshot);
  const requestArticle = structuredClone(state.article);
  if (createPublishedAt !== undefined) {
    requestArticle.publishedAt = normalizeCreatePublishedAt(createPublishedAt);
  }
  const articleBytes =
    createPublishedAt === undefined
      ? Buffer.from(state.articleBytes)
      : Buffer.from(`${JSON.stringify(requestArticle)}\n`, "utf8");
  if (articleBytes.length > MAX_ARTICLE_BYTES) {
    throw validationError(
      "ARTICLE_SIZE_INVALID",
      `The materialized article JSON exceeds ${MAX_ARTICLE_BYTES} bytes.`,
    );
  }
  const immutableArticle = deepFreeze(requestArticle);
  if (state.assets.length === 0) {
    return {
      article: immutableArticle,
      body: articleBytes,
      headers: { "Content-Type": "application/json" },
      localAssetCount: 0,
      assetCounts: snapshot.assetCounts,
      totalAssetBytes: 0,
    };
  }

  const body = new FormData();
  body.append(
    "article",
    new Blob([articleBytes], { type: "application/json" }),
    path.basename(state.articlePath),
  );
  for (const asset of state.assets) {
    body.append(
      "assets",
      new Blob([asset.bytes], { type: asset.mimeType }),
      asset.filename,
    );
  }
  return {
    article: immutableArticle,
    body,
    headers: {},
    localAssetCount: state.assets.length,
    assetCounts: snapshot.assetCounts,
    totalAssetBytes: snapshot.totalAssetBytes,
  };
}

export function describeContentSnapshot(snapshot) {
  requireSnapshot(snapshot);
  return {
    ok: true,
    valid: true,
    contentType: snapshot.contentType,
    slug: snapshot.slug,
    articlePath: snapshot.articlePath,
    sha256: snapshot.sha256,
    contentSha256: snapshot.contentSha256,
    bodyBlocks: {
      en: snapshot.article.body.en.length,
      zh: snapshot.article.body.zh.length,
    },
    localAssetCount: snapshot.localAssetCount,
    assetCounts: { ...snapshot.assetCounts },
    totalAssetBytes: snapshot.totalAssetBytes,
  };
}

export function materializeContentPreviewAssets(snapshot) {
  const state = requireSnapshot(snapshot);
  return state.assets.map((asset) =>
    Object.freeze({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      sha256: asset.sha256,
      bytes: Buffer.from(asset.bytes),
    }),
  );
}
