import { defineConfig } from "tsup"

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs", "esm"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	outDir: "dist",
	// The Poe package exposes ESM-only subpaths. Bundle it so this package's
	// documented CommonJS entry can be loaded by VS Code extension tests.
	noExternal: ["ai-sdk-provider-poe"],
})
