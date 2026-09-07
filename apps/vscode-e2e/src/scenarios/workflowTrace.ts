/** Only allowlisted command labels and counts leave this projection, never tool output or arbitrary shell text. */
export interface WorkflowTrace {
	commandReceipts: Record<string, number>
	errorResults: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

export function inspectWorkflowTrace(history: unknown, commands: readonly string[]): WorkflowTrace {
	const commandReceipts: Record<string, number> = Object.fromEntries(commands.map((command) => [command, 0]))
	let errorResults = 0
	const calls = new Map<string, string>()
	const results = new Set<string>()
	if (!Array.isArray(history)) return { commandReceipts, errorResults }
	for (const message of history) {
		const entry = record(message)
		if (!entry || !Array.isArray(entry.content)) continue
		for (const value of entry.content) {
			const block = record(value)
			if (!block) continue
			if (entry.role === "assistant" && block.type === "tool_use" && block.name === "execute_command") {
				const command = record(block.input)?.command
				if (typeof block.id === "string" && typeof command === "string" && commands.includes(command))
					calls.set(block.id, command)
			} else if (entry.role === "user" && block.type === "tool_result") {
				if (typeof block.tool_use_id !== "string" || results.has(block.tool_use_id)) continue
				results.add(block.tool_use_id)
				if (block.is_error === true) errorResults++
				const command = calls.get(block.tool_use_id)
				if (command !== undefined && (block.is_error === false || block.is_error === undefined))
					commandReceipts[command] = (commandReceipts[command] ?? 0) + 1
			}
		}
	}
	return { commandReceipts, errorResults }
}
