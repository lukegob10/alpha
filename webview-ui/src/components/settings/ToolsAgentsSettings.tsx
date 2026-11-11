import { useState } from "react"

import { EXPERIMENT_IDS } from "@alpha/experiments"
import { useAppTranslation } from "@/i18n/TranslationContext"

import McpView from "../mcp/McpView"
import { AgentsSettings } from "./AgentsSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"
import type { SettingsCachedState, SetSettingsCachedStateField } from "./managed-agent-settings"
import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SettingsHelp } from "./SettingsHelp"
import { SkillsSettings } from "./SkillsSettings"
import type { SetExperimentEnabled } from "./types"

interface ToolsAgentsSettingsProps {
	values: SettingsCachedState
	setCachedStateField: SetSettingsCachedStateField
	setExperimentEnabled: SetExperimentEnabled
	isActive: boolean
	committedCustomToolsEnabled: boolean
	embedded?: boolean
}

export function ToolsAgentsSettings({
	values,
	setCachedStateField,
	setExperimentEnabled,
	isActive,
	committedCustomToolsEnabled,
	embedded = false,
}: ToolsAgentsSettingsProps) {
	const { t } = useAppTranslation()
	const [advancedOpen, setAdvancedOpen] = useState(false)

	return (
		<div>
			{!embedded && (
				<SectionHeader>
					<span className="flex items-center gap-2">
						{t("settings:sections.tools")}
						<SettingsHelp label={t("settings:sections.tools")}>
							<p className="m-0">{t("settings:tools.managementDescription")}</p>
						</SettingsHelp>
					</span>
				</SectionHeader>
			)}

			<Section grouped className="gap-6" data-settings-page-card="tools">
				<SkillsSettings
					embedded
					searchSectionId="tools"
					disabledBuiltinSkills={values.disabledBuiltinSkills ?? []}
					onDisabledBuiltinSkillsChange={(names) => setCachedStateField("disabledBuiltinSkills", names)}
				/>
				<SearchableSetting
					settingId="agents-settings"
					section="tools"
					label={t("agents:title")}
					className="border-t border-[var(--border-subtle)] pt-6">
					<AgentsSettings embedded values={values} setCachedStateField={setCachedStateField} />
				</SearchableSetting>
				<SearchableSetting
					settingId="mcp-management"
					section="tools"
					label={t("mcp:title")}
					className="border-t border-[var(--border-subtle)] pt-6">
					<McpView
						embedded
						mcpEnabled={values.mcpEnabled ?? true}
						onMcpEnabledChange={(enabled) => setCachedStateField("mcpEnabled", enabled)}
						alwaysAllowMcp={values.alwaysAllowMcp === true}
						onAlwaysAllowMcpChange={(enabled) => setCachedStateField("alwaysAllowMcp", enabled)}
						approvalMode={values.approvalMode}
					/>
				</SearchableSetting>

				<div className="border-t border-[var(--border-subtle)] pt-6">
					<details
						data-settings-advanced
						open={advancedOpen}
						onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
						<summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-vscode-focusBorder">
							{t("settings:tools.advanced")}
						</summary>
						<div className="mt-4 space-y-4">
							<SearchableSetting
								settingId="custom-tools-management"
								section="tools"
								label={t("settings:customTools.name")}>
								<CustomToolsSettings
									enabled={values.experiments?.[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
									committedEnabled={committedCustomToolsEnabled}
									isActive={isActive && advancedOpen}
									onChange={(enabled) => setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)}
								/>
							</SearchableSetting>
						</div>
					</details>
				</div>
			</Section>
		</div>
	)
}
