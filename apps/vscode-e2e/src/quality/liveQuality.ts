import type { ToolName } from "@alpha-code/types"

/** Retrieval tools whose results can support a claim. Completion text cannot. */
const RETRIEVAL_TOOLS = new Set(["read_file", "search_files"])
const COMPLETION_TOOL = "attempt_completion"

export interface QualityCall {
	name: string
	input?: { result?: unknown }
	result: string
	isError: boolean
}

export interface QualityObservation {
	answer: string
	calls: readonly QualityCall[]
}

export interface DimensionScore {
	name: "groundedness" | "tool_correctness" | "step_efficiency"
	dimension: "groundedness" | "trajectory"
	value: number
	threshold: number
	passed: boolean
	reason: string
}

export interface QualityReport {
	schemaVersion: 1
	id: string
	passed: boolean
	answer: string
	tools: string[]
	scores: DimensionScore[]
}

export interface QualityCase {
	id: string
	tools: readonly ToolName[]
	files: Readonly<Record<string, string>>
	prompt: string
	scope: string
	requestLimit: number
	/** Text the visible answer must contain. For an absence case, the required phrase. */
	expected: string
	forbidden: readonly string[]
	/** Span that must appear in a successful read or search result. */
	evidence: string
	absence?: boolean
	/** Tool names that must occur in order. Extra calls are allowed inside maxSteps. */
	milestones: readonly string[]
	maxSteps: number
}

const ledger = (): string => {
	const lines = ["TICKET-0001 archived"]
	for (let line = 2; line < 1800; line++) lines.push(`archived row ${line}`)
	lines.push("TICKET-1842 active")
	return lines.join("\n")
}

const readTools = ["search_files", "list_files"] as const satisfies readonly ToolName[]

/**
 * Four read-only probes. One live completion scores groundedness and trajectory together.
 * The prompt states the goal. It does not name the tool sequence.
 */
export const LIVE_QUALITY_CASES: readonly QualityCase[] = [
	{
		id: "supported-total",
		tools: readTools,
		files: {
			"live-quality/supported-total/invoice.cjs":
				"// Published note: 900. Comment example: 250.\nexports.total = (items) => items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n",
			"live-quality/supported-total/notes.md": "Invoice total: 900\n",
		},
		prompt: "Items are [{cents:200,quantity:3},{cents:50,quantity:2}]. What number does exports.total in live-quality/supported-total/invoice.cjs return? Reply with only that number.",
		scope: "Work only inside live-quality/supported-total. Read the implementation before answering. Do not edit files, run commands, or delegate.",
		requestLimit: 8,
		expected: "700",
		forbidden: ["900", "250"],
		evidence: "item.cents * item.quantity",
		milestones: ["read_file"],
		maxSteps: 3,
	},
	{
		id: "exported-symbol",
		tools: readTools,
		files: {
			"live-quality/exported-symbol/totals.cjs":
				"function draftTotal() {\n  return 400\n}\nfunction total() {\n  return 250\n}\nmodule.exports = { total }\n",
		},
		prompt: "What number does the exported total function in live-quality/exported-symbol/totals.cjs return? Reply with only that number.",
		scope: "Work only inside live-quality/exported-symbol. Read the implementation before answering. Do not edit files, run commands, or delegate.",
		requestLimit: 8,
		expected: "250",
		forbidden: ["400"],
		evidence: "module.exports = { total }",
		milestones: ["read_file"],
		maxSteps: 3,
	},
	{
		id: "late-span",
		tools: readTools,
		files: {
			"live-quality/late-span/ledger.txt": ledger(),
		},
		prompt: "live-quality/late-span/ledger.txt is long. What is the active ticket id? Reply with only that id.",
		scope: "Work only inside live-quality/late-span. Find the active ticket from the file. Do not edit files, run commands, or delegate.",
		requestLimit: 8,
		expected: "TICKET-1842",
		forbidden: ["TICKET-0001"],
		evidence: "TICKET-1842",
		milestones: ["search_files"],
		maxSteps: 3,
	},
	{
		id: "refund-absence",
		tools: readTools,
		files: {
			"live-quality/refund-absence/shipping.md": "Standard shipping is 5 business days.\n",
		},
		prompt: "What refund window does live-quality/refund-absence/shipping.md state? If none is stated, reply exactly: no refund window is stated",
		scope: "Work only inside live-quality/refund-absence. Read the file before answering. Do not edit files, run commands, or delegate.",
		requestLimit: 8,
		expected: "no refund window is stated",
		forbidden: ["14 days", "30 days", "60 days", "90 days"],
		evidence: "5 business days",
		absence: true,
		milestones: ["read_file"],
		maxSteps: 3,
	},
]

