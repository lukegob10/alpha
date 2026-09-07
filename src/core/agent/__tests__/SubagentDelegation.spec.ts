import {
	assertSubagentTaskAuthorities,
	buildSubagentPrompt,
	getReadOnlyAuthorityMismatch,
	normalizeSubagentForkTurns,
	normalizeSubagentTaskDrafts,
	SUBAGENT_REPORT_WORD_BUDGET,
} from "../SubagentDelegation"

describe("buildSubagentPrompt", () => {
	it.each([
		["explore" as const, "Map dependency boundaries", []],
		["review" as const, "Assess recovery invariants", ["Risks", "Evidence"]],
	])("builds generic bounded guidance for %s objectives", (role, objective, expectedOutput) => {
		const prompt = buildSubagentPrompt({ nickname: "Maple", role, objective, expectedOutput })

		expect(prompt).toContain(`Objective: ${objective}`)
		expect(prompt).toContain("Tool results may be bounded, missing, or truncated")
		expect(prompt).toContain("do not silently substitute a different scope")
		expect(prompt).toContain("Once the evidence is sufficient for the objective, synthesize it")
		expect(prompt).toContain(`under ${SUBAGENT_REPORT_WORD_BUDGET} words`)
		expect(prompt).toContain("do not repeat file contents or narrate the research process")
		expect(prompt).toContain("Use report_progress")
		expect(prompt).toContain("immediate parent")
		expect(prompt).toContain("report each distinct update once")
		expect(prompt).toContain("one bounded wait_agent call at a time")
		expect(prompt).toContain("cannot address ancestors, siblings, or other agents")
		expect(prompt).not.toContain("every path explicitly named")
		expect(prompt).not.toContain("at most one locate or search turn")
		expect(prompt).not.toContain("batches of at most eight")
		expect(prompt).not.toMatch(/backend|frontend/i)
	})

	it("keeps evidence guidance general rather than prescribing a discovery recipe", () => {
		const paths = ["README.md", ...Array.from({ length: 8 }, (_, index) => `docs/evidence-${index + 1}.md`)]
		const prompt = buildSubagentPrompt({
			nickname: "Nova",
			role: "review",
			objective: `Review ${paths.join(", ")}`,
			expectedOutput: ["Evidence for every named file"],
		})

		expect(prompt).toContain("adapting discovery to named and unnamed targets")
		expect(prompt).toContain("do not infer absence from incomplete output")
		expect(prompt).not.toContain("Read those paths directly before discovery")
		expect(prompt).not.toContain("more than eight paths")
		expect(prompt).not.toContain("consecutive read_file batches of at most eight")
	})

	it("provides a useful deliverable when expected_output is omitted", () => {
		const prompt = buildSubagentPrompt({
			nickname: "Nova",
			role: "explore",
			objective: "Trace an arbitrary subsystem",
			expectedOutput: [],
		})

		expect(prompt).toContain("Return the findings needed to satisfy the objective")
		expect(prompt).not.toContain("Requested deliverables:\n")
	})

	it("builds a generic editing-worker prompt with an explicit bounded scope", () => {
		const prompt = buildSubagentPrompt({
			nickname: "Maple",
			role: "worker",
			objective: "Add validation to the parser",
			expectedOutput: ["Changed files", "Verification"],
			writeScope: ["src/parser", "src/parser.test.ts"],
		})

		expect(prompt).toContain("editing Worker")
		expect(prompt).toContain("isolated Git worktree")
		expect(prompt).toContain("src/parser")
		expect(prompt).toContain("Do not commit, stage, create branches, or change remotes")
		expect(prompt).toContain("a complete objective may conclude that no repository change is needed")
		expect(prompt).toContain("choose verification proportionate to the work")
		expect(prompt).toContain("including when no change is needed")
		expect(prompt).not.toContain("begin with the edit")
		expect(prompt).not.toContain("Prefer one shell-compatible verification command")
		expect(prompt).not.toContain("at least one authorized change exists")
		expect(prompt).toContain("Use report_progress")
		expect(prompt).toContain("immediate parent")
		expect(prompt).toContain("report each distinct update once")
		expect(prompt).toContain("one bounded wait_agent call at a time")
		expect(prompt).not.toMatch(/specific prompt|single action/i)
	})
})

