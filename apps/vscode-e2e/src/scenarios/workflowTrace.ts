/** Only allowlisted command labels and counts leave this projection, never tool output or arbitrary shell text. */
export interface WorkflowTrace {
	commandReceipts: Record<string, number>
	successfulCommandReceipts: Record<string, number>
	errorResults: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/** Preserve saved command aliases while reading each tool's actual argument contract. */
export function workflowCommand(name: unknown, input: unknown): string | undefined {
	const parameters = record(input)
	const command =
		name === "exec_command"
			? parameters?.cmd
			: name === "shell" || name === "execute_command"
				? parameters?.command
				: undefined
	return typeof command === "string" ? command : undefined
}

interface CommandResult {
	output: string
	exitCode?: number
	sessionId?: number
}

function receiptText(content: unknown): string {
	if (typeof content === "string") return content
	return Array.isArray(content)
		? content
				.map(record)
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block!.text)
				.join("\n")
		: ""
}

function commandResult(name: string, content: unknown): CommandResult | undefined {
	const text = receiptText(content)
	if (name === "exec_command" || name === "write_stdin") {
		const header = text.match(
			/^(?:Chunk ID: [^\r\n]+\r?\n)?Wall time: \d+(?:\.\d+)? seconds\r?\n(?:Process exited with code (-?\d+)|Process running with session ID (\d+))(?:\r?\nOriginal token count: \d+)?\r?\nOutput:\r?\n/,
		)
		if (!header) return undefined
		const output = text.slice(header[0].length)
		if (header[1] !== undefined) {
			const exitCode = Number(header[1])
			return Number.isSafeInteger(exitCode) ? { output, exitCode } : undefined
		}
		const sessionId = Number(header[2])
		return Number.isSafeInteger(sessionId) && sessionId > 0 ? { output, sessionId } : undefined
	}
	if (name !== "shell" && name !== "execute_command") return undefined
	// A running legacy envelope exposes arbitrary stdout before an Output-like
	// line. Require the owning tool's completed prefix before reading its status.
	if (!/^(?:Command executed in (?:terminal within working directory )?'[^\r\n]*'\. |Exit code: )/.test(text))
		return undefined
	const outputStart = /(?:^|\r?\n)(?:Output:|Preview:)\r?\n/.exec(text)
	if (!outputStart) return undefined
	const status = text.slice(0, outputStart.index).match(/(?:^|\r?\n|\. )Exit code: (-?\d+)(?:\r?\n|$)/)
	const exitCode = status ? Number(status[1]) : undefined
	return Number.isSafeInteger(exitCode)
		? { output: text.slice(outputStart.index + outputStart[0].length), exitCode }
		: undefined
}

export interface WorkflowCommandReceipt {
	command: string
	resultCallIds: string[]
	toolSucceeded: boolean
	terminalToolSucceeded: boolean
	exitCode?: number
	output: string
}

/** Join owned command headers and same-session continuations before projecting any verification counts. */
export function inspectWorkflowCommandReceipts(history: unknown): {
	commands: WorkflowCommandReceipt[]
	errorResults: number
} {
	const commands: WorkflowCommandReceipt[] = []
	let errorResults = 0
	const calls = new Map<
		string,
		{ name: string; command?: WorkflowCommandReceipt; continuation?: WorkflowCommandReceipt; sessionId?: number }
	>()
	const sessions = new Map<number, WorkflowCommandReceipt | null>()
	const results = new Set<string>()
	if (!Array.isArray(history)) return { commands, errorResults }
	for (const message of history) {
		const entry = record(message)
		if (!entry || !Array.isArray(entry.content)) continue
		for (const value of entry.content) {
			const block = record(value)
			if (!block) continue
			if (entry.role === "assistant" && block.type === "tool_use") {
				if (typeof block.id !== "string" || typeof block.name !== "string" || calls.has(block.id)) continue
				const command = workflowCommand(block.name, block.input)
				if (command !== undefined) {
					const receipt = {
						command,
						resultCallIds: [],
						toolSucceeded: false,
						terminalToolSucceeded: false,
						output: "",
					}
					commands.push(receipt)
					calls.set(block.id, { name: block.name, command: receipt })
				} else if (block.name === "write_stdin") {
					const sessionId = record(block.input)?.session_id
					if (typeof sessionId === "number" && Number.isSafeInteger(sessionId) && sessionId > 0)
						calls.set(block.id, {
							name: block.name,
							sessionId,
							continuation: sessions.get(sessionId) ?? undefined,
						})
				}
			} else if (entry.role === "user" && block.type === "tool_result") {
				if (typeof block.tool_use_id !== "string" || results.has(block.tool_use_id)) continue
				results.add(block.tool_use_id)
				if (block.is_error === true) errorResults++
				const call = calls.get(block.tool_use_id)
				if (!call || (block.is_error !== undefined && typeof block.is_error !== "boolean")) continue
				const toolSucceeded = block.is_error !== true
				const origin = call.command ?? call.continuation
				if (!origin) continue
				if (call.command) origin.toolSucceeded = toolSucceeded
				else if (call.sessionId === undefined || sessions.get(call.sessionId) !== origin) continue
				origin.resultCallIds.push(block.tool_use_id)
				const result = commandResult(call.name, block.content)
				if (!result) continue
				if (result.sessionId !== undefined) {
					if (call.command && toolSucceeded) {
						// Ambiguous ownership cannot let one session confirm two commands.
						sessions.set(result.sessionId, sessions.has(result.sessionId) ? null : origin)
					} else if (result.sessionId !== call.sessionId) {
						if (call.sessionId !== undefined) sessions.set(call.sessionId, null)
						continue
					}
				} else {
					origin.exitCode = result.exitCode
					origin.terminalToolSucceeded = toolSucceeded
					if (call.sessionId !== undefined) sessions.delete(call.sessionId)
				}
				origin.output += result.output
			}
		}
	}
	return { commands, errorResults }
}

export function inspectWorkflowTrace(history: unknown, commands: readonly string[]): WorkflowTrace {
	const commandReceipts: Record<string, number> = Object.fromEntries(commands.map((command) => [command, 0]))
	const successfulCommandReceipts: Record<string, number> = { ...commandReceipts }
	const inspected = inspectWorkflowCommandReceipts(history)
	for (const receipt of inspected.commands) {
		if (!commands.includes(receipt.command)) continue
		if (receipt.toolSucceeded) commandReceipts[receipt.command] = (commandReceipts[receipt.command] ?? 0) + 1
		if (receipt.toolSucceeded && receipt.terminalToolSucceeded && receipt.exitCode === 0)
			successfulCommandReceipts[receipt.command] = (successfulCommandReceipts[receipt.command] ?? 0) + 1
	}
	return { commandReceipts, successfulCommandReceipts, errorResults: inspected.errorResults }
}
