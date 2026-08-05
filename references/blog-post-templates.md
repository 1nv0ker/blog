# Blog Post template and module contract

Read this reference before creating, previewing, or changing a `blog-post` template.

## Template selection

An explicit user choice always wins. Otherwise choose the template from the reader's primary job:

| Template | Choose when the article primarily… | Required in each locale |
| --- | --- | --- |
| `default` | reads as a conventional editorial article | no structured module minimum |
| `productExplainer` | explains one product or capability and answers adoption questions | 1 `mediaText`, 1 `faqSection`, 1 `cta` |
| `alternatingContent` | presents multiple visual features or concepts in sequence | 2 `mediaText`, 1 `cta` |
| `alternative` | compares an alternative with explicit criteria | 1 `table`, 1 `faqSection`, 1 `cta` |
| `tutorial` | teaches a reproducible multi-step task | 1 `tutorialSteps` containing at least 2 total steps, 1 `faqSection`, 1 `cta` |
| `solution` | maps a problem to an implementable solution | 1 `mediaText`, 1 `cta` |
| `faq` | resolves a focused set of reader questions | 1 `faqSection`, 1 `cta` |
| `caseStudy` | tells an evidence-backed situation, intervention, and outcome | 1 `mediaText`, 1 `cta` |

Ask the user only when two or more templates are equally plausible and the choice would materially
change the content. For a new article, always write the selected `template`, including `default`.
For an update, omission preserves the existing or remote-only template; change it only on an
explicit request. Writing `"template": "default"` explicitly resets the template.

Plan the English and Chinese module sequences before drafting. Each locale must independently meet
the selected template's minimums and be naturally localized, while preserving facts, limitations,
links, actions, and module intent.

## Supported body items

Top-level body arrays support `block`, `image`, `code`, `video`, `attachment`, `callout`, `table`,
`mediaText`, `faqSection`, `tutorialSteps`, and `cta`.

- `block`: styles are `normal`, `h2`, `h3`, or `blockquote`; lists use `listItem` and optional
  `level`. Top-level decorators are `strong`, `em`, and `code`, plus safe link annotations.
- `image`: `{_type, _key?, source, alt, caption?, crop?, hotspot?}`. `alt` must be non-blank in the
  language of its containing body.
- `code`: `{_type, _key?, language?, code, highlightedLines?}`.
- Upload `video`:
  `{_type:"video", _key?, sourceType:"upload", source, title, caption?, poster?}`.
- External `video`:
  `{_type:"video", _key?, sourceType:"external", url, title, caption?, poster?}`. Use HTTPS
  YouTube, YouTube No-Cookie, Vimeo, Bilibili, `youtu.be`, `b23.tv`, or a direct MP4/WebM URL only.
- `attachment`: `{_type:"attachment", _key?, source, title}`.
- `callout`: `{_type:"callout", _key?, tone, title?, body}` where tone is `info`, `success`,
  `warning`, or `error` and body contains meaningful normal text blocks.
- `table`: `{_type:"table", _key?, headerRows, rows}`. `headerRows` is 0 or 1. Every row has the
  same non-zero number of cells; each cell contains meaningful normal text blocks.
- `mediaText`: `{_type:"mediaText", _key?, eyebrow?, heading, body, image, mediaPosition}`.
  `mediaPosition` is `auto`, `left`, or `right`; body contains meaningful normal text blocks.
- `faqSection`: `{_type:"faqSection", _key?, heading?, items}`. Each item is
  `{_type:"faqItem", _key?, question, answer}` with a meaningful normal-block answer.
- `tutorialSteps`: `{_type:"tutorialSteps", _key?, heading?, steps}`. Each step is
  `{_type:"tutorialStep", _key?, title, body, image?}`; body contains meaningful normal blocks or
  code.
- `cta`: `{_type:"cta", _key?, eyebrow?, heading, body?, primaryAction, secondaryAction?, theme}`.
  An action is `{_type:"ctaAction", label, href, openInNewTab}` and theme is `dark`, `brand`, or
  `light`.

Nested normal text supports `strong`, `em`, `underline`, `strike-through`, and `code`, plus safe
link annotations. Safe links may be relative or use HTTP, HTTPS, `mailto`, or `tel`; never use
control characters, protocol-relative URLs, backslash-prefixed URLs, or executable schemes.

`_key` may be omitted. Validation generates deterministic keys and default nested `_type` values.
Never deliberately reuse the same `_key` among siblings.

## Asset and media planning

Use one language-neutral local asset for corresponding English and Chinese positions, with
localized surrounding text and alt text. Store local files as flat `./assets/<filename>` paths.

- Images: JPG/JPEG, PNG, GIF, WebP, or AVIF; at most 20 MiB each.
- Videos: MP4 or WebM; at most 100 MiB each.
- Attachments: PDF, TXT, CSV, DOCX, XLSX, or PPTX; at most 20 MiB each.
- Across all kinds: at most 10 unique local assets and 256 MiB total.

Choose media by information gain:

1. Use text for claims, reasoning, limitations, definitions, and source attribution.
2. Use a table for criteria that readers must compare row by row.
3. Use code for exact commands, configuration, or executable examples.
4. Use a callout for a bounded warning, success condition, or critical constraint.
5. Use an image for architecture, spatial relationships, states, or a static product concept.
6. Use video only when motion, interaction, a process, or change over time is materially clearer
   than text plus a static image.
7. Use an attachment only when the downloadable artifact itself is part of the reader task.

Do not bind video generation to a fixed provider or API key. If a suitable generation capability is
available, create an original rights-safe 16:9 MP4/WebM and poster, inspect them, and reuse their
bytes across locales. When video is optional and no capability exists, use a useful image or omit
the video. When the user explicitly requires generated video, pause and explain that the required
capability is unavailable.

Never fabricate customer names, quotes, metrics, product screens, UI states, endorsements, or
comparative results. Avoid unlicensed logos, recognizable private people, watermarks, copied
creative assets, decorative media, and any image or video that implies unsupported evidence.

## Preview expectations

Inspect the selected template's hero, content width, structured modules, media order, tutorial
anchors, FAQ disclosure controls, table overflow, CTA theme, and responsive behavior. Local
validated MP4/WebM assets should play with controls and no autoplay. External video must remain a
safe link rather than an iframe. Attachments are metadata-only in the preview. Treat JSON as the
publication payload and reconcile any mismatch with the sibling Markdown.
