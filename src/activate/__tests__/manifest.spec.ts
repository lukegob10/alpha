import { readFileSync, readdirSync } from "node:fs"

type ExtensionManifest = {
	contributes: {
		commands: Array<{
			command: string
			icon?: string
			title?: string
		}>
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
	it("uses the Codicon pencil and New Chat label for the new chat action", () => {
		const newChatCommand = manifest.contributes.commands.find(
			({ command }) => command === "alpha.plusButtonClicked",
		)
		expect(newChatCommand?.icon).toBe("$(edit)")
		expect(newChatCommand?.title).toBe("%command.newTask.title%")
		expect(localization["command.newTask.title"]).toBe("New Chat")
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
