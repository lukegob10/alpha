import type { LanguageModelChatSelector } from "vscode"

export const SELECTOR_SEPARATOR = "/"

export function stringifyVsCodeLmModelSelector(selector: LanguageModelChatSelector): string {
	return [selector.vendor, selector.family, selector.version, selector.id].filter(Boolean).join(SELECTOR_SEPARATOR)
}

export function parseVsCodeLmModelSelector(value: string): LanguageModelChatSelector {
	const [vendor, family, version, id] = value.split(SELECTOR_SEPARATOR)
	return {
		...(vendor ? { vendor } : {}),
		...(family ? { family } : {}),
		...(version ? { version } : {}),
		...(id ? { id } : {}),
	}
}
