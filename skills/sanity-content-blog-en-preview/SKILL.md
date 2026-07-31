---
name: sanity-content-blog-en-preview
description: "Create, validate, and locally preview one bilingual Sanity blog-en document through the bundled sanityblog MCP server. Use when the user wants a reviewable local bundle without a publisher API probe or remote mutation."
---

# Sanity Blog EN Preview

Create and review one local blog-en bundle. This workflow makes no publisher API probe or mutation.

## Allowed tools

- `sanity_content_check_config({})`
- `sanity_content_start_config_setup({})`
- `sanity_content_prepare_publish({contentType: "blog-en", baseSlug})`
- `sanity_content_validate({contentType: "blog-en", articlePath})`
- `sanity_content_preview({contentType: "blog-en", articlePath})`
- `sanity_content_commit({contentType: "blog-en", slug, reservationId})`
- `sanity_content_release({contentType: "blog-en", slug, reservationId})`

Never call a probe, publish, or update tool from this skill.

## Safety rules

- This skill is permanently bound to `contentType: "blog-en"`. Never substitute another type or use a `sanity_blog_*` tool.
- Use only paths, slugs, reservation IDs, revisions, origins, and targets returned for the current attempt.
- Never replace an MCP call with direct HTTP and never expose tokens, headers, raw responses, configuration files, or stack traces.
- Treat `sanity_content_commit` as a local workspace operation, not a Git commit.
- After any Markdown, JSON, metadata, or asset change, validate and preview again; never reuse the earlier `previewRevision`.

## Content contract

- Keep English and Chinese Markdown and JSON independently readable and factually equivalent.
- Do not write `contentType`, Sanity `_type`, credentials, headers, or target configuration into article JSON.
- Use only API 1.1 body items: `block`, `image`, `code`, `video`, `attachment`, `callout`, and `table`.
- Inside a callout body or table cell, use text blocks with `style: "normal"` only. Nested `blockquote` is invalid even if an OpenAPI description suggests otherwise.
- Use safe Portable Text links and unique sibling `_key` values. Omitted keys may be generated deterministically.
- Put local resources only in the returned `assetsDirectory` and reference them as `./assets/<filename>`. Never use absolute or nested local source paths, path traversal, or disguised file extensions.
- If supplied, `publishedAt` must be a strict ISO date-time with a time zone.
- This `blog-en` document requires a complete API 1.1 SEO object: localized title and description, robots settings, and two distinct English/Chinese canonical HTTPS URLs under `publicSiteOrigin`. Validate any optional keywords or Open Graph fields when supplied.
- Never omit or set `seo` to `null`. Preserve valid canonical values during update unless the user explicitly requests a valid replacement.

## Workflow

1. Confirm the slug, audience, bilingual scope, intended local assets, and review goal.
2. Call `sanity_content_check_config({})`. For a reinitializable configuration error only, call `sanity_content_start_config_setup({})` once and stop until setup completes.
3. Call `sanity_content_prepare_publish({contentType: "blog-en", baseSlug})` once. Capture every returned path and identifier.
4. Write the bilingual Markdown, strict JSON, and local resources only at the returned staging paths.
5. Call `sanity_content_validate({contentType: "blog-en", articlePath})` until valid.
6. Call `sanity_content_preview({contentType: "blog-en", articlePath})` and inspect both languages, rich blocks, safe asset metadata, links, SEO, JSON, and Markdown.
7. Repeat validation and preview after every edit. Continue only with the exact revision the user accepts.
8. Ask whether to keep the accepted local bundle. If declined, call `sanity_content_release({contentType: "blog-en", slug, reservationId})` when the returned state says release is safe.
9. If accepted, call `sanity_content_commit({contentType: "blog-en", slug, reservationId})` once. Never retry when the result explicitly reports `committed: true`.
10. Call `sanity_content_preview({contentType: "blog-en", articlePath})` on the authoritative committed path and require its revision to equal the accepted staging revision.
11. Report the final Markdown, JSON, assets, and preview paths, and state that no publisher API request occurred.

Do not delete or replace an authoritative bundle to recover from an ambiguous local commit.