describe("normalizeSubagentTaskDrafts", () => {
	it("treats strict-schema nulls as omitted for read-only agents", () => {
		expect(
			normalizeSubagentTaskDrafts([
				{
					objective: "  inspect docs  ",
					agent_kind: "explore",
					write_scope: null,
					expected_output: null,
				},
			]),
		).toEqual([{ fork_turns: "none", objective: "inspect docs", agent_kind: "explore" }])
	})

	it("defaults missing legacy fork_turns to none and preserves explicit modes", () => {
		expect(normalizeSubagentForkTurns()).toBe("none")
		expect(normalizeSubagentForkTurns("all")).toBe("all")
		expect(normalizeSubagentForkTurns("3")).toBe("3")
	})

	it.each(["0", "01", "-1", "1.0", "9007199254740992", 1, null])("rejects invalid fork_turns %j", (value) => {
		expect(() => normalizeSubagentForkTurns(value)).toThrow("fork_turns")
	})

	it("preserves a stable model-facing task name", () => {
		expect(
			normalizeSubagentTaskDrafts([
				{
					task_name: "backend_review",
					objective: "inspect backend lifecycle code",
					agent_kind: "review",
					write_scope: null,
					expected_output: null,
				},
			]),
		).toEqual([
			{
				task_name: "backend_review",
				fork_turns: "none",
				objective: "inspect backend lifecycle code",
				agent_kind: "review",
			},
		])
	})

	it.each([
		"BackendReview",
		"backend-review",
		"1backend",
		"backend review",
		"backend_review_name_that_is_far_too_long",
	])("rejects invalid stable task name %j", (taskName) => {
		expect(() =>
			normalizeSubagentTaskDrafts([
				{
					task_name: taskName,
					objective: "inspect backend lifecycle code",
					agent_kind: "review",
				},
			]),
		).toThrow("task_name")
	})

	it("preserves a worker scope and nullable optional deliverables", () => {
		expect(
			normalizeSubagentTaskDrafts([
				{
					objective: "create a fixture",
					agent_kind: "worker",
					write_scope: [" docs/fixture.md "],
					expected_output: null,
				},
			]),
		).toEqual([
			{
				fork_turns: "none",
				objective: "create a fixture",
				agent_kind: "worker",
				write_scope: ["docs/fixture.md"],
			},
		])
	})

	it("discards provider-filled worker scope from read-only roles without widening authority", () => {
		expect(
			normalizeSubagentTaskDrafts([
				{ objective: "inspect docs", agent_kind: "explore", write_scope: ["docs"] },
				{
					objective: "update docs",
					agent_kind: "worker",
					write_scope: ["docs/README.md"],
				},
			]),
		).toEqual([
			{ fork_turns: "none", objective: "inspect docs", agent_kind: "explore" },
			{
				fork_turns: "none",
				objective: "update docs",
				agent_kind: "worker",
				write_scope: ["docs/README.md"],
			},
		])
	})
})

describe("read-only authority preflight", () => {
	it.each([
		["Create docs/smoke-test.md with a short verification note", "repository changes"],
		["Inspect the parser; then update its validation", "repository changes"],
		["Please run the targeted tests", "command execution"],
		["Review the flow. Execute pnpm test afterwards", "command execution"],
	])("detects an explicit imperative mismatch in %j", (objective, mismatch) => {
		expect(getReadOnlyAuthorityMismatch(objective)).toBe(mismatch)
	})

	it.each([
		"Review code that creates files and report any scope risks",
		"Inspect the create and update handlers",
		"Create a concise report of the findings",
		"Write the recommendations in your final response",
		"Run an analysis of cancellation behavior",
	])("does not infer elevated authority from a read-only objective in %j", (objective) => {
		expect(getReadOnlyAuthorityMismatch(objective)).toBeUndefined()
	})

	it("rejects a mismatched role without promoting it or inventing a write scope", () => {
		let error: Error | undefined
		try {
			assertSubagentTaskAuthorities([
				{
					fork_turns: "none",
					objective: "Create docs/subagent-worker-smoke-test.md",
					agent_kind: "explore",
				},
			])
		} catch (cause) {
			error = cause as Error
		}

		expect(error?.message).toContain('tasks[0]: set agent_kind to "worker"')
		expect(error?.message).toContain("provide write_scope")
		expect(error?.message).toContain("do not resubmit the rejected payload unchanged")
	})

	it("permits the same mutating objective when the caller explicitly supplies worker authority", () => {
		expect(() =>
			assertSubagentTaskAuthorities([
				{
					fork_turns: "none",
					objective: "Create docs/subagent-worker-smoke-test.md",
					agent_kind: "worker",
					write_scope: ["docs/subagent-worker-smoke-test.md"],
				},
			]),
		).not.toThrow()
	})
})
