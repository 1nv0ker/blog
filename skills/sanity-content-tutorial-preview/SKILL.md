---
name: sanity-content-tutorial-preview
description: "Create, validate, and locally preview one bilingual Sanity tutorial document through the bundled sanityblog MCP server. Use when the user wants a reviewable local bundle without a publisher API probe or remote mutation."
---

# Sanity Tutorial Preview

Create and review one local tutorial bundle. This workflow makes no publisher API probe or mutation.

## Allowed tools

- `sanity_content_check_config({})`
- `sanity_content_start_config_setup({})`
- `sanity_content_prepare_publish({contentType: "tutorial", baseSlug})`
- `sanity_content_validate({contentType: "tutorial", articlePath})`
- `sanity_content_preview({contentType: "tutorial", articlePath})`
- `sanity_content_commit({contentType: "tutorial", slug, reservationId})`
- `sanity_content_release({contentType: "tutorial", slug, reservationId})`

Never call a probe, publish, or update tool from this skill.

## Safety rules

- This skill is permanently bound to `contentType: "tutorial"`. Never substitute another type or use a `sanity_blog_*` tool.
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
- For `tutorial`, `seo`, `author`, and `coverImage` are optional and may be omitted or set to `null` when the API contract permits.
- During update, omission preserves the remote optional value while an explicit supported `null` clears it. Do not collapse these meanings.

## Workflow

1. Confirm the slug, audience, bilingual scope, intended local assets, and review goal.
2. Call `sanity_content_check_config({})`. For a reinitializable configuration error only, call `sanity_content_start_config_setup({})` once and stop until setup completes.
3. Call `sanity_content_prepare_publish({contentType: "tutorial", baseSlug})` once. Capture every returned path and identifier.
4. Write the bilingual Markdown, strict JSON, and local resources only at the returned staging paths.
5. Call `sanity_content_validate({contentType: "tutorial", articlePath})` until valid.
6. Call `sanity_content_preview({contentType: "tutorial", articlePath})` and inspect both languages, rich blocks, safe asset metadata, links, SEO, JSON, and Markdown.
7. Repeat validation and preview after every edit. Continue only with the exact revision the user accepts.
8. Ask whether to keep the accepted local bundle. If declined, call `sanity_content_release({contentType: "tutorial", slug, reservationId})` when the returned state says release is safe.
9. If accepted, call `sanity_content_commit({contentType: "tutorial", slug, reservationId})` once. Never retry when the result explicitly reports `committed: true`.
10. Call `sanity_content_preview({contentType: "tutorial", articlePath})` on the authoritative committed path and require its revision to equal the accepted staging revision.
11. Report the final Markdown, JSON, assets, and preview paths, and state that no publisher API request occurred.

Do not delete or replace an authoritative bundle to recover from an ambiguous local commit.
