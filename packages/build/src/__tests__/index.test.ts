// npx vitest run src/__tests__/index.test.ts

import { generatePackageJson } from "../index.js"

describe("generatePackageJson", () => {
	it("should be a test", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "alpha",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "Alpha",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "alpha-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"alpha-ActivityBar": [
							{
								type: "webview",
								id: "alpha.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "alpha.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "alpha.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "alpha.contextMenu",
								group: "navigation",
							},
						],
						"alpha.contextMenu": [
							{
								command: "alpha.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "alpha.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == alpha.TabPanelProvider",
							},
							{
								command: "alpha.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == alpha.TabPanelProvider",
							},
							{
								command: "alpha.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == alpha.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "alpha.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "alpha.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"alpha.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"alpha.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "alpha-code-nightly",
				displayName: "Alpha Nightly",
				publisher: "Alpha",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["alpha", "alpha-code-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "alpha-code-nightly",
			displayName: "Alpha Nightly",
			description: "%extension.description%",
			publisher: "Alpha",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "alpha-code-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"alpha-code-nightly-ActivityBar": [
						{
							type: "webview",
							id: "alpha-code-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "alpha-code-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "alpha-code-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "alpha-code-nightly.contextMenu",
							group: "navigation",
						},
					],
					"alpha-code-nightly.contextMenu": [
						{
							command: "alpha-code-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "alpha-code-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == alpha-code-nightly.TabPanelProvider",
						},
						{
							command: "alpha-code-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == alpha-code-nightly.TabPanelProvider",
						},
						{
							command: "alpha-code-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == alpha-code-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "alpha-code-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "alpha-code-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"alpha-code-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"alpha-code-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
					},
				},
			},
			scripts: {},
		})
	})
})
