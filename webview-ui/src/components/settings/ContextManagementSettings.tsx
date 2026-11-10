import { HTMLAttributes } from "react"
import React from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"

import { DEFAULT_CONDENSING_PROMPT } from "@alpha/condense-prompt"
import { DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT, type AutoCondenseContextScope } from "@alpha-code/types"

import { cn } from "@/lib/utils"
import {
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
	Button,
	StandardTooltip,
} from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section, useSectionGroup } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import type { SectionName } from "./SettingsView"

// Environment snapshots bound each path list to 200 entries.
const MAX_CONTEXT_PATHS = 200
const contextPathLimit = (value: number | undefined, fallback: number) =>
	typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(MAX_CONTEXT_PATHS, Math.floor(value)))
		: fallback

function ContextSettingLabel({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="font-medium">{label}</span>
			<SettingsHelp label={label}>{children}</SettingsHelp>
		</div>
	)
}

type ContextManagementSettingsProps = HTMLAttributes<HTMLDivElement> & {
	embedded?: boolean
	section?: SectionName
	autoCondenseContext: boolean
	autoCondenseContextPercent?: number
	autoCondenseContextScope?: AutoCondenseContextScope
	postTurnCondenseContextPercent?: number
	maxOpenTabsContext: number
	maxWorkspaceFiles: number
	showAlphaIgnoredFiles?: boolean
	enableSubfolderRules?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	writeDelayMs: number
	includeCurrentTime?: boolean
	includeCurrentCost?: boolean
	maxGitStatusFiles?: number
	customSupportPrompts: Record<string, string | undefined>
	setCustomSupportPrompts: (prompts: Record<string, string | undefined>) => void
	setCachedStateField: SetCachedStateField<
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
	>
}

