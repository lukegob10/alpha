import { readFileSync } from "node:fs"

type ExtensionManifest = {
	contributes: {
		commands: Array<{
			command: string
			icon?: string
			title?: string
		}>
	}
}

describe("extension command manifest", () => {
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
