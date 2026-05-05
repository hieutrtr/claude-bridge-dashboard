// T06 — markdown rendering helpers shared by `tasks.get` (server-side
// byte-cap) and the `/tasks/[id]` page (client/server-rendered ReactMarkdown).
// Centralising the cap + plugin list keeps the procedure clip and the page
// renderer in sync — bumping one without the other would either ship payload
// the page can't handle or render through a stale sanitization config.
//
// Per ARCHITECTURE v1 §10 (Security — XSS row), untrusted markdown
// (`tasks.result_summary` written by the agent) MUST go through
// `rehype-sanitize`. We don't enable raw HTML (no `rehype-raw`), so the
// only DOM the renderer emits is the safe-by-construction subset
// `react-markdown` produces from CommonMark.

import rehypeSanitize from "rehype-sanitize";
import type { PluggableList } from "unified";

// 500_000 bytes mirrors the v1 IMPLEMENTATION-PLAN P1-T6 acceptance
// "render `result_file` < 500KB không vỡ". We cap at the byte boundary
// rather than character count so multi-byte UTF-8 still fits within the
// budget on the wire.
export const MARKDOWN_BYTE_LIMIT = 500_000;

export const MARKDOWN_REHYPE_PLUGINS: PluggableList = [rehypeSanitize];
