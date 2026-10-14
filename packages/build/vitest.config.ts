import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["src/**/*.{test,spec}.{ts,tsx,js}"],
		globals: true,
		environment: "node",
		watch: false,
	},
})
