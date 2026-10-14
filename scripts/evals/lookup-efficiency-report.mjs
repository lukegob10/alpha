import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

const caseFile = new URL("../../evals/lookup-efficiency/cases.json", import.meta.url)
const casesDocument = JSON.parse(await fs.readFile(caseFile, "utf8"))
export const caseIds = new Set(casesDocument.cases.map(({ id }) => id))
export const measurementKinds = [
	"runtime-observation",
	"scripted-harness",
	"reporter-contract-test",
	"live-supplemental",
]
export const SEARCH_TOOLS = ["codebase_search", "search_files", "list_files", "shell"]
export const ALLOWED_FIRST_TOOLS = ["search_files", "read_file", "codebase_search"]
export const DEFAULT_LOOKUP_BAR = {
	maxProviderRequests: 3,
	maxToolResults: 4,
	allowedFirstTools: ALLOWED_FIRST_TOOLS,
}
export const COMPLETION_REASON_CODES = new Set([
	"ready",
	"command_running",
	"receipt_pending",
	"evidence_pending",
	"scope_unavailable",
	"verification_failed",
	"verification_missing",
	"managed_results_pending",
	"descendants_running",
	"child_results_unconsumed",
	"todos_open",
	"persistence_unavailable",
	"runtime_timeout",
	"interrupted",
	"repair_limit",
	"stale_content",
	"unsafe_command",
	"unsupported_command",
	"unsupported_configuration",
	"uncovered_changes",
	"unavailable_scope",
	"missing_change_set",
	"unknown_change_set",
	"unavailable_content",
	"no_test_validation",
	"runtime_scope_unavailable",
])
const REASONING_PREFERENCES = new Set(["none", "low", "medium", "high", "xhigh", "minimal", "default"])
const KNOWN_TOOLS = new Set([
	"list_tickets",
	"read_ticket",
	"create_ticket",
	"update_ticket",
	"delete_ticket",
	"ticket",
	"shell",
	"execute_command",
	"manage_command",
	"read_file",
	"read_command_output",
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"search_files",
	"list_files",
	"use_mcp_tool",
	"access_mcp_resource",
	"discover_tools",
	"ask_followup_question",
	"attempt_completion",
	"new_task",
	"delegate_task",
	"spawn_agent",
	"list_agents",
	"wait_agent",
	"send_message",
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"codebase_search",
	"update_todo_list",
	"run_slash_command",
	"skill",
])
const WORKFLOW_GROUPS = {
	skill: ["skill"],
	ticket: ["ticket", "list_tickets", "read_ticket", "create_ticket", "update_ticket", "delete_ticket"],
	spawn: ["spawn_agent", "new_task", "delegate_task"],
	todo: ["update_todo_list"],
	attemptCompletion: ["attempt_completion"],
}
const MODEL_ID = /^[\w./:+-]{1,128}$/

export function count(value, coverage = "complete") {
	return { value, coverage }
}

export function unavailable(reason) {
	return { value: null, coverage: "unavailable", reason }
}

function finiteCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function normalizeTimestamp(value) {
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
	return new Date(0).toISOString()
}

/**
 * Flatten persisted agent-turn JSONL records or already-normalized EvalTraceEvent
 * rows into the processTask EvalTraceEvent shape. Tool arguments, output, and
 * commands stay on the payload only for local counting; they are never copied
 * into the report.
 */
export function traceFromPersistedAgentTurns(records) {
	if (!Array.isArray(records)) throw new Error("Trace must be an array")
	if (records.length > 100_000) throw new Error("Invalid or oversized trace")
	return records.flatMap((row, index) => {
		if (!row || typeof row !== "object") return []
		if (typeof row.type === "string" && row.type.startsWith("agent.turn.")) {
			return [
				{
					sequence: finiteCount(row.sequence) ? row.sequence : index + 1,
					timestamp: normalizeTimestamp(row.timestamp),
					type: row.type,
					payload: record(row.payload),
				},
			]
		}
		const nested = row.event && typeof row.event === "object" ? row.event : null
		if (!nested || typeof nested.type !== "string") return []
		const { type, ...payload } = nested
		return [
			{
				sequence: finiteCount(row.sequence) ? row.sequence : index + 1,
				timestamp: normalizeTimestamp(row.timestamp),
				type: type.startsWith("agent.turn.") ? type : `agent.turn.${type}`,
				payload,
			},
		]
	})
}

function rawToolName(payload) {
	const name = payload.name ?? payload.tool
	return typeof name === "string" ? name : "unknown"
}

function canonicalToolName(name) {
	if (name === "execute_command") return "shell"
	if (KNOWN_TOOLS.has(name)) return name
	return "other"
}

function metricCoverage(traceCoverage) {
	return traceCoverage === "complete" ? "complete" : "observed"
}

