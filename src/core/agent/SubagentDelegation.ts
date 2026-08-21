import { subagentForkTurnsSchema, type SubagentForkTurns, type SubagentGroupState } from "@alpha-code/types"

import type { InternalTaskEnvelope } from "./InternalTaskEnvelope"

export type SubagentTaskDraft =
	| {
			task_name?: string
			fork_turns: SubagentForkTurns
			objective: string
			agent_kind: "explore" | "review"
			expected_output?: string[]
	  }
	| {
			task_name?: string
			fork_turns: SubagentForkTurns
			objective: string
			agent_kind: "worker"
			write_scope: string[]
			expected_output?: string[]
	  }

const DELEGATED_TASK_FIELDS = new Set([
	"task_name",
	"fork_turns",
	"objective",
	"agent_kind",
	"write_scope",
	"expected_output",
])
const SUBAGENT_TASK_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const OBJECTIVE_CLAUSE_BOUNDARY = /[\r\n.!?;]+|\b(?:and\s+then|then|after\s+that|afterwards)\b/gi
const MUTATION_VERBS = new Set([
	"add",
	"apply",
	"create",
	"delete",
	"edit",
	"fix",
	"format",
	"generate",
	"implement",
	"migrate",
	"modify",
	"move",
	"patch",
	"refactor",
	"remove",
	"rename",
	"replace",
	"scaffold",
	"update",
	"write",
])
const REPORT_ONLY_TARGET =
	/^\s+(?:(?:a|an|the|your)\s+)?(?:(?:brief|concise|detailed|final|one-line|self-contained|written)\s+)*(?:analysis|assessment|conclusions?|evidence|explanation|findings|inventory|list|map|notes?|observations?|recommendations?|report|response|review|risks?|summary)\b/i
const REPORT_ONLY_DESTINATION =
	/\b(?:in|into|to|within)\s+(?:(?:the|your)\s+)?(?:findings|notes?|recommendations?|report|response|review|summary)\b/i
const COMMAND_TARGET =
	/^\s+(?:(?:a|an|the)\s+)?(?:(?:existing|full|integration|local|relevant|targeted|unit)\s+)*(?:build|checks?|commands?|formatter|formatting|lint|linter|npm|pnpm|scripts?|test suite|tests?|type-?check|verification|vitest|yarn)\b/i

type ReadOnlyAuthorityMismatch = "command execution" | "repository changes"

/** Missing values are accepted only for legacy/internal callers and inherit no parent turns. */
export function normalizeSubagentForkTurns(value: unknown = undefined): SubagentForkTurns {
	if (value === undefined) return "none"

	const parsed = subagentForkTurnsSchema.safeParse(value)
	if (!parsed.success) {
		throw new Error("fork_turns must be 'none', 'all', or a canonical positive safe-integer string")
	}
	return parsed.data
}

/**
 * Detect only explicit imperative authority mismatches. This intentionally avoids
 * trying to infer an editing role or write scope from ambiguous natural language.
 */
export function getReadOnlyAuthorityMismatch(objective: string): ReadOnlyAuthorityMismatch | undefined {
	for (const rawClause of objective.split(OBJECTIVE_CLAUSE_BOUNDARY)) {
		const clause = rawClause.trim().replace(/^(?:(?:[-*]|\d+[.)])\s*)?(?:please\s+)?/i, "")
		const match = /^([a-z]+)\b(.*)$/i.exec(clause)
		if (!match) continue

		const verb = match[1].toLowerCase()
		const target = match[2]
		if (MUTATION_VERBS.has(verb)) {
			if (REPORT_ONLY_TARGET.test(target) || REPORT_ONLY_DESTINATION.test(target)) continue
			return "repository changes"
		}
		if ((verb === "run" || verb === "execute") && COMMAND_TARGET.test(target)) {
			return "command execution"
		}
	}

	return undefined
}

/** Reject a declared read-only role before capacity, approval, or child launch when its objective needs more authority. */
export function assertSubagentTaskAuthorities(drafts: readonly SubagentTaskDraft[]): void {
	for (const [index, draft] of drafts.entries()) {
		if (draft.agent_kind === "worker") continue
		const mismatch = getReadOnlyAuthorityMismatch(draft.objective)
		if (!mismatch) continue

		const prefix = `Sub-agent task ${index + 1} declares read-only role "${draft.agent_kind}", but its objective explicitly requests ${mismatch}.`
		if (mismatch === "repository changes") {
			throw new Error(
				`${prefix} Correction required for tasks[${index}]: set agent_kind to "worker" and provide write_scope with only user-approved workspace-relative paths. Submit one corrected delegate_task call; do not resubmit the rejected payload unchanged.`,
			)
		}
		throw new Error(
			`${prefix} Keep command-only work in the parent task; use a worker only when scoped file changes are also required.`,
		)
	}
}

