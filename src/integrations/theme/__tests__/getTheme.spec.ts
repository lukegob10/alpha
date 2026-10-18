import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { getTheme } from "../getTheme"

const host = vi.hoisted(() => ({
	colorTheme: "Default Dark Modern",
	extensionRoot: "",
	extensions: [] as Array<{
		extensionPath: string
		packageJSON: { contributes: { themes: Array<{ label: string; path: string }> } }
	}>,
}))

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => host.colorTheme }) },
	extensions: {
		get all() {
			return host.extensions
		},
		getExtension: () => ({ extensionUri: { fsPath: host.extensionRoot } }),
	},
}))

describe("getTheme", () => {
	let temporaryRoot: string

	beforeEach(async () => {
		host.colorTheme = "Default Dark Modern"
		host.extensionRoot = fileURLToPath(new URL("../../../", import.meta.url))
		host.extensions = []
		temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-theme-test-"))
		vi.spyOn(console, "log").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(temporaryRoot, { recursive: true, force: true })
	})

	async function writeTheme(relativePath: string, theme: unknown) {
		const themePath = path.join(temporaryRoot, relativePath)
		await fs.mkdir(path.dirname(themePath), { recursive: true })
		await fs.writeFile(themePath, JSON.stringify(theme))
		return themePath
	}

	function selectCustomTheme(relativePath = "themes/custom.json") {
		host.colorTheme = "Custom Test Theme"
		host.extensions = [
			{
				extensionPath: temporaryRoot,
				packageJSON: { contributes: { themes: [{ label: host.colorTheme, path: relativePath }] } },
			},
		]
	}

	it("loads the complete bundled include chain and keeps the selected theme's colors", async () => {
		const theme = await getTheme()

		expect(theme?.colors["editor.background"]).toBe("#1F1F1F")
		expect(theme?.colors["editor.foreground"]).toBe("#CCCCCC")
		expect(theme?.rules.some(({ token }: { token: string }) => token === "comment")).toBe(true)
		expect(theme?.rules.some(({ token }: { token: string }) => token === "entity.name.function")).toBe(true)
	})

	it("resolves custom includes relative to each theme and appends child token rules after inherited rules", async () => {
		await writeTheme("themes/base/colors.json", {
			colors: { "editor.background": "#111111", "editor.foreground": "#EEEEEE" },
			tokenColors: [{ scope: "keyword", settings: { foreground: "#111111" } }],
		})
		await writeTheme("themes/base/middle.json", {
			include: "./colors.json",
			colors: { "editor.background": "#222222" },
			tokenColors: [{ scope: "keyword", settings: { foreground: "#222222" } }],
		})
		await writeTheme("themes/custom.json", {
			include: "./base/middle.json",
			colors: { "editor.background": "#333333" },
			tokenColors: [{ scope: "keyword", settings: { foreground: "#333333" } }],
		})
		selectCustomTheme()

		const theme = await getTheme()

		expect(theme?.colors).toEqual({ "editor.background": "#333333", "editor.foreground": "#EEEEEE" })
		expect(
			theme?.rules
				.filter(({ token }: { token: string }) => token === "keyword")
				.map(({ foreground }: { foreground?: string }) => foreground),
		).toEqual(["#111111", "#222222", "#333333"])
	})

	it("does not let the converter mutate shared parsed token rules", async () => {
		const base = Object.freeze({
			colors: Object.freeze({ "editor.background": "#111111" }),
			tokenColors: Object.freeze([
				Object.freeze({ scope: "keyword, storage", settings: Object.freeze({ foreground: "#ABCDEF" }) }),
			]),
		})
		const baseText = JSON.stringify(base)
		await writeTheme("themes/base.json", base)
		await writeTheme("themes/custom.json", { include: "./base.json" })
		selectCustomTheme()
		const originalParse = JSON.parse
		vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
			text === baseText ? base : originalParse(text, reviver),
		)

		const theme = await getTheme()

		expect(theme?.rules.map(({ token }: { token: string }) => token)).toEqual(["keyword", " storage"])
		expect(base.tokenColors[0].scope).toBe("keyword, storage")
	})

	it("rejects include cycles without following them repeatedly", async () => {
		await writeTheme("themes/custom.json", { include: "./base.json" })
		await writeTheme("themes/base.json", { include: "./custom.json" })
		selectCustomTheme()

		await expect(getTheme()).resolves.toBeUndefined()
		expect(console.log).toHaveBeenCalledWith(
			"Error loading color theme: ",
			expect.objectContaining({
				message: expect.stringContaining("Circular theme include"),
			}),
		)
	})

	it("retains an undefined result for unknown themes", async () => {
		host.colorTheme = "Unavailable Theme"
		await expect(getTheme()).resolves.toBeUndefined()
	})

	it("retains an undefined result for malformed theme JSON", async () => {
		const themePath = await writeTheme("themes/custom.json", {})
		await fs.writeFile(themePath, "{ broken")
		selectCustomTheme()
		await expect(getTheme()).resolves.toBeUndefined()
	})

	it.each([null, [], { include: 42 }, { colors: [] }, { tokenColors: "invalid" }])(
		"retains an undefined result for malformed theme data %j",
		async (theme) => {
			await writeTheme("themes/custom.json", theme)
			selectCustomTheme()
			await expect(getTheme()).resolves.toBeUndefined()
		},
	)

	it("uses the bundled default when the editor has no configured theme", async () => {
		host.colorTheme = ""
		const theme = await getTheme()
		expect(theme?.colors["editor.background"]).toBe("#1F1F1F")
	})

	it("retains an undefined result when an included theme is missing", async () => {
		await writeTheme("themes/custom.json", { include: "./missing.json" })
		selectCustomTheme()
		await expect(getTheme()).resolves.toBeUndefined()
	})
})
