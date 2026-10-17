import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { convertTheme } from "monaco-vscode-textmate-theme-converter/lib/cjs"

import { Package } from "../../shared/package"

const defaultThemes: Record<string, string> = {
	"Default Dark Modern": "dark_modern",
	"Dark+": "dark_plus",
	"Default Dark+": "dark_plus",
	"Dark (Visual Studio)": "dark_vs",
	"Visual Studio Dark": "dark_vs",
	"Dark High Contrast": "hc_black",
	"Default High Contrast": "hc_black",
	"Light High Contrast": "hc_light",
	"Default High Contrast Light": "hc_light",
	"Default Light Modern": "light_modern",
	"Light+": "light_plus",
	"Default Light+": "light_plus",
	"Light (Visual Studio)": "light_vs",
	"Visual Studio Light": "light_vs",
}

type ThemeData = Parameters<typeof convertTheme>[0]
type ThemeFile = Partial<ThemeData> & { include?: string }

function parseThemeString(themeString: string): ThemeFile {
	themeString = themeString
		.split("\n")
		.filter((line) => {
			return !line.trim().startsWith("//")
		})
		.join("\n")
	const parsed: unknown = JSON.parse(themeString)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Color theme must be an object")
	}
	return parsed as ThemeFile
}

async function loadThemeFile(themePath: string, includedFiles = new Set<string>()): Promise<ThemeData> {
	const identity = await fs.realpath(themePath)
	if (includedFiles.has(identity)) throw new Error("Circular theme include")
	includedFiles.add(identity)

	const theme = parseThemeString(await fs.readFile(themePath, "utf-8"))
	if (theme.include !== undefined && typeof theme.include !== "string") {
		throw new Error("Color theme include must be a path")
	}
	if (
		theme.colors !== undefined &&
		(!theme.colors || typeof theme.colors !== "object" || Array.isArray(theme.colors))
	) {
		throw new Error("Color theme colors must be an object")
	}
	if (theme.tokenColors !== undefined && !Array.isArray(theme.tokenColors)) {
		throw new Error("Color theme token colors must be an array")
	}
	const base = theme.include
		? await loadThemeFile(path.resolve(path.dirname(themePath), theme.include), includedFiles)
		: undefined

	// VS Code 1.125.0 loads the base first, then applies child colors and token rules.
	return {
		...base,
		...theme,
		$schema: "vscode://schemas/color-theme",
		type: theme.type ?? base?.type ?? "dark",
		colors: { ...base?.colors, ...theme.colors },
		tokenColors: [...(base?.tokenColors ?? []), ...(theme.tokenColors ?? [])],
	}
}

export async function getTheme() {
	let themePath: string | undefined
	const colorTheme = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") || "Default Dark Modern"

	try {
		for (let i = vscode.extensions.all.length - 1; i >= 0; i--) {
			if (themePath) {
				break
			}
			const extension = vscode.extensions.all[i]
			if (extension.packageJSON?.contributes?.themes?.length > 0) {
				for (const theme of extension.packageJSON.contributes.themes) {
					if (theme.label === colorTheme) {
						themePath = path.join(extension.extensionPath, theme.path)
						break
					}
				}
			}
		}

		if (themePath === undefined && defaultThemes[colorTheme]) {
			const filename = `${defaultThemes[colorTheme]}.json`
			themePath = path.join(getExtensionUri().fsPath, "integrations", "theme", "default-themes", filename)
		}

		if (themePath === undefined) return undefined
		// The converter rewrites comma-separated scopes, so give it an owned copy.
		const converted = convertTheme(structuredClone(await loadThemeFile(themePath)))

		converted.base = ["vs", "hc-black"].includes(converted.base)
			? converted.base
			: colorTheme.includes("Light")
				? "vs"
				: "vs-dark"

		return converted
	} catch (e) {
		console.log("Error loading color theme: ", e)
	}
	return undefined
}

function getExtensionUri(): vscode.Uri {
	return vscode.extensions.getExtension(`${Package.publisher}.${Package.name}`)!.extensionUri
}
