import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// A correctly-typed `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// These cover the route guards only — they return before any ESPN fetch, so
// they're deterministic and network-free. The live scoreboard fetch + cache
// HIT/MISS behaviour is verified end-to-end with `wrangler dev` + curl.
describe("nwslapp-proxy route guards", () => {
	it("404s any path other than /scoreboard", async () => {
		const request = new IncomingRequest("https://proxy.test/teams");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it("405s non-GET requests to /scoreboard", async () => {
		const response = await SELF.fetch("https://proxy.test/scoreboard", {
			method: "POST",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});
});
