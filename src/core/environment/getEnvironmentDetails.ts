import path from "path"
import os from "os"
import * as vscode from "vscode"

import { defaultMode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { listFiles } from "../../services/glob/list-files"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS } from "../../integrations/terminal/types"
import { arePathsEqual } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { getGitStatus } from "../../utils/git"
import type { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { formatReminderSection } from "./reminder"
import {
	EnvironmentContext,
	awaitEnvironmentRead,
	type EnvironmentField,
	type EnvironmentReceipt,
	type TerminalOutputCursor,
} from "./EnvironmentContext"

type EnvironmentState = Awaited<ReturnType<ClineProvider["getState"]>>
interface EnvironmentOptions {
	context?: EnvironmentContext
	signal?: AbortSignal
	/** Summary facts omit transient events; the next committed step owns their delivery. */
	includeTransient?: boolean
}

const MAX_PATHS = 200
const MAX_TERMINALS = 32
const MAX_FIELD_CHARACTERS = 16_000
const MAX_FACT_CHARACTERS = 48_000
const MAX_OUTPUT_CHARACTERS = 32_000
const WORKSPACE_FILES = "Workspace Files (baseline; use list_files for current contents)"
const bounded = (value: string, limit = MAX_FIELD_CHARACTERS) =>
	value.length <= limit ? value : `${value.slice(0, limit)}\n(context limit reached)`
const countLimit = (value: number | undefined, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(MAX_PATHS, Math.floor(value))) : fallback

const isWithinPath = (root: string, candidate: string): boolean => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Full, non-consuming snapshot. Runtime summaries pass includeTransient:false. */
export async function getEnvironmentDetails(
	cline: Task,
	includeFileDetails = false,
	stateOverride?: EnvironmentState,
	options: Omit<EnvironmentOptions, "context"> = {},
): Promise<string> {
	const capture = await captureEnvironmentDetails(cline, includeFileDetails, stateOverride, options)
	try {
		return capture.details
	} finally {
		capture.release()
	}
}

export async function captureEnvironmentDetails(
	cline: Task,
	includeFileDetails = false,
	stateOverride?: EnvironmentState,
	{ context = new EnvironmentContext(), signal, includeTransient = true }: EnvironmentOptions = {},
) {
	signal?.throwIfAborted()
	const provider = cline.providerRef.deref()
	const state = stateOverride ?? (await awaitEnvironmentRead(Promise.resolve(provider?.getState()), signal))
	const currentMode = (await awaitEnvironmentRead(cline.getTaskMode(), signal)) ?? defaultModeSlug
	const modelId = cline.api.getModel().id
	const maxFiles = countLimit(state?.maxWorkspaceFiles, 200)
	const maxTabs = countLimit(state?.maxOpenTabsContext, 20)
	const storagePath = provider?.context?.globalStorageUri.fsPath
	const privateRoots = storagePath
		? [path.join(storagePath, "subagent-worktrees"), path.join(storagePath, "subagent-change-sets")]
		: []
	const isPrivate = (candidate: string) =>
		privateRoots.some((root) => isWithinPath(root, path.resolve(cline.cwd, candidate)))
	const workspaceRoots = (vscode.workspace?.workspaceFolders ?? [])
		.map(({ uri }) => uri.fsPath)
		.filter((root) => !isPrivate(root))
		.slice(0, MAX_PATHS)
	const identity = JSON.stringify([
		cline.taskId,
		cline.instanceId,
		cline.taskKind,
		cline.cwd,
		workspaceRoots,
		maxFiles,
		maxTabs,
		state?.showRooIgnoredFiles,
		cline.rooIgnoreController?.rooIgnoreContent,
	])
	const full = context.requiresFullSnapshot(identity)
	const fields: EnvironmentField[] = []
	let remainingFacts = MAX_FACT_CHARACTERS
	const add = (name: string, value: string, comparison?: string) => {
		const text = bounded(value, Math.min(MAX_FIELD_CHARACTERS, Math.max(0, remainingFacts)))
		remainingFacts -= text.length
		fields.push({ name, value: text, comparison })
	}
	const verification = await awaitEnvironmentRead(
		Promise.resolve(provider?.getParentVerificationContext?.(cline)),
		signal,
	)
	if (verification) add("Workspace Verification", verification)
	const pacing = cline.getRequestPacingMetrics?.()
	if (pacing && pacing.configuredIntervalSeconds > 0) {
		add(
			"Configured Request Pacing",
			`Provider-profile interval: ${pacing.configuredIntervalSeconds}s (shared by the parent and sub-agents using this profile). Before this request, this task had waited ${pacing.waitCount} time${pacing.waitCount === 1 ? "" : "s"} for ${Math.round(pacing.totalWaitMs / 100) / 10}s total. A request_pacing_update block, when present, contains the authoritative total after the current request's wait. These are configured pacing waits, not provider errors; include them accurately in performance summaries.`,
		)
	}
	if (cline.taskKind === "subagent") {
		add("Current Workspace Directory", ".")
		add("Current Mode", `<slug>${currentMode}</slug>\n<model>${modelId}</model>`)
		add(
			"Sub-agent Context",
			"Workspace files are intentionally omitted. Paths explicitly named by the objective are already located: read them directly, and use a direct read error rather than list or search output to establish that one is absent. Use list_files or search_files only for unnamed or unresolved candidates, then read related files in batches.",
		)
		return context.prepare(identity, fields, "", [])
	}
	// Essential identity and clock facts precede bulk editor/listing fields.
	add("Current Workspace Directory", cline.cwd.toPosix())
	add("Workspace Roots", workspaceRoots.map((root) => root.toPosix()).join("\n") || cline.cwd.toPosix())
	const mode = getModeBySlug(currentMode, state?.customModes) ?? defaultMode
	add(
		"Current Mode",
		`<slug>${bounded(currentMode, 200)}</slug>\n<name>${bounded(mode.name, 500)}</name>\n<model>${bounded(modelId, 500)}</model>`,
	)
	if (state?.includeCurrentTime ?? true) {
		const now = new Date()
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
		const offset = -now.getTimezoneOffset()
		const offsetText = `${offset >= 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 60)}:${(Math.abs(offset) % 60).toString().padStart(2, "0")}`
		add(
			"Current Time",
			`Current time in ISO 8601 UTC format: ${now.toISOString()}\nUser time zone: ${zone}, UTC${offsetText}`,
			`${now.toDateString()}:${zone}:${offset}`,
		)
	}
	if (state?.includeCurrentCost ?? true) {
		const { totalCost } = getApiMetrics(cline.clineMessages)
		add("Current Cost", totalCost !== null ? `$${totalCost.toFixed(2)}` : "(Not available)")
	}
	if (state?.apiConfiguration?.todoListEnabled ?? true) add("Reminders", formatReminderSection(cline.todoList))

	const allowedPaths = (paths: string[]) => {
		const relative = paths
			.filter((file) => !isPrivate(file))
			.map((file) => path.relative(cline.cwd, file).toPosix())
		const allowed = cline.rooIgnoreController?.filterPaths(relative) ?? relative
		return Array.isArray(allowed) ? allowed.join("\n") : allowed
	}
	const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath
	add("Active Editor", (activeFile ? allowedPaths([activeFile]) : "") || "(none)")
	add(
		"VSCode Visible Files",
		allowedPaths(
			(vscode.window.visibleTextEditors ?? [])
				.map((editor) => editor.document?.uri?.fsPath)
				.filter((file): file is string => Boolean(file))
				.slice(0, maxFiles),
		) || "(none)",
	)
	add(
		"VSCode Open Tabs",
		allowedPaths(
			vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter((tab) => tab.input instanceof vscode.TabInputText)
				.map((tab) => (tab.input as vscode.TabInputText).uri.fsPath)
				.filter(Boolean)
				.slice(0, maxTabs),
		) || "(none)",
	)

	// Listings are bounded baseline facts. Re-list on root/visibility changes or a context reset.
	let listing: string | undefined
	if (includeFileDetails || full) {
		if (arePathsEqual(cline.cwd, path.join(os.homedir(), "Desktop"))) {
			listing = "(Desktop files not shown automatically. Use list_files to explore if needed.)"
		} else if (maxFiles === 0) {
			listing = "(Workspace files context disabled. Use list_files to explore if needed.)"
		} else {
			const [files, hitLimit] = await awaitEnvironmentRead(listFiles(cline.cwd, true, maxFiles, signal), signal)
			listing = formatResponse.formatFilesList(
				cline.cwd,
				files.filter((file) => !isPrivate(file)),
				hitLimit,
				cline.rooIgnoreController,
				state?.showRooIgnoredFiles ?? false,
			)
		}
	}
	const gitLimit = countLimit(state?.maxGitStatusFiles, 0)
	if (gitLimit > 0) {
		const status = await awaitEnvironmentRead(getGitStatus(cline.cwd, gitLimit, signal), signal)
		if (status) add("Git Status", status)
	}

	// All asynchronous facts precede reservations. Busy terminals never add a preflight wait.
	signal?.throwIfAborted()
	const receipts: EnvironmentReceipt[] = []
	const transient: string[] = []
	let outputCursor: TerminalOutputCursor | undefined
	try {
		const terminals = [
			...new Set([
				...TerminalRegistry.getTerminals(true, cline.taskId),
				...TerminalRegistry.getTerminals(false, cline.taskId),
				...TerminalRegistry.getBackgroundTerminals(true),
				...TerminalRegistry.getBackgroundTerminals(false),
			]),
		].filter((terminal) => !isPrivate(terminal.getCurrentWorkingDirectory()))
		add(
			"Terminals",
			terminals
				.slice(0, MAX_TERMINALS)
				.map(
					(terminal) =>
						`Terminal ${terminal.id} (${terminal.busy ? "Active" : "Inactive"})\nWorking Directory: \`${terminal.getCurrentWorkingDirectory()}\`\nOriginal command: \`${terminal.getLastCommand()}\``,
				)
				.join("\n\n") || "(none)",
		)
		// The optional listing is last so retaining it never changes other fields' budgets.
		if (listing !== undefined) add(WORKSPACE_FILES, listing)
		if (includeTransient) {
			let outputBudget = MAX_OUTPUT_CHARACTERS
			let processBudget = MAX_TERMINALS
			// Metadata has its own cap. Delivery rotates across every retained terminal
			// and process so a continuously noisy early process cannot starve later output.
			const cursor = context.terminalOutputCursor
			const startTerminal = Math.max(
				0,
				terminals.findIndex((terminal) => terminal.id === cursor?.terminalId),
			)
			for (let offset = 0; offset < terminals.length && outputBudget > 0 && processBudget > 0; offset++) {
				const terminalIndex = (startTerminal + offset) % terminals.length
				const terminal = terminals[terminalIndex]
				const processes = terminal.getProcessesWithOutput()
				if (terminal.process && !processes.includes(terminal.process)) processes.push(terminal.process)
				const startProcess =
					terminal.id === cursor?.terminalId ? cursor.processIndex % Math.max(1, processes.length) : 0
				let captured = false
				for (
					let processOffset = 0;
					processOffset < processes.length && outputBudget > 0 && processBudget > 0;
					processOffset++
				) {
					const processIndex = (startProcess + processOffset) % processes.length
					const process = processes[processIndex]
					if (!process.hasUnretrievedOutput()) continue
					const heading = `# Terminal ${terminal.id} New Output\nWorking Directory: \`${bounded(terminal.getCurrentWorkingDirectory(), 1000)}\`\nCommand: \`${bounded(process.command, 1000)}\`\n`
					const availableOutput =
						outputBudget - heading.length - 2 - MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS
					if (availableOutput <= 0) {
						outputBudget = 0
						break
					}
					processBudget--
					const receipt = process.captureUnretrievedOutput(availableOutput)
					receipts.push(receipt)
					captured = true
					if (receipt.output) {
						transient.push(heading + receipt.output)
						outputBudget -= heading.length + receipt.output.length + 2
					}
					outputCursor =
						processIndex + 1 < processes.length
							? { terminalId: terminal.id, processIndex: processIndex + 1 }
							: { terminalId: terminals[(terminalIndex + 1) % terminals.length].id, processIndex: 0 }
				}
				if (captured) receipts.push({ commit: () => terminal.cleanCompletedProcessQueue() })
			}
			const modified = cline.fileContextTracker.captureRecentlyModifiedFiles(MAX_PATHS, MAX_FIELD_CHARACTERS)
			receipts.push(modified)
			const files = modified.files.filter((file) => !isPrivate(file))
			if (files.length)
				transient.push(
					`# Recently Modified Files\nThese files changed since you last accessed them; re-read before editing:\n${files.join("\n")}`,
				)
		}
		return context.prepare(identity, fields, transient.join("\n\n"), receipts, [WORKSPACE_FILES], outputCursor)
	} catch (error) {
		for (const receipt of receipts) receipt.release?.()
		throw error
	}
}
