import { HTMLAttributes, useMemo, useRef } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { Checkbox } from "@vscode/webview-ui-toolkit"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"

interface UISettingsProps extends HTMLAttributes<HTMLDivElement> {
	reasoningBlockCollapsed: boolean
	enterBehavior: "send" | "newline"
	autoSteer: boolean
	embedded?: boolean
	unframed?: boolean
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const UISettings = ({
	reasoningBlockCollapsed,
	enterBehavior,
	autoSteer,
	embedded = false,
	unframed = false,
	setCachedStateField,
	...props
}: UISettingsProps) => {
	const { t } = useAppTranslation()
	const latestPreferences = useRef({ reasoningBlockCollapsed, enterBehavior, autoSteer })
	// Toolkit changes can fire while checked props are applied, before React replaces the old listener.
	latestPreferences.current = { reasoningBlockCollapsed, enterBehavior, autoSteer }

	// Detect platform for dynamic modifier key display
	const primaryMod = useMemo(() => {
		const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
		return isMac ? "⌘" : "Ctrl"
	}, [])

	const handleReasoningBlockCollapsedChange = (value: boolean) => {
		if (value === latestPreferences.current.reasoningBlockCollapsed) return
		setCachedStateField("reasoningBlockCollapsed", value)
	}

	const handleEnterBehaviorChange = (enterInsertsNewline: boolean) => {
		const newBehavior = enterInsertsNewline ? "newline" : "send"
		if (newBehavior === latestPreferences.current.enterBehavior) return
		setCachedStateField("enterBehavior", newBehavior)
	}

	const handleAutoSteerChange = (value: boolean) => {
		if (value !== latestPreferences.current.autoSteer) setCachedStateField("autoSteer", value)
	}
	const Frame = unframed ? "div" : Section

	return (
		<div {...props}>
			{!embedded && <SectionHeader>{t("settings:sections.preferences")}</SectionHeader>}

			<Frame>
				<div className="space-y-1">
					<SearchableSetting
						settingId="ui-collapse-thinking"
						section="preferences"
						label={t("settings:ui.collapseThinking.label")}>
						<div className="flex min-h-11 items-center justify-between gap-2">
							<VSCodeCheckbox
								checked={reasoningBlockCollapsed}
								onChange={(event) =>
									handleReasoningBlockCollapsedChange((event.target as Checkbox).checked)
								}
								data-testid="collapse-thinking-checkbox">
								<span className="font-medium">{t("settings:ui.collapseThinking.label")}</span>
							</VSCodeCheckbox>
							<SettingsHelp label={t("settings:ui.collapseThinking.label")}>
								{t("settings:ui.collapseThinking.description")}
							</SettingsHelp>
						</div>
					</SearchableSetting>

					<SearchableSetting
						settingId="ui-enter-behavior"
						section="preferences"
						label={t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}>
						<div className="flex min-h-11 items-center justify-between gap-2">
							<VSCodeCheckbox
								checked={enterBehavior === "newline"}
								onChange={(event) => handleEnterBehaviorChange((event.target as Checkbox).checked)}
								data-testid="enter-behavior-checkbox">
								<span className="font-medium">
									{t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}
								</span>
							</VSCodeCheckbox>
							<SettingsHelp label={t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}>
								{t("settings:ui.requireCtrlEnterToSend.description", { primaryMod })}
							</SettingsHelp>
						</div>
					</SearchableSetting>

					<SearchableSetting
						settingId="ui-auto-steer"
						section="preferences"
						label={t("settings:ui.autoSteer.label")}>
						<div className="flex min-h-11 items-center justify-between gap-2">
							<VSCodeCheckbox
								checked={autoSteer}
								onChange={(event) => handleAutoSteerChange((event.target as Checkbox).checked)}
								data-testid="auto-steer-checkbox">
								<span className="font-medium">{t("settings:ui.autoSteer.label")}</span>
							</VSCodeCheckbox>
							<SettingsHelp label={t("settings:ui.autoSteer.label")}>
								{t("settings:ui.autoSteer.description")}
							</SettingsHelp>
						</div>
					</SearchableSetting>
				</div>
			</Frame>
		</div>
	)
}
