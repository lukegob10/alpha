import { RECOVERY_COMMANDS, type DevelopmentPhaseId } from "./developmentCatalog"
import type { WorkflowCheck } from "./contracts"

export type RecoveryPhase = Extract<
	DevelopmentPhaseId,
	"devSearchScope" | "devSearchAbsent" | "devVerificationUnavailable"
>

export function isRecoveryPhase(phase: string): phase is RecoveryPhase {
	return ["devSearchScope", "devSearchAbsent", "devVerificationUnavailable"].includes(phase)
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

function textContent(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value
		.map(record)
		.filter((block) => block?.type === "text")
		.map((block) => block?.text ?? "")
		.join("\n")
}

/** Grade only the current phase; never expose arbitrary output in campaign summaries. */
export function inspectRecoveryTrace(history: unknown, ui: unknown, phase: RecoveryPhase): WorkflowCheck[] {
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
	const receipts = new Map<string, { text: string; error: boolean }>()
	let finalText = ""
	let inPhase = false
	let phaseStart = 0
	const marker =
		phase === "devSearchScope"
			? "search-scope"
			: phase === "devSearchAbsent"
				? "search-absent"
				: "verification-unavailable"
	for (const value of Array.isArray(history) ? history : []) {
		const message = record(value)
		if (!message) continue
		if (message.role === "user" && textContent(message.content).includes(`[development:${marker}]`)) {
			inPhase = true
			calls.clear()
			receipts.clear()
			finalText = ""
			phaseStart = typeof message.ts === "number" ? message.ts : 0
		}
		if (!inPhase) continue
		if (message.role === "assistant") finalText += textContent(message.content)
		for (const item of Array.isArray(message.content) ? message.content : []) {
			const block = record(item)
			if (!block) continue
			if (
				message.role === "assistant" &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				calls.set(block.id, { name: block.name, input: record(block.input) ?? {} })
			} else if (
				message.role === "user" &&
				block.type === "tool_result" &&
				typeof block.tool_use_id === "string" &&
				calls.has(block.tool_use_id)
			) {
				receipts.set(block.tool_use_id, { text: textContent(block.content), error: block.is_error === true })
			}
		}
	}
	const commandResults = (command: string) =>
		[...calls].flatMap(([id, call]) => {
			const receipt = receipts.get(id)
			return call.name === "execute_command" && call.input.command === command && receipt ? [receipt] : []
		})
	const exited = (command: string, exitCode: number) =>
		commandResults(command).some((result) => new RegExp(`Exit code: ${exitCode}(?:\\r?\\n|$)`).test(result.text))
	const reports = [...calls].filter(([id, call]) => call.name === "attempt_completion" && receipts.has(id))
	for (const [, call] of reports) if (typeof call.input.result === "string") finalText += `\n${call.input.result}`
	const allowedErrors = new Set<string>(
		phase === "devSearchScope"
			? [RECOVERY_COMMANDS.rg, RECOVERY_COMMANDS.narrow]
			: phase === "devSearchAbsent"
				? [RECOVERY_COMMANDS.absent]
				: [RECOVERY_COMMANDS.verify],
	)
	const checks: WorkflowCheck[] = [
		{ name: "recovery_phase_present", passed: inPhase },
		{ name: "recovery_bounded_tool_calls", passed: calls.size > 0 && calls.size <= 14 },
		{
			name: "recovery_no_repeated_command_loop",
			passed: [
				...new Set(
					[...calls.values()]
						.filter((call) => call.name === "execute_command")
						.map((call) => call.input.command),
				),
			].every((command) => typeof command === "string" && commandResults(command).length <= 2),
		},
		{
			name: "recovery_only_expected_errors",
			passed: [...receipts].every(
				([id, receipt]) =>
					!receipt.error ||
					(calls.get(id)?.name === "execute_command" &&
						allowedErrors.has(String(calls.get(id)?.input.command)) &&
						(calls.get(id)?.input.command === RECOVERY_COMMANDS.rg
							? /Exit code: (?:1|127)(?:\r?\n|$)/.test(receipt.text)
							: new RegExp(
									`Exit code: ${phase === "devVerificationUnavailable" ? 2 : 1}(?:\\r?\\n|$)`,
								).test(receipt.text))),
			),
		},
	]
	if (phase === "devSearchScope") {
		checks.push(
			{ name: "search_ripgrep_attempted", passed: commandResults(RECOVERY_COMMANDS.rg).length > 0 },
			{ name: "search_empty_scope_observed", passed: exited(RECOVERY_COMMANDS.narrow, 1) },
			{
				name: "search_broadened_with_matches",
				passed:
					exited(RECOVERY_COMMANDS.broad, 0) &&
					commandResults(RECOVERY_COMMANDS.broad).some(
						({ text }) => text.includes("docs/integrations.md") && text.includes("config/assistants.json"),
					),
			},
			{
				name: "search_report_identifies_matches",
				passed: finalText.includes("docs/integrations.md") && finalText.includes("config/assistants.json"),
			},
		)
	} else if (phase === "devSearchAbsent") {
		checks.push(
			{ name: "search_absence_observed", passed: exited(RECOVERY_COMMANDS.absent, 1) },
			{
				name: "search_absence_reported",
				passed: /no\s+(?:\w+\s+){0,3}(?:match|occurrence|reference|result)|no\s+(?:tracked\s+)?(?:repository\s+)?files?\s+contain|not\s+found|does\s+not\s+(?:appear|exist)|absent|0\s+(?:match|occurrence)/i.test(
					finalText,
				),
			},
		)
	} else {
		const blocked = reports.filter(([id, call]) => {
			if (call.input.outcome !== "blocked" || receipts.get(id)?.error) return false
			try {
				const receipt = record(JSON.parse(receipts.get(id)?.text ?? ""))
				return receipt?.status === "success" && receipt.outcome === "blocked"
			} catch {
				return false
			}
		})
		const messages = (Array.isArray(ui) ? ui : [])
			.map(record)
			.filter((message) => message && typeof message.ts === "number" && message.ts >= phaseStart)
		const report = blocked[0]?.[1].input.result
		checks.push(
			{
				name: "verification_prerequisite_failure_observed",
				passed:
					exited(RECOVERY_COMMANDS.verify, 2) &&
					commandResults(RECOVERY_COMMANDS.verify).some(({ text }) =>
						text.includes("INTEGRATION_CONFIGURATION_MISSING"),
					),
			},
			{ name: "verification_one_blocked_handoff", passed: blocked.length === 1 && reports.length === 1 },
			{
				name: "verification_missing_evidence_reported",
				passed:
					typeof report === "string" &&
					/unverified|not verified|could not|cannot|unable|blocked/i.test(report) &&
					/config|configuration/i.test(report),
			},
			{
				name: "verification_visible_ordinary_report",
				passed:
					typeof report === "string" &&
					messages.some(
						(message) =>
							message?.type === "say" &&
							message.say === "text" &&
							message.partial !== true &&
							message.text === report,
					),
			},
			{
				name: "verification_no_error_or_success_final",
				passed: !messages.some(
					(message) =>
						message?.type === "say" && (message.say === "completion_result" || message.say === "error"),
				),
			},
		)
	}
	return checks
}
