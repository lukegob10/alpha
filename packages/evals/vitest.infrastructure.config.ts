import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/infrastructure/__contracts__/**/*.spec.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
		watch: false,
	},
})
