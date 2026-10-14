import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: [
			"src/cli/__tests__/**/*.{test,spec}.ts",
			"src/lifecycle/__tests__/**/*.spec.ts",
			"src/orchestration/__tests__/**/*.spec.ts",
			"src/testing/__tests__/**/*.spec.ts",
			"src/grading/__tests__/**/*.spec.ts",
			"src/evidence/__tests__/**/*.spec.ts",
			"src/infrastructure/__tests__/**/*.spec.ts",
			"src/experiments/__tests__/**/*.spec.ts",
			"src/benchmark/__tests__/**/*.spec.ts",
			"src/db/__tests__/**/*.spec.ts",
		],
		watch: false,
	},
})