/** Normalize provider output and derive the narrowest authority allowed by the selected role. */
export const normalizeSubagentTaskDrafts = (input: unknown): SubagentTaskDraft[] => {
	if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
		throw new Error("delegate_task requires one or two tasks")
	}

	return input.map((value, index) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Sub-agent task ${index + 1} is invalid`)
		}
		const draft = value as Record<string, unknown>
		if (Object.keys(draft).some((key) => !DELEGATED_TASK_FIELDS.has(key))) {
			throw new Error(`Sub-agent task ${index + 1} contains unsupported authority fields`)
		}

		const objective = typeof draft.objective === "string" ? draft.objective.trim() : ""
		if (!objective) throw new Error(`Sub-agent task ${index + 1} requires an objective`)
		const forkTurns = normalizeSubagentForkTurns(draft.fork_turns)
		let taskName: string | undefined
		if (draft.task_name !== undefined) {
			taskName = typeof draft.task_name === "string" ? draft.task_name.trim() : ""
			if (!SUBAGENT_TASK_NAME_PATTERN.test(taskName)) {
				throw new Error(
					`Sub-agent task ${index + 1} has invalid task_name; use 1-32 lowercase letters, digits, or underscores, starting with a letter`,
				)
			}
		}
		if (!(["explore", "review", "worker"] as const).includes(draft.agent_kind as any)) {
			throw new Error(`Sub-agent task ${index + 1} requires agent_kind explore, review, or worker`)
		}

		let expectedOutput: string[] | undefined
		if (draft.expected_output != null) {
			if (!Array.isArray(draft.expected_output)) {
				throw new Error(`Sub-agent task ${index + 1} has invalid expected_output`)
			}
			expectedOutput = draft.expected_output.map((item) => (typeof item === "string" ? item.trim() : ""))
			if (expectedOutput.some((item) => !item)) {
				throw new Error(`Sub-agent task ${index + 1} has an invalid expected_output entry`)
			}
		}

		if (draft.agent_kind === "worker") {
			if (!Array.isArray(draft.write_scope)) {
				throw new Error(`Worker task ${index + 1} requires write_scope`)
			}
			const writeScope = draft.write_scope.map((item) => (typeof item === "string" ? item.trim() : ""))
			if (writeScope.some((item) => !item)) {
				throw new Error(`Worker task ${index + 1} has an invalid write_scope entry`)
			}
			return {
				...(taskName ? { task_name: taskName } : {}),
				fork_turns: forkTurns,
				objective,
				agent_kind: "worker" as const,
				write_scope: writeScope,
				...(expectedOutput ? { expected_output: expectedOutput } : {}),
			}
		}

		// Some strict-schema providers have been observed filling a field from a different
		// union branch. The role is the authority boundary, so discard worker-only scope
		// instead of failing a safe read-only delegation or accidentally granting writes.
		return {
			...(taskName ? { task_name: taskName } : {}),
			fork_turns: forkTurns,
			objective,
			agent_kind: draft.agent_kind,
			...(expectedOutput ? { expected_output: expectedOutput } : {}),
		} as SubagentTaskDraft
	})
}

interface SubagentPromptOptions {
	nickname: string
	role: "explore" | "review" | "worker"
	objective: string
	expectedOutput: string[]
	writeScope?: string[]
	canDelegate?: boolean
	delegationPolicy?: "explicit-only" | "proactive"
	depth?: number
	maxDepth?: number
}

export const SUBAGENT_REPORT_WORD_BUDGET = 900
export const WORKER_NO_CHANGES_ERROR =
	"Worker reported completion, but no changes were captured in its approved write scope."

/** A Worker is an editing role, so a successful run must produce an authorized repository delta. */
export function getWorkerCompletionError(status: string, changedFiles: readonly string[]): string | undefined {
	return status === "completed" && changedFiles.length === 0 ? WORKER_NO_CHANGES_ERROR : undefined
}

/** Build a domain-agnostic prompt for any bounded read-only objective. */
export function buildSubagentPrompt({
	nickname,
	role,
	objective,
	expectedOutput,
	writeScope,
	canDelegate = false,
	delegationPolicy = "explicit-only",
	depth,
	maxDepth,
}: SubagentPromptOptions): string {
	const roleLabel = role === "explore" ? "Explorer" : role === "review" ? "Reviewer" : "Worker"
	const deliverables = expectedOutput.length
		? `Requested deliverables:\n${expectedOutput.map((item) => `- ${item}`).join("\n")}`
		: "Requested deliverable: Return the findings needed to satisfy the objective."
	const delegationGuidance = canDelegate
		? [
				`Managed delegation is available within this task's frozen ${delegationPolicy} policy and depth ${depth ?? "?"}/${maxDepth ?? "?"}.`,
				delegationPolicy === "explicit-only"
					? "Use spawn_agent only to carry out the explicit user-authorized delegation already represented in this task; do not invent additional proactive fan-out."
					: "You may delegate a bounded, independent subtask when it materially advances the objective.",
				"You may control only descendants in your own managed subtree. Observe results through the mailbox and return a self-contained report to your direct parent.",
			].join(" ")
		: "Do not create tasks or delegate."
	const progressGuidance =
		"Use report_progress for a concise update to your immediate parent when useful; report each distinct update once because it cannot address ancestors, siblings, or other agents. If you must remain active while awaiting immediate-parent control, make one bounded wait_agent call at a time instead of repeating progress, polling, messaging ancestors, or attempting completion."

	if (role === "worker") {
		return [
			`You are ${nickname}, an Alpha editing Worker sub-agent managed by a parent task.`,
			`Objective: ${objective}`,
			`Authorized write scope:\n${(writeScope ?? []).map((item) => `- ${item}`).join("\n")}`,
			`Work directly in your isolated Git worktree. You may read repository files broadly, but may edit only the authorized paths above. Do not modify .git, escape the workspace, access the network or MCP, ask the user questions, or switch modes. ${delegationGuidance}`,
			progressGuidance,
			"Make the smallest complete implementation. When the objective and write scope already specify the complete small change, begin with the edit instead of broad repository reconnaissance; inspect only sources needed for correctness or established conventions.",
			"Use commands only for targeted local verification; command and protected-write approvals remain separately governed. Prefer one shell-compatible verification command that covers the requested checks. If a command itself is malformed, correct it once and report both outcomes. Do not run Git status or diff solely to enumerate changed files because the host captures and scope-checks the final delta.",
			"Do not commit, stage, create branches, or change remotes.",
			"Before finishing, inspect your edits, list every changed file, report targeted verification and remaining risks. Never expose the private worktree path.",
			"Call attempt_completion with outcome completed only after the objective is complete and at least one authorized change exists. If the objective cannot be completed, report the constraint with outcome blocked instead of implying success.",
			deliverables,
		].join("\n\n")
	}

	return [
		`You are ${nickname}, an Alpha read-only ${roleLabel} sub-agent managed by a parent task.`,
		`Objective: ${objective}`,
		`Inspect the repository independently and report evidence. You may only read, list, search, use codebase search, and use any explicitly granted managed-agent lifecycle tools. Do not edit files, run commands, access the network or MCP, ask the user questions, or switch modes. ${delegationGuidance}`,
		progressGuidance,
		"Stay within the assigned evidence scope. If a requested location or source is missing, say so explicitly; do not silently substitute a different scope. Use nearby evidence only when clearly labeled as supplemental, and report blocked when the requested deliverable cannot be supported.",
		"If the assigned objective requires an edit or command despite these limits, state that authority mismatch explicitly and finish with outcome blocked.",
		"Treat every path explicitly named by the current objective as already located and required evidence. Read those paths directly before discovery; do not use list_files or search_files to confirm an exact path, and never infer that an exact path is absent from listing or search output, especially truncated output. If the objective names more than eight paths, use consecutive read_file batches of at most eight until every named path returns contents or a direct read error.",
		"Keep discovery for unnamed targets bounded: use at most one locate or search turn, then read related independent files in batches of at most eight. Do not read one known file per turn. Once every required target has been attempted and the evidence is sufficient, reserve the next turn for synthesis.",
		"If a direct read establishes that a named target is absent from the current workspace, report that exact failure. Do not spend remaining turns searching unrelated hidden or support directories unless the objective identifies them as evidence sources.",
		"Your research window ends before the hard timeout. When additional reads are no longer allowed, immediately synthesize the evidence already collected instead of retrying a research tool.",
		`Keep the final report proportional to the objective and under ${SUBAGENT_REPORT_WORD_BUDGET} words unless extra detail is required for correctness. Prioritize requested deliverables, evidence, uncertainty, and actionable conclusions; do not repeat file contents or narrate the research process.`,
		"When finished, call attempt_completion once with outcome completed and a concise, self-contained report. Use outcome blocked if a constraint prevented the objective. Include concrete file references where useful.",
		deliverables,
	].join("\n\n")
}

export interface PreparedSubagentGroup {
	group: SubagentGroupState
	envelopes: InternalTaskEnvelope[]
	/** Explicit-only policy must bypass automatic tool approval before launch. */
	requiresExplicitApproval?: boolean
}

export interface SubagentToolResult {
	groupId: string
	status: "completed" | "partial" | "failed" | "cancelled" | "timed_out"
	agents: Array<{
		taskId: string
		nickname: string
		role: "explore" | "review" | "worker"
		status: string
		summary?: string
		error?: string
		changedFiles?: string[]
		verification?: import("@alpha-code/types").SubagentVerification[]
		changeSet?: import("@alpha-code/types").SubagentChangeSetState
		usage: import("@alpha-code/types").SubagentRunState["usage"]
	}>
}
