import { evidenceFromText } from "../evidence"
import type { EvalTraceEvent, GraderContext, GraderPlugin, GraderResult, TraceAssertionGraderSpec } from "../types"
import { validateTraceEvidence } from "../validation"

const mutationTools = new Set([
	"write_file",
	"write_to_file",
	"edit_file",
	"replace_in_file",
	"apply_patch",
	"apply_diff",
	"multi_apply_diff",
	"insert_content",
	"delete_file",
	"move_file",
	"rename_file",
])
const commandTools = new Set(["exec_command", "shell", "execute_command", "write_stdin", "manage_command"])

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function successful(payload: Record<string, unknown>): boolean {
	return (
		payload.status === "success" &&
		payload.ok !== false &&
		payload.timedOut !== true &&
		(payload.executionStatus === undefined || payload.executionStatus === "success") &&
		(payload.exitCode === undefined || payload.exitCode === 0)
	)
}

function isMutation(payload: Record<string, unknown>): boolean {
	const name = payload.name ?? payload.toolName ?? payload.tool
	return (
		(typeof name === "string" && mutationTools.has(name)) ||
		payload.mutatesWorkspace === true ||
		payload.toolCategory === "write" ||
		payload.toolCategory === "edit"
	)
}

/** Tokenize evidence only; never execute or expand the captured command. */
function commandSegments(value: string): string[][] {
	const segments: string[][] = [[]]
	let token = ""
	let quote: string | undefined
	let started = false
	const finish = () => {
		if (started) segments[segments.length - 1]!.push(token)
		token = ""
		started = false
	}
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!
		if (quote) {
			if (character === quote) quote = undefined
			else token += character
			continue
		}
		if (character === "'" || character === '"') {
			quote = character
			started = true
		} else if (/[;|\r\n#`]/.test(character)) return []
		else if (/\s/.test(character)) finish()
		else if (character === "&" && value[index + 1] === "&") {
			finish()
			segments.push([])
			index++
		} else if (character === "&") {
			return []
		} else {
			token += character
			started = true
		}
	}
	if (quote) return []
	finish()
	return segments
}

function matchesCommand(payload: Record<string, unknown>, required: { command: string; args: string[] }): boolean {
	const tool = payload.name ?? payload.toolName ?? payload.tool
	if (typeof tool !== "string" || !commandTools.has(tool)) return false
	const input = object(payload.input)
	const command = payload.command ?? input?.cmd ?? input?.command
	const args = payload.args ?? input?.args
	const expected = [required.command, ...required.args]
	const candidates =
		typeof command !== "string" ? [] : Array.isArray(args) ? [[command, ...args]] : commandSegments(command)
	return candidates.some(
		(candidate) =>
			candidate.length === expected.length &&
			candidate.every((part, index) => typeof part === "string" && part === expected[index]),
	)
}

function verifiedAfterLastMutation(
	context: GraderContext,
	commands: Array<{ command: string; args: string[] }> | undefined,
): boolean {
	let lastMutation = -1
	const receipts = new Map<string, EvalTraceEvent[]>()
	for (const event of context.trace) {
		if (event.type !== "agent.turn.tool_result") continue
		const payload = object(event.payload)
		if (!payload) continue
		if (successful(payload) && isMutation(payload) && typeof payload.callId === "string" && payload.callId.trim())
			lastMutation = event.sequence
		if (typeof payload.callId === "string") {
			const prior = receipts.get(payload.callId) ?? []
			prior.push(event)
			receipts.set(payload.callId, prior)
		}
	}
	// A changed workspace with no observed successful mutation lacks ordering evidence.
	if (context.changedPaths.length > 0 && lastMutation < 0) return false
	const verifications = context.trace.filter((event) => {
		if (event.type !== "agent.turn.verification_result" && event.type !== "agent.turn.tool_result") return false
		const payload = object(event.payload)
		if (!payload || event.sequence <= lastMutation) return false
		if (typeof payload.callId !== "string" || payload.callId.trim().length === 0) return false
		if (!commands?.length) return event.type === "agent.turn.verification_result"
		return commands.some((command) => matchesCommand(payload, command))
	})
	const valid = (event: EvalTraceEvent | undefined, command?: { command: string; args: string[] }) => {
		if (!event) return false
		const payload = object(event.payload)!
		if (!successful(payload)) return false
		if (event.type === "agent.turn.tool_result" && payload.exitCode !== 0 && payload.executionStatus !== "success")
			return false
		const terminal = receipts.get(String(payload.callId))
		return (
			terminal?.length === 1 &&
			terminal[0]!.sequence > lastMutation &&
			terminal[0]!.sequence <= event.sequence &&
			successful(object(terminal[0]!.payload)!) &&
			(!command || matchesCommand(object(terminal[0]!.payload)!, command))
		)
	}
	return commands?.length
		? commands.every((command) => {
				for (let index = verifications.length - 1; index >= 0; index--) {
					const event = verifications[index]!
					if (matchesCommand(object(event.payload)!, command)) return valid(event, command)
				}
				return false
			})
		: valid(verifications.at(-1))
}

export class TraceAssertionGrader implements GraderPlugin<TraceAssertionGraderSpec> {
	readonly type = "trace-assertion" as const

	async execute(
		spec: TraceAssertionGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		validateTraceEvidence(context.trace)
		const diagnostics: GraderResult["diagnostics"] = []
		for (const assertion of spec.assertions) {
			const matching = context.trace.filter(
				({ type }) => type === ("eventType" in assertion ? assertion.eventType : ""),
			)
			let passed: boolean
			switch (assertion.kind) {
				case "present":
					passed = matching.length > 0
					break
				case "absent":
					passed = matching.length === 0
					break
				case "count-max":
					passed = matching.length <= assertion.max
					break
				case "ordered": {
					const before = context.trace.find(({ type }) => type === assertion.before)
					const after = context.trace.find(({ type }) => type === assertion.after)
					passed = !!before && !!after && before.sequence < after.sequence
					break
				}
				case "verification-after-last-mutation":
					passed = verifiedAfterLastMutation(context, assertion.commands)
					break
			}
			if (!passed) {
				diagnostics.push({
					code: `trace_${assertion.kind}_failed`,
					message: `Trace assertion failed: ${JSON.stringify(assertion)}`,
					severity: "error",
				})
			}
		}
		return {
			graderId: spec.id,
			graderVersion: spec.version,
			type: spec.type,
			status: diagnostics.length === 0 ? "passed" : "failed",
			hardGate: spec.hardGate,
			failureClass: spec.failureClass,
			diagnostics,
			evidence: [
				evidenceFromText(`${spec.id}:trace`, "trace", JSON.stringify(context.trace), "application/json"),
			],
		}
	}
}
