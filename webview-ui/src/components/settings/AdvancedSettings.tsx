import type { HTMLAttributes } from "react"

import { DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT, DEFAULT_WRITE_DELAY_MS } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"

import { CheckpointSettings } from "./CheckpointSettings"
import { ContextManagementSettings } from "./ContextManagementSettings"
import { DebugSettings } from "./DebugSettings"
import type { SettingsCachedState, SetSettingsCachedStateField } from "./managed-agent-settings"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"

export type AdvancedSettingsValues = Pick<
	SettingsCachedState,
	| "autoCondenseContext"
	| "autoCondenseContextPercent"
	| "autoCondenseContextScope"
	| "postTurnCondenseContextPercent"
	| "maxOpenTabsContext"
	| "maxWorkspaceFiles"
	| "showAlphaIgnoredFiles"
	| "enableSubfolderRules"
	| "maxImageFileSize"
	| "maxTotalImageSize"
	| "includeDiagnosticMessages"
	| "maxDiagnosticMessages"
	| "writeDelayMs"
	| "includeCurrentTime"
	| "includeCurrentCost"
	| "maxGitStatusFiles"
	| "customSupportPrompts"
	| "enableCheckpoints"
	| "checkpointTimeout"
	| "debug"
>

export interface AdvancedSettingsProps extends HTMLAttributes<HTMLDivElement> {
	values: AdvancedSettingsValues
	setCachedStateField: SetSettingsCachedStateField
	setCustomSupportPrompts?: (prompts: Record<string, string | undefined>) => void
	setDebug?: (debug: boolean) => void
	embedded?: boolean
}

export const AdvancedSettings = ({
	values,
	setCachedStateField,
	setCustomSupportPrompts,
	setDebug,
	embedded = false,
	className,
	...props
}: AdvancedSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-col", className)} {...props}>
			{!embedded && <SectionHeader>{t("settings:sections.advanced")}</SectionHeader>}

			<Section grouped className="gap-6" data-settings-page-card="advanced">
				<div className="min-w-0" data-settings-group="context">
					<h4 className="m-0 mb-3 text-base font-semibold text-vscode-foreground">
						{t("settings:advanced.context")}
					</h4>
					<ContextManagementSettings
						embedded
						section="advanced"
						autoCondenseContext={values.autoCondenseContext}
						autoCondenseContextPercent={values.autoCondenseContextPercent}
						autoCondenseContextScope={values.autoCondenseContextScope}
						postTurnCondenseContextPercent={
							values.postTurnCondenseContextPercent ?? DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT
						}
						maxOpenTabsContext={values.maxOpenTabsContext ?? 20}
						maxWorkspaceFiles={values.maxWorkspaceFiles ?? 200}
						showAlphaIgnoredFiles={values.showAlphaIgnoredFiles}
						enableSubfolderRules={values.enableSubfolderRules}
						maxImageFileSize={values.maxImageFileSize}
						maxTotalImageSize={values.maxTotalImageSize}
						includeDiagnosticMessages={values.includeDiagnosticMessages}
						maxDiagnosticMessages={values.maxDiagnosticMessages}
						writeDelayMs={values.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS}
						includeCurrentTime={values.includeCurrentTime}
						includeCurrentCost={values.includeCurrentCost}
						maxGitStatusFiles={values.maxGitStatusFiles}
						customSupportPrompts={values.customSupportPrompts ?? {}}
						setCustomSupportPrompts={
							setCustomSupportPrompts ??
							((prompts) => setCachedStateField("customSupportPrompts", prompts))
						}
						setCachedStateField={setCachedStateField}
					/>
				</div>

				<div className="min-w-0 border-t border-[var(--border-subtle)] pt-6" data-settings-group="recovery">
					<h4 className="m-0 mb-3 text-base font-semibold text-vscode-foreground">
						{t("settings:advanced.recovery")}
					</h4>
					<CheckpointSettings
						embedded
						searchSection="advanced"
						enableCheckpoints={values.enableCheckpoints}
						checkpointTimeout={values.checkpointTimeout}
						setCachedStateField={setCachedStateField}
					/>
				</div>

				<div className="min-w-0 border-t border-[var(--border-subtle)] pt-6" data-settings-group="diagnostics">
					<h4 className="m-0 mb-3 text-base font-semibold text-vscode-foreground">
						{t("settings:advanced.diagnostics")}
					</h4>
					<DebugSettings
						debug={values.debug}
						setDebug={setDebug ?? ((debug) => setCachedStateField("debug", debug))}
					/>
				</div>
			</Section>
		</div>
	)
}