function usageField(source, field) {
	return finiteCount(source?.[field]) ? count(source[field]) : unavailable("Aggregate usage not supplied")
}

function labeledEstimate(source, field, label) {
	return finiteCount(source?.[field])
		? { value: source[field], coverage: "complete", source: label }
		: unavailable("Local estimate not supplied")
}

function matchedRequestUsage(events, annotations) {
	const requests = events.filter(({ type }) => type === "agent.turn.model_request_started")
	const usages = events.filter(({ type }) => type === "agent.turn.request_usage")
	const requestIndexes = requests.map((event) => annotations.get(event.sequence)?.requestIndex)
	const usageIndexes = usages.map((event) => record(event.payload).requestIndex)
	const requestIdentities = new Set(requestIndexes)
	return (
		requestIndexes.every(finiteCount) &&
		usageIndexes.every(finiteCount) &&
		requestIdentities.size === requests.length &&
		new Set(usageIndexes).size === usages.length &&
		requests.length === usages.length &&
		usageIndexes.every((index) => requestIdentities.has(index))
	)
		? usages
		: null
}

function providerReasoningTokens(input, events, annotations, coverage) {
	if (finiteCount(input.usage?.reasoningTokens)) return count(input.usage.reasoningTokens)
	const requestUsage = Array.isArray(input.usage?.requestUsage) ? input.usage.requestUsage : null
	if (requestUsage) {
		if (requestUsage.length === 0) return unavailable("Adapter did not report reasoning tokens")
		if (!requestUsage.every((row) => finiteCount(record(row).reasoningTokens))) {
			return unavailable("Adapter did not report reasoning tokens")
		}
		return count(requestUsage.reduce((sum, row) => sum + record(row).reasoningTokens, 0))
	}
	const usages = matchedRequestUsage(events, annotations)
	if (!usages) return unavailable("Adapter did not report reasoning tokens")
	if (!usages.every((event) => finiteCount(record(event.payload).reasoningTokens))) {
		return unavailable("Adapter did not report reasoning tokens")
	}
	return count(
		usages.reduce((sum, event) => sum + record(event.payload).reasoningTokens, 0),
		coverage,
	)
}

function countRetries(events, coverage) {
	const started = events.filter(({ type }) => type === "agent.turn.model_request_started")
	const retryEvents = events.filter(({ type }) => type === "agent.turn.retry")
	const attempts = started.map((event) => record(event.payload).attempt)
	if (started.length === 0) return count(retryEvents.length, coverage)
	if (attempts.every(finiteCount)) return count(attempts.filter((attempt) => attempt > 0).length, coverage)
	if (retryEvents.length > 0) return count(retryEvents.length, coverage)
	const usageRetries = events.filter(
		({ type, payload }) => type === "agent.turn.request_usage" && record(payload).retry === true,
	)
	if (usageRetries.length > 0) return count(usageRetries.length, coverage)
	return unavailable("Retry identity is not present on model requests")
}

function allowlistedReasonCode(value) {
	return typeof value === "string" && COMPLETION_REASON_CODES.has(value) ? value : null
}

function completionProjection(input, coverage) {
	const stage = record(input.completionStage)
	const codes = Array.isArray(stage.rejectionReasonCodes)
		? stage.rejectionReasonCodes.flatMap((code) => {
				const allowlisted = allowlistedReasonCode(code)
				return allowlisted ? [allowlisted] : []
			})
		: []
	const lastReasonCode = allowlistedReasonCode(stage.lastReasonCode)
	if (
		lastReasonCode &&
		!codes.includes(lastReasonCode) &&
		finiteCount(stage.rejectionCount) &&
		stage.rejectionCount > 0
	) {
		codes.push(lastReasonCode)
	}
	const backgrounded =
		finiteCount(stage.backgroundedCommandsAtFirstAnswer)
			? count(stage.backgroundedCommandsAtFirstAnswer, coverage)
			: finiteCount(record(input.timing).backgroundedCommandsAtFirstAnswer)
				? count(record(input.timing).backgroundedCommandsAtFirstAnswer, coverage)
				: unavailable("Backgrounded-command observer not supplied")
	return {
		candidateCount: finiteCount(stage.candidateCount)
			? count(stage.candidateCount, coverage)
			: unavailable("Completion-stage observer not supplied"),
		rejectionCount: finiteCount(stage.rejectionCount)
			? count(stage.rejectionCount, coverage)
			: unavailable("Completion-stage observer not supplied"),
		lastReasonCode: lastReasonCode
			? count(lastReasonCode, coverage)
			: stage.lastReasonCode === undefined
				? unavailable("Completion-stage observer not supplied")
				: unavailable("Completion reason code is not in the allowlist"),
		reasonCodes: count(codes, coverage),
		backgroundedCommandsAtFirstAnswer: backgrounded,
	}
}

