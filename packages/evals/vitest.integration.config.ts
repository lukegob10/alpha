import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		globalSetup: "./vitest-global-setup.ts",
		include: ["src/db/queries/__tests__/**/*.{test,spec}.ts"],
		fileParallelism: false,
		testTimeout: 60_000,
		watch: false,
	},
})
