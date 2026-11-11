import { HTMLAttributes, useId, useRef, useState } from "react"
import { X } from "lucide-react"
import { type ApprovalMode, type ExtensionState, migrateApprovalMode, settingsForApprovalMode } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Button, Input } from "@/components/ui"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import type { SectionName } from "./SettingsView"

type AutoApproveSettingsProps = HTMLAttributes<HTMLDivElement> & {
	embedded?: boolean
	section?: SectionName
	approvalMode?: ApprovalMode
	approvalModeBypassAcknowledged?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowMcp?: boolean
	autoApprovalEnabled?: boolean
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowTickets?: boolean
	alwaysAllowSubagents?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	followupAutoApproveTimeoutMs?: number
	allowedCommands?: string[]
	deniedCommands?: string[]
	inheritedCommandRules?: NonNullable<ExtensionState["commandRuleSettings"]>["inherited"]
	setCachedStateField: SetCachedStateField<
		| "approvalMode"
		| "approvalModeBypassAcknowledged"
		| "alwaysAllowReadOnly"
		| "alwaysAllowReadOnlyOutsideWorkspace"
		| "alwaysAllowWrite"
		| "alwaysAllowWriteOutsideWorkspace"
		| "alwaysAllowWriteProtected"
		| "alwaysAllowMcp"
		| "alwaysAllowSubtasks"
		| "alwaysAllowSubagents"
		| "alwaysAllowTickets"
		| "alwaysAllowExecute"
		| "alwaysAllowFollowupQuestions"
		| "followupAutoApproveTimeoutMs"
		| "autoApprovalEnabled"
		| "allowedCommands"
		| "deniedCommands"
	>
}

const MODES: ApprovalMode[] = ["ask", "auto", "bypass"]
const COMMAND_RULE_SOURCE_LABELS = {
	user: "settings:autoApprove.execute.inheritedSourceUser",
	workspace: "settings:autoApprove.execute.inheritedSourceWorkspace",
	workspaceFolder: "settings:autoApprove.execute.inheritedSourceWorkspaceFolder",
} as const

