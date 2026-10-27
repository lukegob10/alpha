import { readFileSync, readdirSync } from "node:fs"

type ExtensionManifest = {
	activationEvents: string[]
	contributes: {
		commands: Array<{
			command: string
			icon?: string | { light: string; dark: string }
			title?: string
			enablement?: string
		}>
		keybindings: Array<{ command: string; key: string; mac?: string; when?: string; args?: string }>
		menus: Record<string, Array<{ command: string; group?: string; when?: string }>>
	}
}

const extensionRoot = new URL("../../", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("package.json", extensionRoot), "utf8")) as ExtensionManifest
const localization = JSON.parse(readFileSync(new URL("package.nls.json", extensionRoot), "utf8")) as Record<
	string,
	unknown
>

function localizationReferences(value: unknown): string[] {
	if (typeof value === "string") {
		const reference = /^%([^%]+)%$/.exec(value)
		return reference ? [reference[1]] : []
	}
	return value && typeof value === "object" ? Object.values(value).flatMap(localizationReferences) : []
}

describe("extension command manifest", () => {
	it("activates to restore editor chat panels after a window reload", () => {
		expect(manifest.activationEvents).toContain("onWebviewPanel:alpha.TabPanelProvider")
	})

	it("exposes scoped agent hotkeys without taking over Enter or Plan/Code switching", () => {
		for (const command of [
			"plusButtonClicked",
			"sendAndSteer",
			"decreaseReasoningEffort",
			"increaseReasoningEffort",
			"previousTask",
			"nextTask",
			"nextTaskNeedingInput",
		]) {
			const bindings = manifest.contributes.keybindings.filter(
				(binding) => binding.command === `alpha.${command}`,
			)
			expect(bindings.find((binding) => binding.when?.includes("alpha.focusedWebview == sidebar"))?.args).toBe(
				"sidebar",
			)
			if (command !== "plusButtonClicked") {
				expect(bindings.some((binding) => binding.when === "isWindows && alpha.focusedWebview == editor")).toBe(
					true,
				)
			}
			for (const binding of bindings) {
				expect(binding.when).toMatch(/^isWindows && /)
				expect(binding.mac).toBeUndefined()
			}
			expect(manifest.contributes.commands.some((item) => item.command === `alpha.${command}`)).toBe(true)
		}
		expect(manifest.contributes.keybindings.some((binding) => binding.command === "alpha.plusButtonClicked")).toBe(
			true,
		)
		expect(manifest.contributes.keybindings.some((binding) => ["enter", "shift+tab"].includes(binding.key))).toBe(
			false,
		)
	})
	it("preserves the square-pen New Chat and ticket artwork in the native title actions", () => {
		const newChatCommand = manifest.contributes.commands.find(
			({ command }) => command === "alpha.plusButtonClicked",
		)
		expect(newChatCommand?.icon).toEqual({
			light: "assets/icons/chat-actions/new-chat-light.svg",
			dark: "assets/icons/chat-actions/new-chat-dark.svg",
		})
		expect(newChatCommand?.title).toBe("%command.newTask.title%")
		expect(localization["command.newTask.title"]).toBe("New Chat")
		for (const command of ["alpha.sidebarNewChat", "alpha.sidebarSettings", "alpha.openTickets"]) {
			const icon = manifest.contributes.commands.find((item) => item.command === command)?.icon
			expect(icon && typeof icon).toBe("object")
			if (!icon || typeof icon === "string") throw new Error(`Missing native artwork for ${command}`)
			for (const [theme, iconPath] of Object.entries(icon)) {
				const svg = readFileSync(new URL(iconPath, extensionRoot), "utf8")
				expect(svg).toContain('width="16" height="16"')
				expect(svg).toContain("scale(1.08)")
				expect(svg).toContain(theme === "light" ? 'stroke="#424242"' : 'stroke="#c5c5c5"')
			}
		}
	})

	it("keeps sidebar controls in the native header and editor controls in the webview", () => {
		expect(manifest.contributes.menus["view/title"]).toEqual([
			{ command: "alpha.sidebarNewChat", group: "navigation@1", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.sidebarSettings", group: "navigation@2", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.openTickets", group: "navigation@3", when: "view == alpha.SidebarProvider" },
			{
				command: "alpha.openIncidents",
				group: "overflow@0",
				when: "view == alpha.SidebarProvider && config.alpha.debug",
			},
			{ command: "alpha.sidebarScheduledTasks", group: "overflow@1", when: "view == alpha.SidebarProvider" },
			{ command: "alpha.sidebarMarketplace", group: "overflow@2", when: "view == alpha.SidebarProvider" },
		])
		for (const { command } of manifest.contributes.menus["view/title"]) {
			expect(manifest.contributes.menus["editor/title"].some((item) => item.command === command)).toBe(false)
		}
		for (const command of ["sidebarNewChat", "sidebarSettings", "sidebarScheduledTasks", "sidebarMarketplace"]) {
			expect(manifest.contributes.commands.some((item) => item.command === `alpha.${command}`)).toBe(true)
			expect(manifest.contributes.menus.commandPalette).toContainEqual({
				command: `alpha.${command}`,
				when: "false",
			})
		}
		expect(manifest.contributes.menus.commandPalette).toContainEqual({
			command: "alpha.openIncidents",
			when: "config.alpha.debug",
		})
	})

	it("provides visible zoom controls only in the native SVG preview", () => {
		const when = "activeCustomEditorId == 'imagePreview.previewEditor' && resourceExtname == '.svg'"
		expect(manifest.contributes.menus["editor/title"]).toEqual(
			["Out", "In"].map((direction, index) => ({
				command: `alpha.diagramZoom${direction}`,
				when,
				group: `navigation@${index + 1}`,
			})),
		)
		for (const direction of ["Out", "In"]) {
			const command = `alpha.diagramZoom${direction}`
			expect(manifest.contributes.commands.find((item) => item.command === command)).toMatchObject({
				title: `%command.diagramZoom${direction}.title%`,
				icon: `$(zoom-${direction.toLowerCase()})`,
				enablement: when,
			})
			expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when })
		}
	})

	it("resolves every contributed localization reference to a nonempty English label", () => {
		const references = localizationReferences(manifest)
		expect(references.length).toBeGreaterThan(0)
		for (const key of new Set(references)) {
			const label = localization[key]
			expect(typeof label, `Missing English manifest label: ${key}`).toBe("string")
			expect(typeof label === "string" && label.trim().length > 0, `Empty English manifest label: ${key}`).toBe(
				true,
			)
		}
	})

	it("ships English extension strings without locale overlays", () => {
		const overlays = readdirSync(extensionRoot).filter((name) => /^package\.nls\..+\.json$/.test(name))
		expect(overlays).toEqual([])
		const languages = readdirSync(new URL("i18n/locales/", extensionRoot), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
		expect(languages).toEqual(["en"])
	})
})
