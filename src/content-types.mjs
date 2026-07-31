export const CONTENT_TYPE_IDS = Object.freeze([
  "blog-en",
  "guide",
  "comparison",
  "solution",
  "alternative",
  "tutorial",
]);

const definitions = {
  "blog-en": {
    id: "blog-en",
    documentType: "blogEn",
    canonicalRequired: true,
  },
  guide: {
    id: "guide",
    documentType: "guide",
    canonicalRequired: false,
  },
  comparison: {
    id: "comparison",
    documentType: "comparison",
    canonicalRequired: false,
  },
  solution: {
    id: "solution",
    documentType: "solution",
    canonicalRequired: false,
  },
  alternative: {
    id: "alternative",
    documentType: "alternative",
    canonicalRequired: false,
  },
  tutorial: {
    id: "tutorial",
    documentType: "tutorial",
    canonicalRequired: false,
  },
};

const CONTENT_TYPES = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      Object.freeze({ ...definition }),
    ]),
  ),
);

export class UnsupportedContentTypeError extends TypeError {
  constructor(contentType) {
    super(
      `Unsupported content type "${String(contentType)}". Expected one of: ${CONTENT_TYPE_IDS.join(", ")}.`,
    );
    this.name = "UnsupportedContentTypeError";
    this.category = "validation";
    this.code = "CONTENT_TYPE_UNSUPPORTED";
    this.retryable = false;
    this.resultUnknown = false;
    this.contentType = contentType;
  }
}

export function requireContentType(contentType) {
  if (
    typeof contentType !== "string" ||
    !Object.hasOwn(CONTENT_TYPES, contentType)
  ) {
    throw new UnsupportedContentTypeError(contentType);
  }
  return contentType;
}

export function getContentTypeDefinition(contentType) {
  return CONTENT_TYPES[requireContentType(contentType)];
}