export function visibleAnswer(calls: readonly QualityCall[], transcript: string): string {
	const completed = calls.flatMap((call) => {
		const result = call.name === COMPLETION_TOOL ? call.input?.result : undefined
		return typeof result === "string" && result.trim() ? [result] : []
	})
	return completed.length > 0 ? completed.join("\n") : transcript
}

function contains(haystack: string, needle: string, insensitive = false): boolean {
	if (!needle) return false
	return insensitive ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle)
}

function score(partial: Omit<DimensionScore, "passed">): DimensionScore {
	return { ...partial, passed: partial.value >= partial.threshold }
}

function stepsOf(calls: readonly QualityCall[]): QualityCall[] {
	return calls.filter((call) => call.name !== COMPLETION_TOOL)
}

export function scoreGroundedness(
	spec: Pick<QualityCase, "expected" | "forbidden" | "evidence" | "absence">,
	observation: QualityObservation,
): DimensionScore {
	const retrieved = observation.calls.filter((call) => !call.isError && RETRIEVAL_TOOLS.has(call.name))
	const claim = contains(observation.answer, spec.expected, spec.absence === true)
	const decoysClear = spec.forbidden.every((item) => !contains(observation.answer, item))
	const evidenceFound = retrieved.some((call) => contains(call.result, spec.evidence))
	const hits = [claim, decoysClear, evidenceFound].filter(Boolean).length
	const missing = [claim ? "" : "claim", decoysClear ? "" : "decoy", evidenceFound ? "" : "evidence"].filter(Boolean)
	return score({
		name: "groundedness",
		dimension: "groundedness",
		value: hits / 3,
		threshold: 1,
		reason: missing.length > 0 ? `Missing ${missing.join(", ")}` : "Claim, decoys, and retrieved evidence agree",
	})
}

/** Subsequence match, same rule as harness-evals ToolCorrectness in subsequence mode. */
export function scoreToolCorrectness(milestones: readonly string[], calls: readonly QualityCall[]): DimensionScore {
	const called = stepsOf(calls).map((call) => call.name)
	let matched = 0
	for (const tool of called) {
		if (matched >= milestones.length) break
		if (tool === milestones[matched]) matched++
	}
	const value = milestones.length === 0 ? 0 : matched / milestones.length
	return score({
		name: "tool_correctness",
		dimension: "trajectory",
		value,
		threshold: 1,
		reason: `${matched} of ${milestones.length} expected tools matched in order`,
	})
}

/** 1 when the non-completion calls fit in maxSteps. Extra calls lower the score. */
export function scoreStepEfficiency(maxSteps: number, calls: readonly QualityCall[]): DimensionScore {
	const steps = stepsOf(calls).length
	const value = steps === 0 || maxSteps < 1 ? 0 : Math.min(1, maxSteps / steps)
	return score({
		name: "step_efficiency",
		dimension: "trajectory",
		value,
		threshold: 1,
		reason: steps === 0 ? "No tool calls" : `${steps} tool calls against a budget of ${maxSteps}`,
	})
}

export function scoreQuality(spec: QualityCase, observation: QualityObservation): QualityReport {
	const scores = [
		scoreGroundedness(spec, observation),
		scoreToolCorrectness(spec.milestones, observation.calls),
		scoreStepEfficiency(spec.maxSteps, observation.calls),
	]
	return {
		schemaVersion: 1,
		id: spec.id,
		passed: scores.every((item) => item.passed),
		answer: observation.answer,
		tools: stepsOf(observation.calls).map((call) => call.name),
		scores,
	}
}
