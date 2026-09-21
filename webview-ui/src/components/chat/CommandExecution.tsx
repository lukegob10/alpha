import { useCallback, useState, useMemo, useId } from "react"
import { useEvent } from "react-use"
import { t } from "i18next"
import { AlertTriangle, ChevronRight, OctagonX } from "lucide-react"

import {
	type ExtensionMessage,
	type CommandExecutionStatus,
	type ToolProgressStatus,
	commandExecutionStatusSchema,
} from "@alpha-code/types"

import { safeJsonParse } from "@alpha/core"
import { COMMAND_OUTPUT_STRING } from "@alpha/combineCommandSequences"
import { parseCommand } from "@alpha/parse-command"

import { vscode } from "@src/utils/vscode"
import { extractPatternsFromCommand } from "@src/utils/command-parser"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"

import { Button, StandardTooltip } from "@src/components/ui"
import CodeBlock from "@src/components/common/CodeBlock"

import { CommandPatternSelector } from "./CommandPatternSelector"
import { TerminalOutput } from "./TerminalOutput"

interface CommandPattern {
	pattern: string
	description?: string
}

interface CommandExecutionProps {
	executionId: string
	workingDirectory?: string
	pathApproval?: ToolProgressStatus["commandPathApproval"]
	text?: string
	icon?: JSX.Element | null
	title?: JSX.Element | null
	onToggleExpand?: () => void
}

