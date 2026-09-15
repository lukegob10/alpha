import { HTMLAttributes, useCallback } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useEvent, useMount } from "react-use"

import { type ExtensionMessage, type TerminalOutputPreviewSize } from "@alpha-code/types"

import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"

import type { SettingsCachedState } from "./managed-agent-settings"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type TerminalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	terminalOutputPreviewSize?: TerminalOutputPreviewSize
	terminalShellIntegrationTimeout?: number
	terminalShellIntegrationDisabled?: boolean
	terminalCommandDelay?: number
	terminalPowershellCounter?: boolean
	terminalZshClearEolMark?: boolean
	terminalZshOhMy?: boolean
	terminalZshP10k?: boolean
	terminalZdotdir?: boolean
	terminalInheritEnv?: boolean
	onTerminalInheritEnvLoaded: (value: boolean) => void
	setCachedStateField: <
		K extends
			| "terminalOutputPreviewSize"
			| "terminalShellIntegrationTimeout"
			| "terminalShellIntegrationDisabled"
			| "terminalCommandDelay"
			| "terminalPowershellCounter"
			| "terminalZshClearEolMark"
			| "terminalZshOhMy"
			| "terminalZshP10k"
			| "terminalZdotdir"
			| "terminalInheritEnv",
	>(
		field: K,
		value: SettingsCachedState[K],
	) => void
}

export const TerminalSettings = ({
	terminalOutputPreviewSize,
	onTerminalInheritEnvLoaded,
	setCachedStateField,
	className,
}: TerminalSettingsProps) => {
	const { t } = useAppTranslation()

	useMount(() => vscode.postMessage({ type: "getVSCodeSetting", setting: "terminal.integrated.inheritEnv" }))

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			switch (message.type) {
				case "vsCodeSetting":
					switch (message.setting) {
						case "terminal.integrated.inheritEnv":
							onTerminalInheritEnvLoaded(message.value ?? true)
							break
						default:
							break
					}
					break
				default:
					break
			}
		},
		[onTerminalInheritEnvLoaded],
	)

	useEvent("message", onMessage)

	return (
		<div className={cn("flex flex-col", className)}>
			<SectionHeader>{t("settings:sections.terminal")}</SectionHeader>

			<Section>
				{/* Basic Settings */}
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2 font-bold">
							<span className="codicon codicon-settings-gear" />
							<div>{t("settings:terminal.basic.label")}</div>
						</div>
					</div>
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="terminal-output-preview-size"
							section="terminal"
							label={t("settings:terminal.outputPreviewSize.label")}>
							<label className="block font-medium mb-1">
								{t("settings:terminal.outputPreviewSize.label")}
							</label>
							<Select
								value={terminalOutputPreviewSize || "medium"}
								onValueChange={(value) =>
									setCachedStateField("terminalOutputPreviewSize", value as TerminalOutputPreviewSize)
								}>
								<SelectTrigger className="w-full" data-testid="terminal-output-preview-size-dropdown">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="small">
										{t("settings:terminal.outputPreviewSize.options.small")}
									</SelectItem>
									<SelectItem value="medium">
										{t("settings:terminal.outputPreviewSize.options.medium")}
									</SelectItem>
									<SelectItem value="large">
										{t("settings:terminal.outputPreviewSize.options.large")}
									</SelectItem>
								</SelectContent>
							</Select>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:terminal.outputPreviewSize.description")}
							</div>
						</SearchableSetting>
					</div>
				</div>

				<SearchableSetting
					settingId="terminal-shell-integration-disabled"
					section="terminal"
					label={t("settings:terminal.shellIntegrationDisabled.label")}>
					<div className="font-medium">{t("settings:terminal.shellIntegrationDisabled.label")}</div>
					<p className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:terminal.shellIntegrationDisabled.description")}
					</p>
				</SearchableSetting>
			</Section>
		</div>
	)
}
