import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["src/**/*.{test,spec}.{ts,tsx,js}"],
		globals: true,
		environment: "node",
		watch: false,
		// Native bundling and Git fixtures share CPU and disk with the extension's concurrent Turbo pool.
		maxWorkers: 4,
	},
})
