import { defineConfig } from "vitest/config"
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/infrastructure/__services__/**/*.spec.ts"],
		fileParallelism: false,
		testTimeout: 15000,
		hookTimeout: 15000,
		watch: false,
	},
})
