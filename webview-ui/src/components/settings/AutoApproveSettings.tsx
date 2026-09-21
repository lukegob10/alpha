import { HTMLAttributes, useId, useState } from "react"
import { X } from "lucide-react"
import { type ApprovalMode, migrateApprovalMode, settingsForApprovalMode } from "@alpha-code/types"

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
import { MaxLimitInputs } from "./MaxLimitInputs"

type AutoApproveSettingsProps = HTMLAttributes<HTMLDivElement> & {
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
	allowedCommands?: string[]
	allowedMaxRequests?: number | undefined
	allowedMaxCost?: number | undefined
	deniedCommands?: string[]
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
		| "autoApprovalEnabled"
		| "allowedCommands"
		| "allowedMaxRequests"
		| "allowedMaxCost"
		| "deniedCommands"
	>
}

const MODES: ApprovalMode[] = ["ask", "auto", "bypass"]

export const AutoApproveSettings = ({
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
	allowedCommands,
	allowedMaxRequests,
	allowedMaxCost,
	deniedCommands,
	setCachedStateField,
	...props
}: AutoApproveSettingsProps) => {
	const { t } = useAppTranslation()
	const [commandInput, setCommandInput] = useState("")
	const [deniedCommandInput, setDeniedCommandInput] = useState("")
	const [bypassWarningOpen, setBypassWarningOpen] = useState(false)
	const allowedCommandInputId = useId()
	const deniedCommandInputId = useId()
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
			<SectionHeader>{t("settings:sections.autoApprove")}</SectionHeader>

			<Section>
				<div className="space-y-4">
					<SearchableSetting
						settingId="auto-approve-mode"
						section="autoApprove"
						label={t("settings:autoApprove.mode.label")}>
						<div className="flex flex-col gap-2">
							<p className="text-vscode-descriptionForeground text-sm">
								{t("settings:autoApprove.mode.description")}
							</p>
							<div className="flex flex-wrap gap-2">
								{MODES.map((candidate) => (
									<Button
										key={candidate}
										variant={mode === candidate ? "primary" : "secondary"}
										onClick={() => selectMode(candidate)}
										aria-pressed={mode === candidate}
										data-testid={`approval-mode-${candidate}`}
										className="h-auto px-3 py-2">
										{t(`settings:autoApprove.mode.${candidate}`)}
									</Button>
								))}
							</div>
							<p className="text-vscode-descriptionForeground text-sm">
								{t(`settings:autoApprove.mode.${mode}Description`)}
							</p>
						</div>
					</SearchableSetting>

					<MaxLimitInputs
						allowedMaxRequests={allowedMaxRequests}
						allowedMaxCost={allowedMaxCost}
						onMaxRequestsChange={(value) => setCachedStateField("allowedMaxRequests", value)}
						onMaxCostChange={(value) => setCachedStateField("allowedMaxCost", value)}
					/>
				</div>

				{mode === "auto" && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="auto-approve-write-protected"
							section="autoApprove"
							label={t("settings:autoApprove.write.protected.label")}>
							<VSCodeCheckbox
								checked={alwaysAllowWriteProtected}
								onChange={(e: any) =>
									setCachedStateField("alwaysAllowWriteProtected", e.target.checked)
								}
								data-testid="always-allow-write-protected-checkbox">
								<span className="font-medium">{t("settings:autoApprove.write.protected.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
								{t("settings:autoApprove.write.protected.description")}
							</div>
						</SearchableSetting>
					</div>
				)}

				<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
					<SearchableSetting
						settingId="auto-approve-denied-commands"
						section="autoApprove"
						label={t("settings:autoApprove.execute.deniedCommands")}>
						<label
							htmlFor={deniedCommandInputId}
							className="block font-medium mb-1"
							data-testid="denied-commands-heading">
							{t("settings:autoApprove.execute.deniedCommands")}
						</label>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:autoApprove.execute.deniedCommandsDescription")}
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

					<SearchableSetting
						settingId="auto-approve-allowed-commands"
						section="autoApprove"
						label={t("settings:autoApprove.execute.allowedCommands")}>
						<label
							htmlFor={allowedCommandInputId}
							className="block font-medium mb-1"
							data-testid="allowed-commands-heading">
							{t("settings:autoApprove.execute.allowedCommands")}
						</label>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:autoApprove.execute.allowedCommandsDescription")}
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
						<Button className="h-8" onClick={handleAddCommand} data-testid="add-command-button">
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
				</div>

				<details className="mt-4">
					<summary className="cursor-pointer text-sm text-vscode-descriptionForeground">
						{t("settings:autoApprove.advancedMcp")}
					</summary>
					<div className="mt-2">
						<VSCodeCheckbox
							checked={alwaysAllowMcp}
							onChange={(e: any) => setCachedStateField("alwaysAllowMcp", e.target.checked)}
							data-testid="always-allow-mcp-checkbox">
							<span className="font-medium">{t("settings:autoApprove.mcp.label")}</span>
						</VSCodeCheckbox>
					</div>
				</details>
			</Section>

			<AlertDialog open={bypassWarningOpen} onOpenChange={setBypassWarningOpen}>
				<AlertDialogContent>
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
