import { configDefaults, defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		// Bundled document examples belong to the shipped kit, not the extension unit suite.
		exclude: [...configDefaults.exclude, "webview-ui/build/**"],
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
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
