import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/certification/__contracts__/**/*.spec.ts"],
		testTimeout: 120_000,
		watch: false,
	},
})
