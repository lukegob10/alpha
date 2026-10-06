import { readFileSync } from "node:fs"

type ExtensionManifest = {
	contributes: {
		commands: Array<{
			command: string
			icon?: string
			title?: string
		}>
		keybindings: Array<{ command: string; key: string; mac?: string; when?: string; args?: string }>
	}
}

describe("extension command manifest", () => {
	it("exposes Windows agent hotkeys in the focused webview without taking over Enter or Plan/Code switching", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as ExtensionManifest
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
		expect(manifest.contributes.keybindings.some((binding) => ["enter", "shift+tab"].includes(binding.key))).toBe(
			false,
		)
	})

	it("uses the Codicon pencil and New Chat label for the new chat action", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as ExtensionManifest
		const newChatCommand = manifest.contributes.commands.find(
			({ command }) => command === "alpha.plusButtonClicked",
		)
		const localization = JSON.parse(
			readFileSync(new URL("../../package.nls.json", import.meta.url), "utf8"),
		) as Record<string, string>

		expect(newChatCommand?.icon).toBe("$(edit)")
		expect(newChatCommand?.title).toBe("%command.newTask.title%")
		expect(localization["command.newTask.title"]).toBe("New Chat")
	})
})
