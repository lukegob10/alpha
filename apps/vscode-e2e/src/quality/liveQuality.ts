import type { ToolName } from "@alpha-code/types"
import { posix as paths } from "node:path"

/** Retrieval tools whose results can support a claim. Completion text cannot. */
const RETRIEVAL_TOOLS = new Set(["exec_command", "read_file", "search_files"])
const COMPLETION_TOOL = "attempt_completion"

export interface QualityCall {
	name: string
	input?: { path?: unknown; files?: unknown; result?: unknown; outcome?: unknown; cmd?: unknown; workdir?: unknown }
	result: string
	isError: boolean
}

export interface QualityObservation {
	answer: string
	calls: readonly QualityCall[]
	/** Captured fixture root. Missing provenance remains readable but cannot earn grounding credit. */
	workspace?: string
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
	/** Additional definition spans required to support the claim, rather than just identify an export. */
	supportingEvidence?: readonly string[]
	/** Fixture file whose successful tool result must contain the evidence. */
	sourcePath: string
	absence?: boolean
	/** Ordered tool milestones; each may allow equivalent actions. Extra calls count against maxSteps. */
	milestones: readonly (string | readonly string[])[]
	maxSteps: number
}

const ledger = (): string => {
	const lines = ["TICKET-0001 archived"]
	for (let line = 2; line < 1800; line++) lines.push(`archived row ${line}`)
	lines.push("TICKET-1842 active")
	return lines.join("\n")
}

const readTools = ["exec_command"] as const satisfies readonly ToolName[]
const readOnlySourceScope = (directory: string): string =>
	`Work only inside ${directory}. Inspect source text with bounded rg searches before answering. Narrow patterns or limit results for long files. Do not execute source files or inline interpreter code. Do not edit files or delegate.`

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
		scope: readOnlySourceScope("live-quality/supported-total"),
		requestLimit: 8,
		expected: "700",
		forbidden: ["900", "250"],
		evidence: "exports.total = (items) => items.reduce((sum, item) => sum + item.cents * item.quantity, 0)",
		sourcePath: "live-quality/supported-total/invoice.cjs",
		milestones: ["exec_command"],
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
		scope: readOnlySourceScope("live-quality/exported-symbol"),
		requestLimit: 8,
		expected: "250",
		forbidden: ["400"],
		evidence: "module.exports = { total }",
		supportingEvidence: ["function total() { return 250"],
		sourcePath: "live-quality/exported-symbol/totals.cjs",
		milestones: ["exec_command"],
		maxSteps: 3,
	},
	{
		id: "late-span",
		tools: readTools,
		files: {
			"live-quality/late-span/ledger.txt": ledger(),
		},
		prompt: "live-quality/late-span/ledger.txt is long. What is the active ticket id? Reply with only that id.",
		scope: readOnlySourceScope("live-quality/late-span"),
		requestLimit: 8,
		expected: "TICKET-1842",
		forbidden: ["TICKET-0001"],
		evidence: "TICKET-1842",
		sourcePath: "live-quality/late-span/ledger.txt",
		milestones: ["exec_command"],
		maxSteps: 3,
	},
	{
		id: "refund-absence",
		tools: readTools,
		files: {
			"live-quality/refund-absence/shipping.md": "Standard shipping is 5 business days.\n",
		},
		prompt: "What refund window does live-quality/refund-absence/shipping.md state? If none is stated, reply exactly: no refund window is stated",
		scope: readOnlySourceScope("live-quality/refund-absence"),
		requestLimit: 8,
		expected: "no refund window is stated",
		forbidden: ["14 days", "30 days", "60 days", "90 days"],
		evidence: "5 business days",
		sourcePath: "live-quality/refund-absence/shipping.md",
		absence: true,
		milestones: ["exec_command"],
		maxSteps: 3,
	},
]

