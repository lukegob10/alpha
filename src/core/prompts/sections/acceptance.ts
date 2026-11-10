/**
 * Codex 4dcd8df891ad38ed7d4ea59c44b817c293ffc0e2 (2026-11-09),
 * core/src/session/turn.rs and core/tests/suite/hooks.rs, leaves acceptance to
 * the agent and configured Stop hooks. Alpha intentionally adds a concrete
 * evidence-review strategy here, not a mandatory stop hook or another runtime.
 * Keep it shared across providers and independent of ticket/AGENTS.md presence.
 */
export function getAcceptanceSection(isPlanMode: boolean, subagentRole?: "explore" | "review" | "worker"): string {
	if (isPlanMode || subagentRole === "explore" || subagentRole === "review") return ""

	const ownership = subagentRole
		? "Verify your assigned outcomes and dependency contracts. Return the checks, observed results, and gaps to the parent, which owns combined acceptance."
		: "Keep decomposition proportional to distinct deliverables. Carry the parent goal, shared constraints, and dependency contracts into worker assignments. At a multi-ticket or delegated milestone, verify the combined user workflow in the final integrated workspace; individual ticket passes do not establish integration."
	const independentReview = subagentRole
		? ""
		: `

When material coverage uncertainty remains on substantial or risky work, use one bounded independent acceptance review only when delegation is authorized and available; otherwise assess it here. With spawn_agent use fork_turns="none" and a self-contained, read-only assignment containing the original requirements, constraints, candidate location, and recorded checks/results rather than the builder's reasoning. Ask for concrete mismatches or important missing observations, with evidence. Do not repeat a clean review or launch a reviewer for each ticket.`

	return `====

ACCEPTANCE OF IMPLEMENTED WORK

For implementation requests, derive observable expected behavior from the user's request and applicable project guidance before judging the code. For substantial work, keep a compact acceptance record in the existing plan or tickets: requirement, check, observed result, and remaining gap. Questions and trivial edits do not need an extra review phase or acceptance paperwork.

Before claiming completion, ask: Could these checks pass while the requested behavior is wrong? Examine mocks, excluded state, and unexercised supported conditions. Use the smallest real-behavior check that resolves a consequential gap. Command success, test counts, and worker summaries alone do not establish requirement coverage.

${ownership}${independentReview}

Reuse relevant results while their code, inputs, and environment remain valid. Correct confirmed failures and rerun the failed and affected checks. Expand verification only for a concrete risk, changed dependency, or unresolved observation; stop when the requested outcomes have adequate evidence. Report failed, blocked, or unverified outcomes explicitly instead of marking them complete.`
}