export const AutoApproveSettings = ({
	embedded = false,
	section = "preferences",
	approvalMode,
	approvalModeBypassAcknowledged,
	alwaysAllowWriteProtected,
	alwaysAllowMcp,
	autoApprovalEnabled,
	alwaysAllowReadOnly,
	alwaysAllowWrite,
	alwaysAllowWriteOutsideWorkspace,
	alwaysAllowExecute,
	alwaysAllowTickets,
	alwaysAllowSubagents,
	alwaysAllowReadOnlyOutsideWorkspace,
	followupAutoApproveTimeoutMs,
	allowedCommands,
	deniedCommands,
	inheritedCommandRules = [],
	setCachedStateField,
	...props
}: AutoApproveSettingsProps) => {
	const { t } = useAppTranslation()
	const [commandInput, setCommandInput] = useState("")
	const [deniedCommandInput, setDeniedCommandInput] = useState("")
	const [bypassWarningOpen, setBypassWarningOpen] = useState(false)
	const bypassButtonRef = useRef<HTMLButtonElement>(null)
	const allowedCommandInputId = useId()
	const deniedCommandInputId = useId()
	const mcpPolicyDescriptionId = useId()
	const questionWaitDescriptionId = useId()
	const questionTimeoutInputId = useId()
	const inheritedCommandRulesHeadingId = useId()
	const waitForAnswers =
		typeof followupAutoApproveTimeoutMs !== "number" ||
		!Number.isFinite(followupAutoApproveTimeoutMs) ||
		followupAutoApproveTimeoutMs <= 0 ||
		followupAutoApproveTimeoutMs > 2_147_483_647
	const mode = migrateApprovalMode({
		approvalMode,
		autoApprovalEnabled,
		alwaysAllowReadOnly,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowTickets,
		alwaysAllowSubagents,
		allowedCommands,
	})
	const mcpApprovalOverridden = mode === "bypass"
	const visibleInheritedCommandRules = inheritedCommandRules.filter(
		(rule) => rule.deniedCommands.length > 0 || (mode === "ask" && rule.allowedCommands.length > 0),
	)

	const applyMode = (next: ApprovalMode, acknowledged = approvalModeBypassAcknowledged === true) => {
		const settings = settingsForApprovalMode(next, {
			alwaysAllowWriteProtected: next === "auto" ? alwaysAllowWriteProtected === true : undefined,
			alwaysAllowMcp: next !== "bypass" ? alwaysAllowMcp === true : undefined,
			approvalModeBypassAcknowledged: next === "bypass" ? true : acknowledged,
		})
		for (const [field, value] of Object.entries(settings)) {
			setCachedStateField(field as keyof typeof settings, value as never)
		}
	}

	const selectMode = (next: ApprovalMode) => {
		if (next === "bypass" && approvalModeBypassAcknowledged !== true) {
			setBypassWarningOpen(true)
			return
		}
		applyMode(next)
	}

	const handleAddCommand = () => {
		const currentCommands = allowedCommands ?? []
		const command = commandInput.trim()
		if (command && !currentCommands.includes(command)) {
			setCachedStateField("allowedCommands", [...currentCommands, command])
			setCommandInput("")
		}
	}

	const handleAddDeniedCommand = () => {
		const currentCommands = deniedCommands ?? []
		const command = deniedCommandInput.trim()
		if (command && !currentCommands.includes(command)) {
			setCachedStateField("deniedCommands", [...currentCommands, command])
			setDeniedCommandInput("")
		}
	}

	return (
		<div {...props}>
			{!embedded && <SectionHeader>{t("settings:sections.permissions")}</SectionHeader>}

			<Section>
				{embedded && <h4 className="m-0 text-base font-semibold">{t("settings:preferences.permissions")}</h4>}
				<div className="space-y-4">
					<SearchableSetting
						settingId="auto-approve-mode"
						section={section}
						label={t("settings:autoApprove.mode.label")}>
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-1">
								<span className="font-medium">{t("settings:autoApprove.mode.label")}</span>
								<SettingsHelp label={t("settings:autoApprove.mode.label")}>
									<p className="m-0">{t("settings:autoApprove.mode.description")}</p>
									<dl className="m-0 space-y-3">
										{MODES.map((candidate) => (
											<div key={candidate}>
												<dt className="font-medium">
													{t(`settings:autoApprove.mode.${candidate}`)}
												</dt>
												<dd className="m-0">
													{t(`settings:autoApprove.mode.${candidate}Description`)}
												</dd>
											</div>
										))}
									</dl>
								</SettingsHelp>
							</div>
							<div className="flex flex-wrap gap-2">
								{MODES.map((candidate) => (
									<Button
										key={candidate}
										ref={candidate === "bypass" ? bypassButtonRef : undefined}
										variant={mode === candidate ? "primary" : "secondary"}
										onClick={() => selectMode(candidate)}
										aria-pressed={mode === candidate}
										data-testid={`approval-mode-${candidate}`}
										className="h-auto px-3 py-2">
										{t(`settings:autoApprove.mode.${candidate}`)}
									</Button>
								))}
							</div>
						</div>
					</SearchableSetting>
				</div>

				<details data-settings-advanced>
					<summary className="cursor-pointer font-medium">{t("settings:autoApprove.advanced")}</summary>
					<div className="mt-4 flex flex-col gap-4">
						{mode === "bypass" && (
							<SearchableSetting
								settingId="auto-approve-followup-questions"
								section={section}
								label={t("settings:autoApprove.followupQuestions.waitLabel")}>
								<div className="flex items-center gap-1">
									<VSCodeCheckbox
										checked={waitForAnswers}
										aria-describedby={questionWaitDescriptionId}
										onChange={(event) => {
											const target = event.target
											if (
												target !== null &&
												"checked" in target &&
												typeof target.checked === "boolean"
											) {
												setCachedStateField(
													"followupAutoApproveTimeoutMs",
													target.checked ? 0 : 60_000,
												)
											}
										}}
										data-testid="wait-for-question-answers-checkbox">
										<span className="font-medium">
											{t("settings:autoApprove.followupQuestions.waitLabel")}
										</span>
									</VSCodeCheckbox>
									<SettingsHelp label={t("settings:autoApprove.followupQuestions.waitLabel")}>
										{t("settings:autoApprove.followupQuestions.waitDescription")}
									</SettingsHelp>
								</div>
								<span id={questionWaitDescriptionId} hidden>
									{t("settings:autoApprove.followupQuestions.waitDescription")}
								</span>
								{!waitForAnswers && (
									<div className="mt-2">
										<label htmlFor={questionTimeoutInputId} className="block font-medium mb-1">
											{t("settings:autoApprove.followupQuestions.timeoutLabel")}
										</label>
										<Input
											id={questionTimeoutInputId}
											type="number"
											min={1}
											max={2_147_483}
											value={followupAutoApproveTimeoutMs / 1000}
											onChange={(event) => {
												const seconds = event.target.valueAsNumber
												if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 2_147_483) {
													setCachedStateField("followupAutoApproveTimeoutMs", seconds * 1000)
												}
											}}
										/>
									</div>
								)}
							</SearchableSetting>
						)}

						{mode === "auto" && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
								<SearchableSetting
									settingId="auto-approve-write-protected"
									section={section}
									label={t("settings:autoApprove.write.protected.label")}>
									<div className="flex items-center gap-1">
										<VSCodeCheckbox
											checked={alwaysAllowWriteProtected}
											onChange={(e: any) =>
												setCachedStateField("alwaysAllowWriteProtected", e.target.checked)
											}
											data-testid="always-allow-write-protected-checkbox">
											<span className="font-medium">
												{t("settings:autoApprove.write.protected.label")}
											</span>
										</VSCodeCheckbox>
										<SettingsHelp label={t("settings:autoApprove.write.protected.label")}>
											{t("settings:autoApprove.write.protected.description")}
										</SettingsHelp>
									</div>
								</SearchableSetting>
							</div>
						)}

						<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
							<SearchableSetting
								settingId="auto-approve-denied-commands"
								section={section}
								label={t("settings:autoApprove.execute.deniedCommands")}>
								<div className="flex items-center gap-1">
									<label
										htmlFor={deniedCommandInputId}
										className="block font-medium mb-1"
										data-testid="denied-commands-heading">
										{t("settings:autoApprove.execute.deniedCommands")}
									</label>
									<SettingsHelp label={t("settings:autoApprove.execute.deniedCommands")}>
										{t("settings:autoApprove.execute.deniedCommandsDescription")}
									</SettingsHelp>
								</div>
							</SearchableSetting>
							<div className="flex gap-2">
								<Input
									id={deniedCommandInputId}
									value={deniedCommandInput}
									onChange={(e: any) => setDeniedCommandInput(e.target.value)}
									onKeyDown={(e: any) => {
										if (e.key === "Enter") {
											e.preventDefault()
											handleAddDeniedCommand()
										}
									}}
									placeholder={t("settings:autoApprove.execute.deniedCommandPlaceholder")}
									className="grow"
									data-testid="denied-command-input"
								/>
								<Button
									className="h-8"
									onClick={handleAddDeniedCommand}
									data-testid="add-denied-command-button">
									{t("settings:autoApprove.execute.addButton")}
								</Button>
							</div>
							<div className="flex flex-wrap gap-2">
								{(deniedCommands ?? []).map((cmd, index) => (
									<Button
										key={index}
										variant="secondary"
										data-testid={`remove-denied-command-${index}`}
										onClick={() => {
											setCachedStateField(
												"deniedCommands",
												(deniedCommands ?? []).filter((_, i) => i !== index),
											)
										}}>
										<div className="flex flex-row items-center gap-1">
											<div>{cmd}</div>
											<X className="text-foreground scale-75" />
										</div>
									</Button>
								))}
							</div>

							{mode === "ask" && (
								<>
									<SearchableSetting
										settingId="auto-approve-allowed-commands"
										section={section}
										label={t("settings:autoApprove.execute.allowedCommands")}>
										<div className="flex items-center gap-1">
											<label
												htmlFor={allowedCommandInputId}
												className="block font-medium mb-1"
												data-testid="allowed-commands-heading">
												{t("settings:autoApprove.execute.allowedCommands")}
											</label>
											<SettingsHelp label={t("settings:autoApprove.execute.allowedCommands")}>
												{t("settings:autoApprove.execute.allowedCommandsDescription")}
											</SettingsHelp>
										</div>
									</SearchableSetting>
									<div className="flex gap-2">
										<Input
											id={allowedCommandInputId}
											value={commandInput}
											onChange={(e: any) => setCommandInput(e.target.value)}
											onKeyDown={(e: any) => {
												if (e.key === "Enter") {
													e.preventDefault()
													handleAddCommand()
												}
											}}
											placeholder={t("settings:autoApprove.execute.commandPlaceholder")}
											className="grow"
											data-testid="command-input"
										/>
										<Button
											className="h-8"
											onClick={handleAddCommand}
											data-testid="add-command-button">
											{t("settings:autoApprove.execute.addButton")}
										</Button>
									</div>
									<div className="flex flex-wrap gap-2">
										{(allowedCommands ?? []).map((cmd, index) => (
											<Button
												key={index}
												variant="secondary"
												data-testid={`remove-command-${index}`}
												onClick={() => {
													setCachedStateField(
														"allowedCommands",
														(allowedCommands ?? []).filter((_, i) => i !== index),
													)
												}}>
												<div className="flex flex-row items-center gap-1">
													<div>{cmd}</div>
													<X className="text-foreground scale-75" />
												</div>
											</Button>
										))}
									</div>
								</>
							)}
						</div>

						{visibleInheritedCommandRules.length > 0 && (
							<SearchableSetting
								settingId="auto-approve-inherited-commands"
								section={section}
								label={t("settings:autoApprove.execute.inheritedRules")}>
								<section aria-labelledby={inheritedCommandRulesHeadingId} className="space-y-3">
									<div className="flex items-center gap-1">
										<h4 id={inheritedCommandRulesHeadingId} className="font-medium m-0">
											{t("settings:autoApprove.execute.inheritedRules")}
										</h4>
										<SettingsHelp label={t("settings:autoApprove.execute.inheritedRules")}>
											{t("settings:autoApprove.execute.inheritedRulesDescription")}
										</SettingsHelp>
									</div>
									{visibleInheritedCommandRules.map((rule) => (
										<div key={rule.source} className="space-y-2 text-sm">
											<h5 className="font-medium m-0">
												{t(COMMAND_RULE_SOURCE_LABELS[rule.source])}
											</h5>
											<dl className="m-0 space-y-2">
												{mode === "ask" && rule.allowedCommands.length > 0 && (
													<div>
														<dt>{t("settings:autoApprove.execute.inheritedAllowed")}</dt>
														<dd className="ml-3 mt-1 break-words">
															{rule.allowedCommands.join(", ")}
														</dd>
													</div>
												)}
												{rule.deniedCommands.length > 0 && (
													<div>
														<dt>{t("settings:autoApprove.execute.inheritedDenied")}</dt>
														<dd className="ml-3 mt-1 break-words">
															{rule.deniedCommands.join(", ")}
														</dd>
													</div>
												)}
											</dl>
										</div>
									))}
								</section>
							</SearchableSetting>
						)}

						<SearchableSetting
							settingId="auto-approve-mcp"
							section={section}
							label={t("settings:autoApprove.mcp.label")}>
							<div className="flex items-center gap-1">
								<VSCodeCheckbox
									checked={mcpApprovalOverridden || alwaysAllowMcp === true}
									disabled={mcpApprovalOverridden}
									aria-describedby={mcpPolicyDescriptionId}
									onChange={(event) => {
										const target = event.target
										if (
											!mcpApprovalOverridden &&
											target !== null &&
											"checked" in target &&
											typeof target.checked === "boolean"
										) {
											setCachedStateField("alwaysAllowMcp", target.checked)
										}
									}}
									data-testid="always-allow-mcp-checkbox">
									<span className="font-medium">{t("settings:autoApprove.mcp.label")}</span>
								</VSCodeCheckbox>
								<SettingsHelp label={t("settings:autoApprove.mcp.label")}>
									{t(
										mcpApprovalOverridden
											? "settings:autoApprove.mcp.bypassDescription"
											: "settings:autoApprove.mcp.description",
									)}
								</SettingsHelp>
							</div>
							<span id={mcpPolicyDescriptionId} hidden>
								{t(
									mcpApprovalOverridden
										? "settings:autoApprove.mcp.bypassDescription"
										: "settings:autoApprove.mcp.description",
								)}
							</span>
						</SearchableSetting>
					</div>
				</details>
			</Section>

			<AlertDialog open={bypassWarningOpen} onOpenChange={setBypassWarningOpen}>
				<AlertDialogContent
					className="settings-confirmation-dialog"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						bypassButtonRef.current?.focus()
					}}>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:autoApprove.bypassWarning.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("settings:autoApprove.bypassWarning.body")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings:autoApprove.bypassWarning.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							data-testid="approval-mode-bypass-confirm"
							onClick={() => applyMode("bypass", true)}>
							{t("settings:autoApprove.bypassWarning.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
