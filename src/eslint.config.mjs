import { config, promiseOwnership } from "@alpha-code/config-eslint/base"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		...promiseOwnership,
		files: [
			"api/providers/gemini.ts",
			"core/context-tracking/FileContextTracker.ts",
			"core/ignore/AlphaIgnoreController.ts",
			"integrations/terminal/ShellIntegrationManager.ts",
			"integrations/terminal/TerminalProcess.ts",
			"integrations/workspace/WorkspaceTracker.ts",
		],
	},
	{
		rules: {
			// TODO: These should be fixed and the rules re-enabled.
			"no-regex-spaces": "off",
			"no-useless-escape": "off",
			"no-empty": "off",
			"prefer-const": "off",

			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/ban-ts-comment": "off",
		},
	},
	{
		files: ["core/assistant-message/presentAssistantMessage.ts", "core/webview/webviewMessageHandler.ts"],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		files: ["__mocks__/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		ignores: ["webview-ui", "out"],
	},
]
