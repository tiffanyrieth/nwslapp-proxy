// Plain-Node stand-in for the Workers-runtime-only `cloudflare:workers` module, so the `node --test`
// suites can keep importing src/index.ts (which now re-exports the EspnFetcher Durable Object class).
// Only the base class is stubbed: node tests exercise pure logic and never instantiate the object —
// the real Durable Object is covered by the vitest-pool-workers suite (test/espn-fetcher.spec.ts).
import { register } from "node:module";

const stub = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
const hooks = `
export async function resolve(specifier, context, next) {
	if (specifier === "cloudflare:workers") {
		return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
	}
	return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
