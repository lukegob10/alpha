import { RECOVERY_COMMANDS, type DevelopmentPhaseId } from "./developmentCatalog"
import type { WorkflowCheck } from "./contracts"
import { inspectTaskLifecycle } from "./transactionAssertions"
import { inspectWorkflowCommandReceipts, workflowCommand } from "./workflowTrace"

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

export interface RecoveryLifecycleEvidence {
	events: unknown
	taskId: string
}

function hasCompletedPhase(
	evidence: RecoveryLifecycleEvidence | undefined,
	phaseStart: number,
	phaseEnd = Infinity,
): boolean {
	if (
		!evidence ||
		!Array.isArray(evidence.events) ||
		!Number.isFinite(phaseStart) ||
		phaseStart < 0 ||
		(!Number.isFinite(phaseEnd) && phaseEnd !== Infinity) ||
		phaseEnd <= phaseStart
	)
		return false
	const events = evidence.events
		.map(record)
		.filter((event): event is Record<string, unknown> => event !== undefined && event.taskId === evidence.taskId)
	if (
		events.some(
			(event) =>
				typeof event.occurredAt !== "number" || !Number.isFinite(event.occurredAt) || event.occurredAt < 0,
		)
	)
		return false
	const turnKey = (event: Record<string, unknown>) => JSON.stringify([event.runId, event.turnId])
	// A following turn can start before its user admission is persisted. Any turn
	// extending into that next phase cannot establish this phase's completion.
	const laterTurns = new Set(
		events.filter((event) => typeof event.occurredAt === "number" && event.occurredAt >= phaseEnd).map(turnKey),
	)
	// Task admission may follow turn_started. Include that containing turn's
	// earlier start instead of fabricating terminality from a timestamp slice.
	const phaseTurns = new Set(
		events
			.filter(
				(event) =>
					typeof event.occurredAt === "number" &&
					event.occurredAt >= phaseStart &&
					event.occurredAt < phaseEnd &&
					!laterTurns.has(turnKey(event)),
			)
			.map(turnKey),
	)
	const inspected = inspectTaskLifecycle(
		events.filter((event) => phaseTurns.has(turnKey(event))),
		evidence.taskId,
	)
	return (
		inspected.errors.length === 0 &&
		inspected.completedTurns === 1 &&
		inspected.cancelledTurns === 0 &&
		inspected.failedTurns === 0
	)
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value
	if (!Array.isArray(value)) return ""
	return value
		.map(record)
		.filter((block) => block?.type === "text")
		.map((block) => block?.text ?? "")
		.join("\n")
}

