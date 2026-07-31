---
name: sanity-content-alternative-update
description: "Revise, validate, preview, probe, and update an existing bilingual Sanity alternative document through the bundled sanityblog MCP server. Use only for an identified existing document and never to create a missing one."
---

# Sanity Alternative Update

Update one existing alternative document through a revision-guarded PUT-only workflow. A missing local or remote document is a hard stop.

## Allowed tools

- `sanity_content_check_config({})`
- `sanity_content_start_config_setup({})`
- `sanity_content_prepare_update({contentType: "alternative", slug})`
- `sanity_content_validate({contentType: "alternative", articlePath})`
- `sanity_content_preview({contentType: "alternative", articlePath})`
- `sanity_content_probe_update({contentType: "alternative", articlePath, previewRevision})`
- `sanity_content_commit({contentType: "alternative", slug, reservationId})`
- `sanity_content_release({contentType: "alternative", slug, reservationId})`
- `sanity_content_update({contentType: "alternative", articlePath, previewRevision})`

Never call a publish tool, POST, a `sanity_blog_*` tool, or direct HTTP. This skill must never create a missing document.

## Safety rules

- This skill is permanently bound to `contentType: "alternative"`. Never substitute another type or use a `sanity_blog_*` tool.
- Use only paths, slugs, reservation IDs, revisions, origins, and targets returned for the current attempt.
- Never replace an MCP call with direct HTTP and never expose tokens, headers, raw responses, configuration files, or stack traces.
- Treat `sanity_content_commit` as a local workspace operation, not a Git commit.
- After any Markdown, JSON, metadata, or asset change, validate and preview again; never reuse the earlier `previewRevision`.

- Require a complete existing local bundle, a user-accepted local preview, a successful PUT dry-run, and explicit confirmation immediately before the final write sequence.
- Pass the exact accepted `previewRevision` to probe and update.
- Never retry the final PUT after timeout, cancellation, an unknown outcome, `remoteMutationSucceeded: true`, or any confirmed remote success.

## Content contract

- Keep English and Chinese Markdown and JSON independently readable and factually equivalent.
- Do not write `contentType`, Sanity `_type`, credentials, headers, or target configuration into article JSON.
- Use only API 1.1 body items: `block`, `image`, `code`, `video`, `attachment`, `callout`, and `table`.
- Inside a callout body or table cell, use text blocks with `style: "normal"` only. Nested `blockquote` is invalid even if an OpenAPI description suggests otherwise.
- Use safe Portable Text links and unique sibling `_key` values. Omitted keys may be generated deterministically.
- Put local resources only in the returned `assetsDirectory` and reference them as `./assets/<filename>`. Never use absolute or nested local source paths, path traversal, or disguised file extensions.
- If supplied, `publishedAt` must be a strict ISO date-time with a time zone.
- For `alternative`, `seo`, `author`, and `coverImage` are optional and may be omitted or set to `null` when the API contract permits.
- During update, omission preserves the remote optional value while an explicit supported `null` clears it. Do not collapse these meanings.

## Workflow

1. Confirm the existing slug, requested changes, bilingual scope, and asset changes.
2. Call `sanity_content_check_config({})`. For a reinitializable configuration error only, call `sanity_content_start_config_setup({})` once and stop until setup completes. Capture the safe origins and target.
3. Call `sanity_content_prepare_update({contentType: "alternative", slug})`. Capture every returned path and identifier; stop if the authoritative local bundle is missing or incomplete.
4. Modify only returned staging paths. Preserve the exact type and slug, and keep Markdown, JSON, and assets aligned.
5. Preserve omission versus explicit `null`: omission preserves the remote value; explicit supported `null` clears it.
6. Call `sanity_content_validate({contentType: "alternative", articlePath})` until valid, then call `sanity_content_preview({contentType: "alternative", articlePath})` and inspect the local preview.
7. Repeat validation and preview after every edit. Continue only after the user accepts the current `previewRevision`.
8. Call `sanity_content_probe_update({contentType: "alternative", articlePath, previewRevision})` exactly once. Require `mode: "update"`, the expected ID, and revision; stop on 404 or any ambiguous state.
9. Freeze the bundle and recheck configuration. Stop if publisher origin, public site origin, or target changed.
10. Present the exact changes, target, ID/revision, assets, optional-field and canonical impact, and accepted preview. Ask for explicit confirmation for one PUT.
11. If declined, call `sanity_content_release({contentType: "alternative", slug, reservationId})` only when safe.
12. If confirmed, call `sanity_content_commit({contentType: "alternative", slug, reservationId})` once. If it reports `committed: true` with cleanup failure, use its authoritative paths and never retry commit.
13. Call `sanity_content_preview({contentType: "alternative", articlePath})` on the authoritative committed path and require the revision to equal the accepted revision.
14. Call `sanity_content_update({contentType: "alternative", articlePath, previewRevision})` exactly once. It performs a fresh PUT dry-run and one guarded PUT; it never creates.
15. Report only safe result fields and final local paths.

If the remote mutation succeeded but the local record failed, report partial success without retrying. For an unknown remote outcome, stop and require independent remote-state verification.