function timingProjection(input) {
	const timing = record(input.timing)
	const field = (name) =>
		finiteCount(timing[name]) ? count(timing[name]) : unavailable("Timing observer not supplied")
	return {
		firstGroundedAnswerMs: field("firstGroundedAnswerMs"),
		durableCompletionMs: field("durableCompletionMs"),
	}
}

function workflowCounts(names, coverage) {
	const counts = Object.fromEntries(
		Object.keys(WORKFLOW_GROUPS).map((group) => [
			group,
			names.filter((name) => WORKFLOW_GROUPS[group].includes(name)).length,
		]),
	)
	return Object.fromEntries(Object.entries(counts).map(([group, value]) => [group, count(value, coverage)]))
}

function projectCounters(events, coverage) {
	const tools = events.filter(({ type }) => type === "agent.turn.tool_result")
	const requests = events.filter(({ type }) => type === "agent.turn.model_request_started")
	const names = tools.map((event) => canonicalToolName(rawToolName(record(event.payload))))
	const byName = new Map()
	for (const name of names) byName.set(name, (byName.get(name) ?? 0) + 1)
	const distinctSearchTools = SEARCH_TOOLS.filter((name) => names.includes(name))
	return {
		providerRequests: count(requests.length, coverage),
		providerRetries: countRetries(events, coverage),
		toolResults: count(tools.length, coverage),
		toolResultsByName: Object.fromEntries(
			[...byName.entries()].map(([name, value]) => [name, count(value, coverage)]),
		),
		distinctSearchTools: count(distinctSearchTools, coverage),
		firstTool: names.length ? count(names[0], coverage) : { value: null, coverage },
		workflowTools: workflowCounts(names, coverage),
	}
}

function unavailableCounters(reason) {
	const workflow = Object.fromEntries(Object.keys(WORKFLOW_GROUPS).map((group) => [group, unavailable(reason)]))
	return {
		providerRequests: unavailable(reason),
		providerRetries: unavailable(reason),
		toolResults: unavailable(reason),
		toolResultsByName: {},
		distinctSearchTools: unavailable(reason),
		firstTool: unavailable(reason),
		workflowTools: workflow,
	}
}

/**
 * Consumes the EvalTraceEvent shape from packages/evals/src/grading/types.ts
 * (and the persisted agent-turn JSONL shape normalized by processTask).
 * Projects allowlisted lookup counters only. Never copies tool arguments, file
 * contents, commands, paths, IDs, or output text.
 */
export function buildReport(input) {
	if (!caseIds.has(input.fixtureId)) throw new Error("Unknown lookup-efficiency fixture")
	if (!measurementKinds.includes(input.measurementKind)) throw new Error("Explicit measurementKind is required")
	if (!["complete", "partial", "unavailable"].includes(input.traceCoverage)) {
		throw new Error("Explicit traceCoverage is required")
	}
	const trace = traceFromPersistedAgentTurns(input.trace ?? [])
	if (input.traceCoverage === "unavailable" && trace.length) throw new Error("Unavailable trace has events")
	const annotations = new Map()
	for (const annotation of input.annotations ?? []) {
		if (!finiteCount(annotation.sequence) || annotations.has(annotation.sequence)) {
			throw new Error("Duplicate or invalid annotation sequence")
		}
		if (annotation.requestIndex !== undefined && !finiteCount(annotation.requestIndex)) {
			throw new Error("Invalid request identity")
		}
		annotations.set(annotation.sequence, annotation)
	}
	const sequences = new Set()
	for (const event of trace) {
		if (!finiteCount(event.sequence) || sequences.has(event.sequence) || typeof event.type !== "string") {
			throw new Error("Duplicate or invalid trace sequence/type")
		}
		sequences.add(event.sequence)
	}
	for (const sequence of annotations.keys()) {
		if (!sequences.has(sequence)) throw new Error("Annotation references missing event")
	}
	const coverage = metricCoverage(input.traceCoverage)
	const counters =
		input.traceCoverage === "unavailable" ? unavailableCounters("Trace unavailable") : projectCounters(trace, coverage)
	const completionRejections = completionProjection(input, coverage)
	if (input.traceCoverage === "unavailable") {
		completionRejections.candidateCount = unavailable("Trace unavailable")
		completionRejections.rejectionCount = unavailable("Trace unavailable")
		completionRejections.lastReasonCode = unavailable("Trace unavailable")
		completionRejections.reasonCodes = unavailable("Trace unavailable")
		completionRejections.backgroundedCommandsAtFirstAnswer = unavailable("Trace unavailable")
	}
	const timing = input.traceCoverage === "unavailable"
		? {
				firstGroundedAnswerMs: unavailable("Trace unavailable"),
				durableCompletionMs: unavailable("Trace unavailable"),
			}
		: timingProjection(input)
	const decisions = ["passed", "outcome_failed", "safety_failed", "grader_error"]
	const outcomes = ["completed", "blocked", "failed", "cancelled"]
	return {
		schemaVersion: 1,
		benchmark: "lookup-efficiency-v1",
		fixtureId: input.fixtureId,
		measurementKind: input.measurementKind,
		traceCoverage: input.traceCoverage,
		sampleIndex: finiteCount(input.sampleIndex) ? input.sampleIndex : null,
		declaredSampleCount: finiteCount(input.declaredSampleCount) ? input.declaredSampleCount : null,
		cacheState: ["cold", "warm"].includes(input.cacheState) ? input.cacheState : "unknown",
		revision: /^[a-f0-9]{40}$/.test(input.revision ?? "") ? input.revision : null,
		workingTree: ["clean", "modified"].includes(input.workingTree) ? input.workingTree : "unknown",
		modelId: typeof input.modelId === "string" && MODEL_ID.test(input.modelId) ? input.modelId : null,
		reasoningPreference: REASONING_PREFERENCES.has(input.reasoningPreference) ? input.reasoningPreference : "unknown",
		correctness: decisions.includes(input.graderDecision) ? input.graderDecision : "unavailable",
		outcome: outcomes.includes(input.outcome) ? input.outcome : "unavailable",
		...counters,
		completionRejections,
		timing,
		reasoningTokens: providerReasoningTokens(input, trace, annotations, coverage),
		localReasoningTokenEstimate: labeledEstimate(input.usage, "localReasoningTokenEstimate", "local-estimator"),
		aggregateUsage: {
			modelCalls: usageField(input.usage, "modelCalls"),
			tokensIn: usageField(input.usage, "tokensIn"),
			tokensOut: usageField(input.usage, "tokensOut"),
			cacheReads: usageField(input.usage, "cacheReads"),
			cacheWrites: usageField(input.usage, "cacheWrites"),
			durationMs: usageField(input.usage, "durationMs"),
		},
	}
}

