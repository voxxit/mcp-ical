import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		environmentMatchGlobs: [
			["src/worker*.test.ts", "node"],
			["src/__tests__/clerk-auth*.test.ts", "node"],
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			exclude: [
				"node_modules/**",
				"dist/**",
				"**/*.config.*",
				"**/*.d.ts",
				"src/worker*.ts",
				"src/clerk*.ts",
				"src/__tests__/**",
				"start.js",
			],
		},
		include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
		testTimeout: 10000,
		setupFiles: [],
	},
});
