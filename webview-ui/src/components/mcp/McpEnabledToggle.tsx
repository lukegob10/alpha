import { FormEvent } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@src/i18n/TranslationContext"

type McpEnabledToggleProps = {
	mcpEnabled: boolean
	onChange: (value: boolean) => void
}

const McpEnabledToggle = ({ mcpEnabled, onChange }: McpEnabledToggleProps) => {
	const { t } = useAppTranslation()

	const handleChange = (e: Event | FormEvent<HTMLElement>) => {
		const target = ("target" in e ? e.target : null) as HTMLInputElement | null

		if (!target) {
			return
		}

		onChange(target.checked)
	}

	return (
		<div style={{ marginBottom: "20px" }}>
			<VSCodeCheckbox checked={mcpEnabled} onChange={handleChange}>
				<span style={{ fontWeight: "500" }}>{t("mcp:enableToggle.title")}</span>
			</VSCodeCheckbox>
			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				{t("mcp:enableToggle.description")}
			</p>
		</div>
	)
}

export default McpEnabledToggle
