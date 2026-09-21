import React from "react"
import { Settings, ChevronDown } from "lucide-react"
import { type ApprovalMode, migrateApprovalMode, settingsForApprovalMode } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useAlphaPortal } from "@/components/ui/hooks/useAlphaPortal"
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
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@/components/ui"

interface AutoApproveDropdownProps {
	disabled?: boolean
	triggerClassName?: string
}

const MODES: ApprovalMode[] = ["ask", "auto", "bypass"]

export const AutoApproveDropdown = ({ disabled = false, triggerClassName = "" }: AutoApproveDropdownProps) => {
	const [open, setOpen] = React.useState(false)
	const [bypassWarningOpen, setBypassWarningOpen] = React.useState(false)
	const portalContainer = useAlphaPortal("alpha-portal")
	const { t } = useAppTranslation()
	const state = useExtensionState()
	const {
		approvalMode,
		approvalModeBypassAcknowledged,
		autoApprovalEnabled,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowTickets,
		alwaysAllowMcp,
		alwaysAllowSubagents,
		allowedCommands,
		setApprovalMode,
		setApprovalModeBypassAcknowledged,
		setAutoApprovalEnabled,
		setAlwaysAllowReadOnly,
		setAlwaysAllowReadOnlyOutsideWorkspace,
		setAlwaysAllowWrite,
		setAlwaysAllowWriteOutsideWorkspace,
		setAlwaysAllowWriteProtected,
		setAlwaysAllowExecute,
		setAlwaysAllowMcp,
		setAlwaysAllowSubtasks,
		setAlwaysAllowSubagents,
		setAlwaysAllowTickets,
		setAlwaysAllowFollowupQuestions,
	} = state

	const mode = migrateApprovalMode({
		approvalMode,
		autoApprovalEnabled,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowTickets,
		alwaysAllowMcp,
		alwaysAllowSubagents,
		allowedCommands,
	})

	const applyMode = React.useCallback(
		(next: ApprovalMode, acknowledged = approvalModeBypassAcknowledged === true) => {
			const settings = settingsForApprovalMode(next, {
				alwaysAllowWriteProtected: next === "auto" ? alwaysAllowWriteProtected === true : undefined,
				alwaysAllowMcp: next !== "bypass" ? alwaysAllowMcp === true : undefined,
				approvalModeBypassAcknowledged: next === "bypass" ? true : acknowledged,
			})
			vscode.postMessage({ type: "updateSettings", updatedSettings: settings })
			setApprovalMode(settings.approvalMode)
			setApprovalModeBypassAcknowledged(settings.approvalModeBypassAcknowledged === true)
			setAutoApprovalEnabled(settings.autoApprovalEnabled)
			setAlwaysAllowReadOnly(settings.alwaysAllowReadOnly)
			setAlwaysAllowReadOnlyOutsideWorkspace(settings.alwaysAllowReadOnlyOutsideWorkspace)
			setAlwaysAllowWrite(settings.alwaysAllowWrite)
			setAlwaysAllowWriteOutsideWorkspace(settings.alwaysAllowWriteOutsideWorkspace)
			setAlwaysAllowWriteProtected(settings.alwaysAllowWriteProtected)
			setAlwaysAllowExecute(settings.alwaysAllowExecute)
			setAlwaysAllowMcp(settings.alwaysAllowMcp)
			setAlwaysAllowSubtasks(settings.alwaysAllowSubtasks)
			setAlwaysAllowSubagents(settings.alwaysAllowSubagents)
			setAlwaysAllowTickets(settings.alwaysAllowTickets)
			setAlwaysAllowFollowupQuestions(settings.alwaysAllowFollowupQuestions)
		},
		[
			alwaysAllowMcp,
			alwaysAllowWriteProtected,
			approvalModeBypassAcknowledged,
			setAlwaysAllowExecute,
			setAlwaysAllowFollowupQuestions,
			setAlwaysAllowMcp,
			setAlwaysAllowReadOnly,
			setAlwaysAllowReadOnlyOutsideWorkspace,
			setAlwaysAllowSubagents,
			setAlwaysAllowSubtasks,
			setAlwaysAllowTickets,
			setAlwaysAllowWrite,
			setAlwaysAllowWriteOutsideWorkspace,
			setAlwaysAllowWriteProtected,
			setApprovalMode,
			setApprovalModeBypassAcknowledged,
			setAutoApprovalEnabled,
		],
	)

	const selectMode = React.useCallback(
		(next: ApprovalMode) => {
			if (next === "bypass" && approvalModeBypassAcknowledged !== true) {
				setBypassWarningOpen(true)
				return
			}
			applyMode(next)
			setOpen(false)
		},
		[applyMode, approvalModeBypassAcknowledged],
	)

	const handleOpenSettings = React.useCallback(
		() =>
			window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "autoApprove" } }),
		[],
	)

	return (
		<>
			<Popover open={open} onOpenChange={setOpen} data-testid="auto-approve-dropdown-root">
				<StandardTooltip
					content={t("chat:autoApprove.tooltipMode", { mode: t(`chat:autoApprove.modes.${mode}`) })}>
					<PopoverTrigger
						disabled={disabled}
						data-testid="auto-approve-dropdown-trigger"
						className={cn("composer-control composer-selector", "max-[300px]:shrink-0", triggerClassName)}>
						<span className="truncate min-w-0">{t(`chat:autoApprove.modes.${mode}`)}</span>
						<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					align="start"
					sideOffset={4}
					container={portalContainer}
					className="p-0 overflow-hidden w-[min(320px,calc(100vw-2rem))]"
					onOpenAutoFocus={(e) => e.preventDefault()}>
					<div className="flex flex-col w-full">
						<div className="p-3 border-b border-vscode-dropdown-border">
							<div className="flex items-center justify-between gap-1 pr-1 pb-2">
								<h4 className="m-0 font-bold text-base text-vscode-foreground">
									{t("chat:autoApprove.title")}
								</h4>
								<Settings
									className="inline mb-0.5 mr-1 size-4 cursor-pointer"
									onClick={handleOpenSettings}
								/>
							</div>
							<p className="m-0 text-xs text-vscode-descriptionForeground">
								{t("chat:autoApprove.description")}
							</p>
						</div>
						<div className="flex flex-col gap-1 p-3">
							{MODES.map((candidate) => (
								<StandardTooltip
									key={candidate}
									content={t(`chat:autoApprove.modeDescription.${candidate}`)}>
									<Button
										variant={mode === candidate ? "primary" : "secondary"}
										onClick={() => selectMode(candidate)}
										aria-pressed={mode === candidate}
										data-testid={`approval-mode-${candidate}`}
										className="justify-start h-auto px-2 py-2 text-sm">
										<span className="font-bold">{t(`chat:autoApprove.modes.${candidate}`)}</span>
									</Button>
								</StandardTooltip>
							))}
						</div>
					</div>
				</PopoverContent>
			</Popover>
			<AlertDialog open={bypassWarningOpen} onOpenChange={setBypassWarningOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("chat:autoApprove.bypassWarning.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("chat:autoApprove.bypassWarning.body")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("chat:autoApprove.bypassWarning.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							data-testid="approval-mode-bypass-confirm"
							onClick={() => {
								applyMode("bypass", true)
								setOpen(false)
							}}>
							{t("chat:autoApprove.bypassWarning.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
