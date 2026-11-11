import type { ExtensionState } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { AutoApproveSettings } from "./AutoApproveSettings"
import { MemorySettings } from "./MemorySettings"
import { NotificationSettings } from "./NotificationSettings"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { UISettings } from "./UISettings"
import type { SettingsCachedState, SetSettingsCachedStateField } from "./managed-agent-settings"

export type PreferencesSettingsValues = Pick<
	SettingsCachedState,
	| "approvalMode"
	| "approvalModeBypassAcknowledged"
	| "alwaysAllowReadOnly"
	| "alwaysAllowReadOnlyOutsideWorkspace"
	| "alwaysAllowWrite"
	| "alwaysAllowWriteOutsideWorkspace"
	| "alwaysAllowWriteProtected"
	| "alwaysAllowMcp"
	| "alwaysAllowSubagents"
	| "alwaysAllowTickets"
	| "alwaysAllowExecute"
	| "autoApprovalEnabled"
	| "followupAutoApproveTimeoutMs"
	| "allowedCommands"
	| "deniedCommands"
	| "reasoningBlockCollapsed"
	| "enterBehavior"
	| "autoSteer"
	| "soundEnabled"
	| "soundVolume"
	| "memorySettings"
>

export interface PreferencesSettingsProps {
	values: PreferencesSettingsValues
	setCachedStateField: SetSettingsCachedStateField
	inheritedCommandRules?: NonNullable<ExtensionState["commandRuleSettings"]>["inherited"]
	embedded?: boolean
}

export const PreferencesSettings = ({
	values,
	setCachedStateField,
	inheritedCommandRules,
	embedded = false,
}: PreferencesSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div className="flex flex-col gap-2">
			{!embedded && <SectionHeader>{t("settings:sections.preferences")}</SectionHeader>}
			<Section grouped className="gap-6" data-settings-page-card="preferences">
				<div data-settings-group="permissions">
					<AutoApproveSettings
						embedded
						section="preferences"
						approvalMode={values.approvalMode}
						approvalModeBypassAcknowledged={values.approvalModeBypassAcknowledged}
						alwaysAllowReadOnly={values.alwaysAllowReadOnly}
						alwaysAllowReadOnlyOutsideWorkspace={values.alwaysAllowReadOnlyOutsideWorkspace}
						alwaysAllowWrite={values.alwaysAllowWrite}
						alwaysAllowWriteOutsideWorkspace={values.alwaysAllowWriteOutsideWorkspace}
						alwaysAllowWriteProtected={values.alwaysAllowWriteProtected}
						alwaysAllowMcp={values.alwaysAllowMcp}
						alwaysAllowSubagents={values.alwaysAllowSubagents}
						alwaysAllowTickets={values.alwaysAllowTickets ?? false}
						alwaysAllowExecute={values.alwaysAllowExecute}
						autoApprovalEnabled={values.autoApprovalEnabled}
						followupAutoApproveTimeoutMs={values.followupAutoApproveTimeoutMs}
						allowedCommands={values.allowedCommands}
						deniedCommands={values.deniedCommands}
						inheritedCommandRules={inheritedCommandRules}
						setCachedStateField={setCachedStateField}
					/>
				</div>
				<div data-settings-group="chat-and-sound" className="border-t border-[var(--border-subtle)] pt-6">
					<h4 className="m-0 mb-3 text-base font-semibold text-vscode-foreground">
						{t("settings:preferences.chatAndSound")}
					</h4>
					<div className="space-y-1">
						<UISettings
							embedded
							unframed
							reasoningBlockCollapsed={values.reasoningBlockCollapsed ?? true}
							enterBehavior={values.enterBehavior ?? "send"}
							autoSteer={values.autoSteer === true}
							setCachedStateField={setCachedStateField}
						/>
						<NotificationSettings
							embedded
							unframed
							soundEnabled={values.soundEnabled ?? false}
							soundVolume={values.soundVolume ?? 0.5}
							setCachedStateField={setCachedStateField}
						/>
					</div>
				</div>
				<div data-settings-group="memories" className="border-t border-[var(--border-subtle)] pt-6">
					<h4 className="m-0 mb-3 text-base font-semibold text-vscode-foreground">
						{t("settings:preferences.memories")}
					</h4>
					<MemorySettings
						embedded
						unframed
						section="preferences"
						memorySettings={values.memorySettings}
						onChange={(memorySettings) => setCachedStateField("memorySettings", memorySettings)}
					/>
				</div>
			</Section>
		</div>
	)
}