function reportsUnverifiedWork(report: string): boolean {
	return (
		(/\b(?:unverified|not\s+(?:yet\s+|been\s+)?(?:verified|run|executed)|could(?:\s+not|n't)|cannot|can't|unable|blocked|incomplete)\b/i.test(
			report,
		) ||
			verificationClaimKinds(report).includes("negated")) &&
		/\bconfig(?:uration)?\b/i.test(report)
	)
}

/** Reject positive outcome claims, while keeping ordinary negated or conditional explanations readable. */
function verificationClaimKinds(report: string): Array<"positive" | "negated" | "conditional"> {
	const success =
		/\b(?:all\s+(?:integration\s+)?(?:checks|tests)\s+(?:(?:have|are|were)\s+)?(?:passed|passing|green|successful)|(?:integration|verification|task|work)\s+(?:(?:is|was|has\s+been)\s+)?(?:(?:now|fully|completely|successfully)\s+)*(?:complete|completed|verified|successful|done)|(?:(?:successfully|fully|now)\s+verified|verified\s+successfully)|(?:completed|passed)\s+all\s+(?:integration\s+)?(?:checks|tests)|(?:I|we)\s+(?:have\s+)?verified\s+(?:the\s+)?integration)\b/gi
	const kinds: Array<"positive" | "negated" | "conditional"> = []
	for (const clause of report.split(/[;.!\n]|\b(?:but|however|yet)\b/i)) {
		for (const match of clause.matchAll(success)) {
			const prefix = clause.slice(0, match.index)
			const negativeSubject = /\b(?:no|neither)\s+([^,;:!?]*)$/i.exec(prefix)?.[1]
			const negatedSubject =
				negativeSubject !== undefined &&
				!/\b(?:and|but|however|yet|is|was|were|are|has|have|had|despite|although)\b/i.test(negativeSubject)
			// A negation belongs to this claim only when it introduces the claim,
			// rather than merely describing an unrelated earlier obstacle.
			if (
				/\b(?:cannot|can't|could\s+not|couldn't|do\s+not|did\s+not|never|not|without)\s+(?:(?:claim|say|confirm|report|prove|establish|that|be|been|yet)\s+)*$/i.test(
					prefix,
				) ||
				negatedSubject
			) {
				kinds.push("negated")
				continue
			}
			kinds.push(/\b(?:if|when|once|until)\b[^,]*$/i.test(prefix) ? "conditional" : "positive")
		}
	}
	return kinds
}

function claimsVerificationSuccess(report: string): boolean {
	return verificationClaimKinds(report).includes("positive")
}

/** Grade the latest matching phase interval; later phase evidence never contributes to its outcome. */
export function inspectRecoveryTrace(
	history: unknown,
	ui: unknown,
	phase: RecoveryPhase,
	lifecycle?: RecoveryLifecycleEvidence,
): WorkflowCheck[] {
	const calls = new Map<string, { name: string; input: Record<string, unknown>; command?: string }>()
	const receipts = new Map<string, { text: string; error: boolean }>()
	let phaseHistory: unknown[] = []
	let inPhase = false
	let phaseStart = 0
	let phaseEnd = Infinity
	let phaseClosed = false
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
			phaseHistory = []
			phaseStart = typeof message.ts === "number" ? message.ts : NaN
			phaseEnd = Infinity
			phaseClosed = false
		} else if (
			inPhase &&
			!phaseClosed &&
			message.role === "user" &&
			/\[(?:development|workflow):[a-z-]+\]/.test(textContent(message.content))
		) {
			phaseEnd = typeof message.ts === "number" ? message.ts : NaN
			phaseClosed = true
		}
		if (!inPhase || phaseClosed) continue
		phaseHistory.push(value)
		for (const item of Array.isArray(message.content) ? message.content : []) {
			const block = record(item)
			if (!block) continue
			if (
				message.role === "assistant" &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				calls.set(block.id, {
					name: block.name,
					input: record(block.input) ?? {},
					command: workflowCommand(block.name, block.input),
				})
			} else if (
				message.role === "user" &&
				block.type === "tool_result" &&
				typeof block.tool_use_id === "string" &&
				calls.has(block.tool_use_id)
			) {
				const text = textContent(block.content)
				receipts.set(block.tool_use_id, {
					text,
					error: block.is_error === true,
				})
			}
		}
	}
	const observedCommands = inspectWorkflowCommandReceipts(phaseHistory).commands
	const commandResults = (command: string) =>
		observedCommands.filter((receipt) => receipt.command === command && receipt.resultCallIds.length > 0)
	const exited = (command: string, exitCode: number) =>
		commandResults(command).some((result) => result.exitCode === exitCode)
	const reports = [...calls].filter(([id, call]) => call.name === "attempt_completion" && receipts.has(id))
	const completedPhase = hasCompletedPhase(lifecycle, phaseStart, phaseEnd)
	const lastAssistant = [...phaseHistory]
		.reverse()
		.map(record)
		.find((message) => message?.role === "assistant")
	const finalBlocks = Array.isArray(lastAssistant?.content) ? lastAssistant.content.map(record) : []
	const finalCalls = finalBlocks.filter((block) => block?.type === "tool_use")
	const completionCall = finalCalls.length === 1 ? finalCalls[0] : undefined
	const completionInput = record(completionCall?.input)
	const completionReceipt = typeof completionCall?.id === "string" ? receipts.get(completionCall.id) : undefined
	const lastResponseReport =
		finalCalls.length === 0
			? textContent(lastAssistant?.content)
			: completionCall?.name === "attempt_completion" &&
				  (completionInput?.outcome === undefined || completionInput.outcome === "completed") &&
				  completionReceipt?.error === false &&
				  typeof completionInput?.result === "string"
				? completionInput.result
				: undefined
	const terminalReports = (Array.isArray(ui) ? ui : [])
		.map(record)
		.filter(
			(message) =>
				message?.type === "say" &&
				message.say === "completion_result" &&
				message.partial !== true &&
				typeof message.ts === "number" &&
				message.ts >= phaseStart &&
				message.ts < phaseEnd &&
				typeof message.text === "string",
		)
	const terminalReport = terminalReports.length === 1 ? terminalReports[0] : undefined
	// Match the completed phase's canonical final UI row to its last assistant response.
	// Earlier commentary, reasoning, and ordinary tool output cannot establish the final report.
	const searchReport =
		completedPhase &&
		typeof lastResponseReport === "string" &&
		lastResponseReport.trim() &&
		typeof terminalReport?.text === "string" &&
		terminalReport.text.trim() === lastResponseReport.trim()
			? lastResponseReport
			: undefined
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
					[...calls.values()].filter((call) => call.command !== undefined).map((call) => call.command),
				),
			].every((command) => typeof command === "string" && commandResults(command).length <= 2),
		},
		{
			name: "recovery_only_expected_errors",
			passed: [...receipts].every(([id, receipt]) => {
				if (!receipt.error) return true
				const command = observedCommands.find((candidate) => candidate.resultCallIds.includes(id))
				return (
					command !== undefined &&
					allowedErrors.has(command.command) &&
					(command.command === RECOVERY_COMMANDS.rg
						? command.exitCode === 1 || command.exitCode === 127
						: command.exitCode === (phase === "devVerificationUnavailable" ? 2 : 1))
				)
			}),
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
						({ output }) =>
							output.includes("docs/integrations.md") && output.includes("config/assistants.json"),
					),
			},
			{
				name: "search_report_identifies_matches",
				passed:
					typeof searchReport === "string" &&
					searchReport.includes("docs/integrations.md") &&
					searchReport.includes("config/assistants.json"),
			},
		)
	} else if (phase === "devSearchAbsent") {
		checks.push(
			{ name: "search_absence_observed", passed: exited(RECOVERY_COMMANDS.absent, 1) },
			{
				name: "search_absence_reported",
				passed:
					typeof searchReport === "string" &&
					/no\s+(?:\w+(?:-\w+)*\s+){0,3}(?:match|occurrence|reference|result)|no\s+(?:tracked\s+)?(?:repository\s+)?files?\s+contain|not\s+found|does\s+not\s+(?:appear|exist)|absent|0\s+(?:match|occurrence)/i.test(
						searchReport,
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
			.filter(
				(message) =>
					message && typeof message.ts === "number" && message.ts >= phaseStart && message.ts < phaseEnd,
			)
		// A physical turn can complete with an honest report that the requested
		// integration is still unverified. Legacy reports remain readable, but
		// neither their tool name nor its absence proves physical completion.
		const finalBlocked = blocked.find(([id]) => id === completionCall?.id)
		const report =
			reports.length === 0 && finalCalls.length === 0
				? textContent(lastAssistant?.content)
				: finalCalls.length === 1
					? finalBlocked?.[1].input.result
					: undefined
		const finalVerifier = commandResults(RECOVERY_COMMANDS.verify).at(-1)
		checks.push(
			{
				name: "verification_prerequisite_failure_observed",
				passed:
					finalVerifier?.exitCode === 2 && finalVerifier.output.includes("INTEGRATION_CONFIGURATION_MISSING"),
			},
			{
				name: "verification_one_blocked_handoff",
				passed: completedPhase && (reports.length === 0 || (blocked.length === 1 && reports.length === 1)),
			},
			{
				name: "verification_missing_evidence_reported",
				passed: typeof report === "string" && reportsUnverifiedWork(report),
			},
			{
				name: "verification_visible_ordinary_report",
				passed:
					typeof report === "string" &&
					messages.some(
						(message) =>
							message?.type === "say" &&
							(message.say === "text" || message.say === "completion_result") &&
							message.partial !== true &&
							message.text === report,
					),
			},
			{
				name: "verification_no_error_or_success_final",
				passed:
					typeof report === "string" &&
					!claimsVerificationSuccess(report) &&
					!messages.some(
						(message) =>
							message?.type === "say" &&
							(message.say === "error" ||
								(message.say === "completion_result" &&
									(message.partial === true || message.text !== report))),
					),
			},
		)
	}
	return checks
}
