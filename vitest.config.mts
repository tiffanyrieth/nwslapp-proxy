import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// Two runners live here: *.spec.ts + a few *.test.ts run under vitest (workerd); the rest are plain
		// `node:test` files (the original watcher-style pure-logic tests) and run via `npm run test:node`.
		// vitest can't load `node:test`, so exclude those files instead of showing 19 phantom failures.
		exclude: ["**/node_modules/**", "test/{admin-auth,admin-portal-syntax,analytics-admin,apple-auth,bracket-accuracy,brightdata,khg-calendar,knowher*,load_knowher,matchday-jersey,scoreboard-dates,social-image-moderation,weather*}.test.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
