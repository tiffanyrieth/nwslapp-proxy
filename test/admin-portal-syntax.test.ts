// Guard: the admin portal's inline <script> must be valid JS *after* the outer template literal is
// evaluated. Run: node --test test/admin-portal-syntax.test.ts
//
// Why this exists: ADMIN_PORTAL_HTML is one big backtick template literal, and the inline script builds
// HTML with single-quoted strings. A word-apostrophe written as `\'` inside the OUTER template literal
// collapses to a bare `'` in the SERVED output, which then terminates the inner single-quoted string and
// makes the ENTIRE <script> fail to parse in the browser — the portal renders its shell but every
// control is dead (2026-09-16: `club\'s` did exactly this, live since 2026-09-14). A source-level
// syntax check misses it because the source string is valid; only the EVALUATED template reveals the
// break. So we evaluate the template the way the Worker does, extract the script, and parse it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function servedScript(): string {
	const src = readFileSync(new URL("../src/admin-portal.ts", import.meta.url), "utf8");
	// The file is `export const ADMIN_PORTAL_HTML = \`...\`;` — evaluate that one template literal.
	const first = src.indexOf("`");
	const last = src.lastIndexOf("`");
	assert.ok(first !== -1 && last > first, "admin-portal.ts should contain a backtick template literal");
	const html = eval(src.slice(first, last + 1)) as string;
	const m = html.match(/<script>([\s\S]*?)<\/script>/);
	assert.ok(m, "served portal HTML should contain exactly one <script> block");
	return m![1];
}

test("the SERVED admin-portal inline script parses as valid JS (no template-collapsed quote breaks)", () => {
	const js = servedScript();
	// new vm.Script parses without executing; a SyntaxError (e.g. an unescaped apostrophe terminating a
	// single-quoted string) throws here — exactly the failure that killed the portal.
	assert.doesNotThrow(() => new vm.Script(js), "served portal <script> must be syntactically valid JS");
});