export const ContextManagementSettings = ({
	embedded = false,
	section = "advanced",
	autoCondenseContext,
	autoCondenseContextPercent = 100,
	autoCondenseContextScope = "full-context",
	postTurnCondenseContextPercent = DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
	maxOpenTabsContext,
	maxWorkspaceFiles,
	showAlphaIgnoredFiles,
	enableSubfolderRules,
	setCachedStateField,
	maxImageFileSize,
	maxTotalImageSize,
	includeDiagnosticMessages,
	maxDiagnosticMessages,
	writeDelayMs,
	includeCurrentTime,
	includeCurrentCost,
	maxGitStatusFiles,
	customSupportPrompts,
	setCustomSupportPrompts,
	className,
	...props
}: ContextManagementSettingsProps) => {
	const { t } = useAppTranslation()
	const grouped = useSectionGroup()
	const openTabsLimit = contextPathLimit(maxOpenTabsContext, 20)
	const workspaceFilesLimit = contextPathLimit(maxWorkspaceFiles, 200)

	// Helper function to get the CONDENSE prompt value
	const getCondensePromptValue = (): string => {
		return customSupportPrompts.CONDENSE ?? DEFAULT_CONDENSING_PROMPT
	}

	// Helper function to update the CONDENSE prompt
	const updateCondensePrompt = (value: string | undefined) => {
		const updatedPrompts = { ...customSupportPrompts }
		if (value === undefined) {
			delete updatedPrompts["CONDENSE"]
		} else {
			updatedPrompts["CONDENSE"] = value
		}
		setCustomSupportPrompts(updatedPrompts)
	}

	// Helper function to reset the CONDENSE prompt to default
	const handleCondenseReset = () => {
		const updatedPrompts = { ...customSupportPrompts }
		delete updatedPrompts["CONDENSE"]
		setCustomSupportPrompts(updatedPrompts)
	}

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			{!grouped &&
				(embedded ? (
					<div className="mx-5 mb-2 flex items-center gap-2">
						<h4 className="m-0 text-base font-semibold">{t("settings:sections.contextManagement")}</h4>
						<SettingsHelp label={t("settings:sections.contextManagement")}>
							{t("settings:contextManagement.description")}
						</SettingsHelp>
					</div>
				) : (
					<SectionHeader>{t("settings:sections.contextManagement")}</SectionHeader>
				))}

			<Section>
				<SearchableSetting
					settingId="context-open-tabs"
					section={section}
					label={t("settings:contextManagement.openTabs.label")}>
					<ContextSettingLabel label={t("settings:contextManagement.openTabs.label")}>
						{t("settings:contextManagement.openTabs.description")}
					</ContextSettingLabel>
					<div className="flex items-center gap-2">
						<Slider
							aria-label={t("settings:contextManagement.openTabs.label")}
							min={0}
							max={MAX_CONTEXT_PATHS}
							step={1}
							value={[openTabsLimit]}
							onValueChange={([value]) => setCachedStateField("maxOpenTabsContext", value)}
							data-testid="open-tabs-limit-slider"
						/>
						<span className="w-10">{openTabsLimit}</span>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-workspace-files"
					section={section}
					label={t("settings:contextManagement.workspaceFiles.label")}>
					<ContextSettingLabel label={t("settings:contextManagement.workspaceFiles.label")}>
						{t("settings:contextManagement.workspaceFiles.description")}
					</ContextSettingLabel>
					<div className="flex items-center gap-2">
						<Slider
							aria-label={t("settings:contextManagement.workspaceFiles.label")}
							min={0}
							max={MAX_CONTEXT_PATHS}
							step={1}
							value={[workspaceFilesLimit]}
							onValueChange={([value]) => setCachedStateField("maxWorkspaceFiles", value)}
							data-testid="workspace-files-limit-slider"
						/>
						<span className="w-10">{workspaceFilesLimit}</span>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-git-status-files"
					section={section}
					label={t("settings:contextManagement.maxGitStatusFiles.label")}>
					<ContextSettingLabel label={t("settings:contextManagement.maxGitStatusFiles.label")}>
						{t("settings:contextManagement.maxGitStatusFiles.description")}
					</ContextSettingLabel>
					<div className="flex items-center gap-2">
						<Slider
							aria-label={t("settings:contextManagement.maxGitStatusFiles.label")}
							min={0}
							max={50}
							step={1}
							value={[maxGitStatusFiles ?? 0]}
							onValueChange={([value]) => setCachedStateField("maxGitStatusFiles", value)}
							data-testid="max-git-status-files-slider"
						/>
						<span className="w-10">{maxGitStatusFiles ?? 0}</span>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-show-alphaignored-files"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.alphaignore.label")}>
					<VSCodeCheckbox
						checked={showAlphaIgnoredFiles}
						onChange={(e: any) => setCachedStateField("showAlphaIgnoredFiles", e.target.checked)}
						data-testid="show-alphaignored-files-checkbox">
						<span className="font-medium">{t("settings:contextManagement.alphaignore.label")}</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.alphaignore.label")}>
						{t("settings:contextManagement.alphaignore.description")}
					</SettingsHelp>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-enable-subfolder-rules"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.enableSubfolderRules.label")}>
					<VSCodeCheckbox
						checked={enableSubfolderRules}
						onChange={(e: any) => setCachedStateField("enableSubfolderRules", e.target.checked)}
						data-testid="enable-subfolder-rules-checkbox">
						<span className="font-medium">
							{t("settings:contextManagement.enableSubfolderRules.label")}
						</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.enableSubfolderRules.label")}>
						{t("settings:contextManagement.enableSubfolderRules.description")}
					</SettingsHelp>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-image-file-size"
					section={section}
					label={t("settings:contextManagement.maxImageFileSize.label")}>
					<div className="flex flex-col gap-2">
						<ContextSettingLabel label={t("settings:contextManagement.maxImageFileSize.label")}>
							{t("settings:contextManagement.maxImageFileSize.description")}
						</ContextSettingLabel>
						<div className="flex items-center gap-4">
							<Input
								aria-label={t("settings:contextManagement.maxImageFileSize.label")}
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxImageFileSize ?? 5}
								min={1}
								max={100}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 100) {
										setCachedStateField("maxImageFileSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-image-file-size-input"
							/>
							<span>{t("settings:contextManagement.maxImageFileSize.mb")}</span>
						</div>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-total-image-size"
					section={section}
					label={t("settings:contextManagement.maxTotalImageSize.label")}>
					<div className="flex flex-col gap-2">
						<ContextSettingLabel label={t("settings:contextManagement.maxTotalImageSize.label")}>
							{t("settings:contextManagement.maxTotalImageSize.description")}
						</ContextSettingLabel>
						<div className="flex items-center gap-4">
							<Input
								aria-label={t("settings:contextManagement.maxTotalImageSize.label")}
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxTotalImageSize ?? 20}
								min={1}
								max={500}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 500) {
										setCachedStateField("maxTotalImageSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-total-image-size-input"
							/>
							<span>{t("settings:contextManagement.maxTotalImageSize.mb")}</span>
						</div>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-diagnostic-messages"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.diagnostics.includeMessages.label")}>
					<VSCodeCheckbox
						checked={includeDiagnosticMessages}
						onChange={(e: any) => setCachedStateField("includeDiagnosticMessages", e.target.checked)}
						data-testid="include-diagnostic-messages-checkbox">
						<span className="font-medium">
							{t("settings:contextManagement.diagnostics.includeMessages.label")}
						</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.diagnostics.includeMessages.label")}>
						{t("settings:contextManagement.diagnostics.includeMessages.description")}
					</SettingsHelp>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-diagnostic-messages"
					section={section}
					label={t("settings:contextManagement.diagnostics.maxMessages.label")}>
					<ContextSettingLabel label={t("settings:contextManagement.diagnostics.maxMessages.label")}>
						{t("settings:contextManagement.diagnostics.maxMessages.description")}
					</ContextSettingLabel>
					<div className="flex items-center gap-2">
						<Slider
							min={1}
							max={100}
							step={1}
							value={[
								maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
									? 100
									: (maxDiagnosticMessages ?? 50),
							]}
							onValueChange={([value]) => {
								// When slider reaches 100, set to -1 (unlimited)
								setCachedStateField("maxDiagnosticMessages", value === 100 ? -1 : value)
							}}
							data-testid="max-diagnostic-messages-slider"
							aria-label={t("settings:contextManagement.diagnostics.maxMessages.label")}
							aria-valuemin={1}
							aria-valuemax={100}
							aria-valuenow={
								maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
									? 100
									: (maxDiagnosticMessages ?? 50)
							}
							aria-valuetext={
								maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
									? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
									: `${maxDiagnosticMessages ?? 50} ${t("settings:contextManagement.diagnostics.maxMessages.label")}`
							}
						/>
						<span className="w-20 text-sm font-medium">
							{maxDiagnosticMessages !== undefined && maxDiagnosticMessages <= 0
								? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
								: (maxDiagnosticMessages ?? 50)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCachedStateField("maxDiagnosticMessages", 50)}
							title={t("settings:contextManagement.diagnostics.maxMessages.resetTooltip")}
							className="p-1 h-6 w-6"
							disabled={maxDiagnosticMessages === 50}>
							<span className="codicon codicon-discard" />
						</Button>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-write-delay"
					section={section}
					label={t("settings:contextManagement.diagnostics.delayAfterWrite.label")}>
					<ContextSettingLabel label={t("settings:contextManagement.diagnostics.delayAfterWrite.label")}>
						{t("settings:contextManagement.diagnostics.delayAfterWrite.description")}
					</ContextSettingLabel>
					<div className="flex items-center gap-2">
						<Slider
							aria-label={t("settings:contextManagement.diagnostics.delayAfterWrite.label")}
							min={0}
							max={5000}
							step={100}
							value={[writeDelayMs]}
							onValueChange={([value]) => setCachedStateField("writeDelayMs", value)}
							data-testid="write-delay-slider"
						/>
						<span className="w-20">{writeDelayMs}ms</span>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-time"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.includeCurrentTime.label")}>
					<VSCodeCheckbox
						checked={includeCurrentTime}
						onChange={(e: any) => setCachedStateField("includeCurrentTime", e.target.checked)}
						data-testid="include-current-time-checkbox">
						<span className="font-medium">{t("settings:contextManagement.includeCurrentTime.label")}</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.includeCurrentTime.label")}>
						{t("settings:contextManagement.includeCurrentTime.description")}
					</SettingsHelp>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-cost"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.includeCurrentCost.label")}>
					<VSCodeCheckbox
						checked={includeCurrentCost}
						onChange={(e: any) => setCachedStateField("includeCurrentCost", e.target.checked)}
						data-testid="include-current-cost-checkbox">
						<span className="font-medium">{t("settings:contextManagement.includeCurrentCost.label")}</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.includeCurrentCost.label")}>
						{t("settings:contextManagement.includeCurrentCost.description")}
					</SettingsHelp>
				</SearchableSetting>
			</Section>
			<Section className="pt-2">
				<details data-settings-advanced="condense-prompt">
					<summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-vscode-focusBorder">
						{t("prompts:supportPrompts.types.CONDENSE.label")}
					</summary>
					<SearchableSetting
						settingId="context-condense-prompt"
						section={section}
						label={t("prompts:supportPrompts.types.CONDENSE.label")}
						className="mt-3">
						<div className="mb-1 flex items-center justify-end gap-1">
							<SettingsHelp label={t("prompts:supportPrompts.types.CONDENSE.label")}>
								<p>{t("prompts:supportPrompts.types.CONDENSE.description")}</p>
								<p>{t("settings:contextManagement.customPromptNotice")}</p>
							</SettingsHelp>
							<StandardTooltip
								content={t("prompts:supportPrompts.resetPrompt", { promptType: "CONDENSE" })}>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("prompts:supportPrompts.resetPrompt", { promptType: "CONDENSE" })}
									onClick={handleCondenseReset}>
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						</div>
						<VSCodeTextArea
							aria-label={t("prompts:supportPrompts.types.CONDENSE.label")}
							resize="vertical"
							value={getCondensePromptValue()}
							onInput={(e) => {
								const value =
									(e as unknown as CustomEvent)?.detail?.target?.value ??
									((e as any).target as HTMLTextAreaElement).value
								updateCondensePrompt(value)
							}}
							rows={6}
							className="w-full"
							data-testid="condense-prompt-textarea"
						/>
					</SearchableSetting>
				</details>

				{/* Auto Condense Context */}
				<SearchableSetting
					settingId="context-auto-condense"
					section={section}
					className="flex items-center gap-2"
					label={t("settings:contextManagement.autoCondenseContext.name")}>
					<VSCodeCheckbox
						checked={autoCondenseContext}
						onChange={(e: any) => setCachedStateField("autoCondenseContext", e.target.checked)}
						data-testid="auto-condense-context-checkbox">
						<span className="font-medium">{t("settings:contextManagement.autoCondenseContext.name")}</span>
					</VSCodeCheckbox>
					<SettingsHelp label={t("settings:contextManagement.autoCondenseContext.name")}>
						{t("settings:contextManagement.autoCondenseContext.description")}
					</SettingsHelp>
				</SearchableSetting>
				{autoCondenseContext && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="context-condense-scope"
							section={section}
							label={t("settings:contextManagement.condensingScope.label")}>
							<ContextSettingLabel label={t("settings:contextManagement.condensingScope.label")}>
								{t("settings:contextManagement.condensingScope.description")}
							</ContextSettingLabel>
							<Select
								value={autoCondenseContextScope}
								onValueChange={(value) =>
									setCachedStateField("autoCondenseContextScope", value as AutoCondenseContextScope)
								}
								data-testid="condense-threshold-scope-select">
								<SelectTrigger
									className="w-full"
									aria-label={t("settings:contextManagement.condensingScope.label")}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="full-context">
										{t("settings:contextManagement.condensingScope.fullContext")}
									</SelectItem>
									<SelectItem value="after-prefix">
										{t("settings:contextManagement.condensingScope.afterPrefix")}
									</SelectItem>
								</SelectContent>
							</Select>
						</SearchableSetting>
						<SearchableSetting
							settingId="context-post-turn-condense"
							section={section}
							label={t("settings:contextManagement.postTurnCondense.label")}>
							<ContextSettingLabel label={t("settings:contextManagement.postTurnCondense.label")}>
								{t("settings:contextManagement.postTurnCondense.description")}
							</ContextSettingLabel>
							<div className="flex items-center gap-2">
								<Slider
									min={0}
									max={100}
									step={1}
									value={[postTurnCondenseContextPercent]}
									onValueChange={([value]) =>
										setCachedStateField("postTurnCondenseContextPercent", value)
									}
									data-testid="post-turn-condense-slider"
									aria-label={t("settings:contextManagement.postTurnCondense.label")}
								/>
								<span className="w-20">
									{postTurnCondenseContextPercent === 0
										? t("settings:contextManagement.postTurnCondense.off")
										: `${postTurnCondenseContextPercent}%`}
								</span>
							</div>
						</SearchableSetting>
						<SearchableSetting
							settingId="context-condense-threshold"
							section={section}
							label={t("settings:contextManagement.autoCondenseContextPercent.label")}>
							<ContextSettingLabel
								label={t("settings:contextManagement.autoCondenseContextPercent.label")}>
								{t("settings:contextManagement.autoCondenseContextPercent.description")}
							</ContextSettingLabel>
							<div className="flex items-center gap-2">
								<Slider
									min={5}
									max={100}
									step={1}
									value={[autoCondenseContextPercent]}
									onValueChange={([value]) =>
										setCachedStateField("autoCondenseContextPercent", value)
									}
									data-testid="condense-threshold-slider"
									aria-label={t("settings:contextManagement.autoCondenseContextPercent.label")}
								/>
								<span className="w-20" data-testid="condense-threshold-value">
									{autoCondenseContextPercent}%
								</span>
							</div>
						</SearchableSetting>
					</div>
				)}
			</Section>
		</div>
	)
}