export const CommandExecution = ({
	executionId,
	text,
	icon,
	title,
	onToggleExpand,
	workingDirectory,
	pathApproval,
}: CommandExecutionProps) => {
	const {
		currentTaskId,
		allowedCommands = [],
		deniedCommands = [],
		setAllowedCommands,
		setDeniedCommands,
	} = useExtensionState()

	const { command, output: parsedOutput } = useMemo(() => parseCommandAndOutput(text), [text])

	// Expansion belongs to the reader. Stream events update the retained output
	// without opening the terminal or closing it while someone is reading.
	const [isExpanded, setIsExpanded] = useState(false)
	const detailsId = useId()
	const [streamingOutput, setStreamingOutput] = useState("")
	const [status, setStatus] = useState<CommandExecutionStatus | null>(null)

	// The command's output can either come from the text associated with the
	// task message (this is the case for completed commands) or from the
	// streaming output (this is the case for running commands).
	const output = status?.status === "exited" && parsedOutput ? parsedOutput : streamingOutput || parsedOutput

	// Extract command patterns from the actual command that was executed
	const commandPatterns = useMemo<CommandPattern[]>(() => {
		// First get all individual commands (including subshell commands) using parseCommand
		const allCommands = parseCommand(command)

		// Then extract patterns from each command using the existing pattern extraction logic
		const allPatterns = new Set<string>()

		// Add all individual commands first
		allCommands.forEach((cmd) => {
			if (cmd.trim()) {
				allPatterns.add(cmd.trim())
			}
		})

		// Then add extracted patterns for each command
		allCommands.forEach((cmd) => {
			const patterns = extractPatternsFromCommand(cmd)
			patterns.forEach((pattern) => allPatterns.add(pattern))
		})

		return Array.from(allPatterns).map((pattern) => ({
			pattern,
		}))
	}, [command])

	// Handle pattern changes
	const handleAllowPatternChange = (pattern: string) => {
		const isAllowed = allowedCommands.includes(pattern)
		const newAllowed = isAllowed ? allowedCommands.filter((p) => p !== pattern) : [...allowedCommands, pattern]
		const newDenied = deniedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const handleDenyPatternChange = (pattern: string) => {
		const isDenied = deniedCommands.includes(pattern)
		const newDenied = isDenied ? deniedCommands.filter((p) => p !== pattern) : [...deniedCommands, pattern]
		const newAllowed = allowedCommands.filter((p) => p !== pattern)

		setAllowedCommands(newAllowed)
		setDeniedCommands(newDenied)

		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { allowedCommands: newAllowed, deniedCommands: newDenied },
		})
	}

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "commandExecutionStatus") {
				const result = commandExecutionStatusSchema.safeParse(safeJsonParse(message.text, {}))

				if (result.success) {
					const data = result.data

					if (data.executionId !== executionId) {
						return
					}

					switch (data.status) {
						case "started":
							setStatus(data)
							break
						case "output":
							setStreamingOutput(data.output)
							break
						default:
							setStatus(data)
							break
					}
				}
			}
		},
		[executionId],
	)

	useEvent("message", onMessage)

	return (
		<>
			{pathApproval && (
				<div
					className="mb-3 ml-6 overflow-hidden rounded-xl border border-vscode-inputValidation-warningBorder bg-vscode-inputValidation-warningBackground text-sm shadow-sm"
					role="note"
					aria-label={t("settings:autoApprove.execute.pathApprovalTitle")}>
					<div className="flex items-start gap-3 border-b border-vscode-inputValidation-warningBorder px-3 py-3">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-vscode-inputValidation-warningBackground text-vscode-editorWarning-foreground">
							<AlertTriangle className="size-4" aria-hidden="true" />
						</div>
						<div className="min-w-0">
							<div className="font-semibold text-vscode-foreground">
								{t("settings:autoApprove.execute.pathApprovalTitle")}
							</div>
							<p className="mt-1 text-xs leading-5 text-vscode-descriptionForeground">
								{t("settings:autoApprove.execute.pathApprovalDescription")}
							</p>
						</div>
					</div>
					{pathApproval.outsidePaths.length > 0 && (
						<div className="space-y-2 px-3 py-3">
							<ul className="space-y-1.5">
								{pathApproval.outsidePaths.map((target) => (
									<li
										key={target}
										className="break-all rounded-lg border border-vscode-input-border bg-vscode-editor-background px-2.5 py-2 font-mono text-xs text-vscode-foreground">
										{target}
									</li>
								))}
							</ul>
						</div>
					)}
					{pathApproval.unresolved && (
						<div className="flex items-start gap-2 border-t border-vscode-inputValidation-warningBorder px-3 py-2.5 text-xs text-vscode-descriptionForeground">
							<AlertTriangle
								className="mt-0.5 size-3.5 shrink-0 text-vscode-editorWarning-foreground"
								aria-hidden="true"
							/>
							<span>{t("settings:autoApprove.execute.pathApprovalUnresolved")}</span>
						</div>
					)}
				</div>
			)}
			{workingDirectory && (
				<div className="mb-1 ml-6 break-all font-mono text-xs text-vscode-descriptionForeground">
					{workingDirectory}
				</div>
			)}
			<div className="flex flex-row items-center justify-between gap-2 mb-1">
				<button
					type="button"
					aria-expanded={isExpanded}
					aria-controls={detailsId}
					aria-label={`${t(isExpanded ? "chat:commandExecution.collapseOutput" : "chat:commandExecution.expandOutput")}: ${command}`}
					onClick={() => {
						onToggleExpand?.()
						setIsExpanded((expanded) => !expanded)
					}}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
					<ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0", isExpanded && "rotate-90")} />
					{icon}
					{title}
					<code
						className="min-w-0 truncate text-xs"
						style={{ color: "var(--vscode-foreground)" }}
						title={command}>
						{command.split(/\r?\n/)[0]}
					</code>
					{status?.status === "exited" && (
						<div className="flex flex-row items-center gap-2 font-mono text-xs">
							<StandardTooltip
								content={t("chat:commandExecution.exitStatus", { exitCode: status.exitCode })}>
								<div
									className={cn(
										"rounded-full size-2",
										status.exitCode === 0 ? "bg-vscode-charts-green" : "bg-vscode-errorForeground",
									)}
								/>
							</StandardTooltip>
						</div>
					)}
				</button>
				<div className=" flex flex-row items-center justify-between gap-2 px-1">
					<div className="flex flex-row items-center gap-1">
						{status?.status === "started" && (
							<div className="flex flex-row items-center gap-2 font-mono text-xs">
								{isExpanded && status.pid && (
									<div className="whitespace-nowrap">
										{t("chat:commandExecution.pid", { pid: status.pid })}
									</div>
								)}
								<StandardTooltip content={t("chat:commandExecution.abort")}>
									<Button
										variant="ghost"
										size="icon"
										aria-label={t("chat:commandExecution.abortCommand")}
										onClick={() =>
											vscode.postMessage({
												type: "terminalOperation",
												terminalOperation: "abort",
												...(currentTaskId ? { taskId: currentTaskId } : {}),
											})
										}>
										<OctagonX className="size-4" />
									</Button>
								</StandardTooltip>
							</div>
						)}
					</div>
				</div>
			</div>

			<div
				id={detailsId}
				hidden={!isExpanded}
				className="ml-6 mt-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] shadow-sm">
				<div className="p-2">
					<CodeBlock source={command} language="shell" />
					{isExpanded && output.length > 0 && (
						<div className="mt-1 max-h-80 overflow-auto border-t border-border/25 pt-1" tabIndex={0}>
							<TerminalOutput content={output} />
						</div>
					)}
				</div>
				{!pathApproval && command && command.trim() && (
					<CommandPatternSelector
						patterns={commandPatterns}
						allowedCommands={allowedCommands}
						deniedCommands={deniedCommands}
						onAllowPatternChange={handleAllowPatternChange}
						onDenyPatternChange={handleDenyPatternChange}
					/>
				)}
			</div>
		</>
	)
}

CommandExecution.displayName = "CommandExecution"

const parseCommandAndOutput = (text: string | undefined) => {
	if (!text) {
		return { command: "", output: "" }
	}

	const index = text.indexOf(COMMAND_OUTPUT_STRING)

	if (index === -1) {
		return { command: text, output: "" }
	}

	return {
		command: text.slice(0, index),
		output: text.slice(index + COMMAND_OUTPUT_STRING.length),
	}
}
