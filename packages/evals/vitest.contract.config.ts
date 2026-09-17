import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: [
			"src/campaign/__tests__/**/*.spec.ts",
			"src/grading/__contracts__/**/*.spec.ts",
			"src/evidence/__contracts__/**/*.spec.ts",
		],
		testTimeout: 60_000,
		watch: false,
	},
})
