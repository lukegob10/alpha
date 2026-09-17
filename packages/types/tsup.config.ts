import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs", "esm"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	outDir: "dist",
	// Poe exposes its /code entrypoint for ESM imports only. Bundle that small
	// adapter so the documented CommonJS package entrypoint remains loadable.
	noExternal: ["ai-sdk-provider-poe"],
})
