import { configDefaults, defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		// Bundled document examples belong to the shipped kit, not the extension unit suite.
		exclude: [...configDefaults.exclude, "**/{dist,out,build}/**"],
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		// Turbo runs workspace pools together; cap expensive Task/filesystem workers per package.
		maxWorkers: 4,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
