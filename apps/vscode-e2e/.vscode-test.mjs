/**
 * See: https://code.visualstudio.com/api/working-with-extensions/testing-extension
 */

import { defineConfig } from "@vscode/test-cli"

export default defineConfig({
	label: "integrationTest",
	version: "1.125.0",
	files: "out/suite/**/*.test.js",
	workspaceFolder: ".",
	mocha: {
		ui: "tdd",
		timeout: 60000,
	},
	launchArgs: ["--enable-proposed-api=Alpha.alpha", "--disable-extensions"],
})