export function evaluateLookupBar(report, bar = DEFAULT_LOOKUP_BAR) {
	const liveMeasurement =
		report.measurementKind === "runtime-observation" || report.measurementKind === "live-supplemental"
	const requestsPassed =
		report.providerRequests?.coverage !== "unavailable" &&
		finiteCount(report.providerRequests?.value) &&
		report.providerRequests.value <= bar.maxProviderRequests
	const toolsPassed =
		report.toolResults?.coverage !== "unavailable" &&
		finiteCount(report.toolResults?.value) &&
		report.toolResults.value <= bar.maxToolResults
	const firstPassed = bar.allowedFirstTools.includes(report.firstTool?.value)
	const workflowPassed = Object.values(record(report.workflowTools)).every(
		(metric) => metric?.coverage !== "unavailable" && metric?.value === 0,
	)
	const rejectionPassed =
		report.completionRejections?.rejectionCount?.coverage !== "unavailable" &&
		report.completionRejections?.rejectionCount?.value === 0
	const passed = requestsPassed && toolsPassed && firstPassed && workflowPassed && rejectionPassed
	const interpretation = liveMeasurement
		? "Supplemental or runtime observation against the predeclared lookup bar; not a general quality improvement"
		: report.measurementKind === "scripted-harness"
			? "Scripted lookup-efficiency shape; distinct from the NOR-36 scripted 2/1 narrow-lookup fixture"
			: "Reporter/contract fixture; not a live measurement"
	return {
		passed,
		bar: {
			maxProviderRequests: bar.maxProviderRequests,
			maxToolResults: bar.maxToolResults,
			allowedFirstTools: [...bar.allowedFirstTools],
		},
		criteria: {
			providerRequests: { passed: requestsPassed, observed: report.providerRequests },
			toolResults: { passed: toolsPassed, observed: report.toolResults },
			firstTool: { passed: firstPassed, observed: report.firstTool },
			workflowTools: { passed: workflowPassed, observed: report.workflowTools },
			completionRejections: { passed: rejectionPassed, observed: report.completionRejections?.rejectionCount },
		},
		measurementKind: report.measurementKind,
		liveMeasurement,
		interpretation,
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	if (process.argv.length !== 4)
		throw new Error("Usage: node scripts/evals/lookup-efficiency-report.mjs <observations.json> <report.json>")
	const source = await fs.readFile(process.argv[2], "utf8")
	if (Buffer.byteLength(source) > 64 * 1024 * 1024) throw new Error("Observation file exceeds 64 MiB")
	const report = buildReport(JSON.parse(source))
	const document = { ...report, acceptance: evaluateLookupBar(report) }
	await fs.writeFile(process.argv[3], `${JSON.stringify(document, null, 2)}\n`)
}