/** Calls belong to the final assistant response; earlier commentary and candidates are not final output. */
export function visibleAnswer(calls: readonly QualityCall[], finalAssistantText: string): string {
	if (finalAssistantText.trim()) return finalAssistantText
	const completion = calls.at(-1)
	if (
		completion?.name !== COMPLETION_TOOL ||
		completion.isError ||
		(completion.input?.outcome !== undefined && completion.input.outcome !== "completed")
	)
		return ""
	const result = completion.input?.result
	if (typeof result !== "string" || !result.trim()) return ""
	const receipt = completion.result.trim()
	if (receipt === "" || receipt === "(tool did not return anything)") return result
	try {
		const terminal: unknown = JSON.parse(receipt)
		return terminal !== null &&
			typeof terminal === "object" &&
			!Array.isArray(terminal) &&
			"status" in terminal &&
			terminal.status === "success" &&
			"outcome" in terminal &&
			terminal.outcome === "completed"
			? result
			: ""
	} catch {
		return ""
	}
}

function absolutePath(value: string, base?: string): string | undefined {
	const normalized = value.replaceAll("\\", "/")
	if (!paths.isAbsolute(normalized) && !/^[a-z]:\//i.test(normalized) && !base) return undefined
	const resolved = paths.normalize(
		base && !paths.isAbsolute(normalized) && !/^[a-z]:\//i.test(normalized) ? `${base}/${normalized}` : normalized,
	)
	return /^[a-z]:\//i.test(resolved) ? resolved.toLowerCase() : resolved
}

function sourceMatches(value: unknown, sourcePath: string, workspace: string, workdir = workspace): boolean {
	return typeof value === "string" && absolutePath(value, workdir) === absolutePath(sourcePath, workspace)
}

/** Only simple read commands can establish provenance; paths in patterns or shell code cannot. */
function commandWords(command: string): string[] | undefined {
	const words: string[] = []
	let word = ""
	let quote: string | undefined
	for (const character of command) {
		if (quote) {
			if (character === quote) quote = undefined
			else word += character
		} else if (character === '"' || character === "'") quote = character
		else if (/[;&|<>\r\n`]/.test(character)) return undefined
		else if (/\s/.test(character)) {
			if (word) words.push(word)
			word = ""
		} else word += character
	}
	if (quote || command.includes("$(")) return undefined
	if (word) words.push(word)
	return words
}

function commandSource(command: string): string | undefined {
	const words = commandWords(command)
	const executable = words
		?.shift()
		?.replaceAll("\\", "/")
		.split("/")
		.at(-1)
		?.replace(/\.exe$/i, "")
	if (!words || (executable !== "rg" && executable !== "cut")) return undefined
	const valueOptions =
		executable === "rg"
			? new Set([
					"-e",
					"--regexp",
					"-f",
					"--file",
					"-g",
					"--glob",
					"--iglob",
					"-t",
					"--type",
					"-T",
					"--type-not",
					"-A",
					"--after-context",
					"-B",
					"--before-context",
					"-C",
					"--context",
					"-m",
					"--max-count",
					"-M",
					"--max-columns",
					"--max-filesize",
					"-E",
					"--encoding",
					"-j",
					"--threads",
				])
			: new Set([
					"-b",
					"--bytes",
					"-c",
					"--characters",
					"-f",
					"--fields",
					"-d",
					"--delimiter",
					"--output-delimiter",
				])
	const operands: string[] = []
	let optionsEnded = false
	let explicitPattern = false
	for (let index = 0; index < words.length; index++) {
		const word = words[index]!
		if (!optionsEnded && word === "--") {
			optionsEnded = true
			continue
		}
		if (!optionsEnded && word.startsWith("-")) {
			// Replacements, custom delimiters, and preprocessors can synthesize the
			// expected definition without retrieving its original source text.
			if (/^--(?:replace|pre|output-delimiter)(?:=|$)/.test(word)) return undefined
			if (executable === "rg" && !word.startsWith("--")) {
				for (const option of word.slice(1)) {
					if (option === "r") return undefined
					if (valueOptions.has(`-${option}`)) break
				}
			}
			if (/^(?:-e.+|-(?:e|f)|--(?:regexp|file)(?:=.*)?)$/.test(word)) explicitPattern = true
			if (valueOptions.has(word)) {
				if (++index >= words.length) return undefined
			} else if (/^-[A-Za-z]\d+$/.test(word) || word.includes("=")) continue
			continue
		}
		operands.push(word)
	}
	if (executable === "rg" && !explicitPattern) operands.shift()
	return operands.length === 1 ? operands[0] : undefined
}

function retrievedSource(call: QualityCall, sourcePath: string, workspace: string): boolean {
	if (call.isError) return false
	if (call.name === "exec_command") {
		if (typeof call.input?.cmd !== "string") return false
		const workdir = typeof call.input.workdir === "string" ? absolutePath(call.input.workdir) : workspace
		return workdir !== undefined && sourceMatches(commandSource(call.input.cmd), sourcePath, workspace, workdir)
	}
	if (call.name === "read_file") {
		if (sourceMatches(call.input?.path, sourcePath, workspace)) return true
		return (
			Array.isArray(call.input?.files) &&
			call.input.files.length === 1 &&
			call.input.files.some(
				(file) =>
					file !== null &&
					typeof file === "object" &&
					sourceMatches((file as { path?: unknown }).path, sourcePath, workspace),
			)
		)
	}
	if (call.name === "search_files") return sourceMatches(call.input?.path, sourcePath, workspace)
	return false
}

function normalizedEvidence(value: string): string {
	return value
		.replace(/^(?:[^:\r\n]+:)*\s*\d+[:-]\s?/gm, "")
		.replace(/\s+/g, " ")
		.trim()
}

function score(partial: Omit<DimensionScore, "passed">): DimensionScore {
	return { ...partial, passed: partial.value >= partial.threshold }
}

function stepsOf(calls: readonly QualityCall[]): QualityCall[] {
	return calls.filter((call) => call.name !== COMPLETION_TOOL)
}

export function scoreGroundedness(
	spec: Pick<QualityCase, "expected" | "forbidden" | "evidence" | "supportingEvidence" | "sourcePath" | "absence">,
	observation: QualityObservation,
): DimensionScore {
	const answer = observation.answer.trim()
	const claim =
		spec.absence === true ? answer.toLowerCase() === spec.expected.toLowerCase() : answer === spec.expected
	const decoysClear = spec.forbidden.every((item) => !answer.includes(item))
	const workspace = observation.workspace && absolutePath(observation.workspace)
	const retrieved = workspace
		? observation.calls
				.filter((call) => RETRIEVAL_TOOLS.has(call.name) && retrievedSource(call, spec.sourcePath, workspace))
				.map((call) => normalizedEvidence(call.result))
		: []
	const evidenceFound = [spec.evidence, ...(spec.supportingEvidence ?? [])].every((span) =>
		retrieved.some((result) => result.includes(normalizedEvidence(span))),
	)
	const hits = [claim, decoysClear, evidenceFound].filter(Boolean).length
	const missing = [
		claim ? "" : "claim",
		decoysClear ? "" : "decoy",
		evidenceFound ? "" : workspace ? "evidence" : "workspace provenance",
	].filter(Boolean)
	return score({
		name: "groundedness",
		dimension: "groundedness",
		value: hits / 3,
		threshold: 1,
		reason: missing.length > 0 ? `Missing ${missing.join(", ")}` : "Claim, decoys, and retrieved evidence agree",
	})
}

/** Match successful tools in order; equivalent retrieval actions may satisfy one milestone. */
export function scoreToolCorrectness(
	milestones: readonly (string | readonly string[])[],
	calls: readonly QualityCall[],
): DimensionScore {
	const called = stepsOf(calls)
		.filter((call) => !call.isError)
		.map((call) => call.name)
	let matched = 0
	for (const tool of called) {
		if (matched >= milestones.length) break
		const expected = milestones[matched]
		if (typeof expected === "string" ? tool === expected : expected?.includes(tool)) matched++
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
