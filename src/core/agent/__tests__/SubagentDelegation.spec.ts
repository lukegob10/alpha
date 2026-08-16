import {
	assertSubagentTaskAuthorities,
	buildSubagentPrompt,
	getReadOnlyAuthorityMismatch,
	getWorkerCompletionError,
	normalizeSubagentTaskDrafts,
	SUBAGENT_REPORT_WORD_BUDGET,
	WORKER_NO_CHANGES_ERROR,
} from "../SubagentDelegation"

describe("buildSubagentPrompt", () => {
	it.each([
		["explore" as const, "Map dependency boundaries", []],
		["review" as const, "Assess recovery invariants", ["Risks", "Evidence"]],
	])("builds generic bounded guidance for %s objectives", (role, objective, expectedOutput) => {
		const prompt = buildSubagentPrompt({ nickname: "Maple", role, objective, expectedOutput })

		expect(prompt).toContain(`Objective: ${objective}`)
		expect(prompt).toContain("every path explicitly named")
		expect(prompt).toContain("at most one locate or search turn")
		expect(prompt).toContain("batches of at most eight")
		expect(prompt).toContain("do not silently substitute a different scope")
		expect(prompt).toContain("a direct read establishes")
		expect(prompt).toContain("unrelated hidden or support directories")
		expect(prompt).toContain(`under ${SUBAGENT_REPORT_WORD_BUDGET} words`)
		expect(prompt).toContain("do not repeat file contents or narrate the research process")
		expect(prompt).not.toMatch(/backend|frontend/i)
	})

	it("requires every explicitly named path even when more than one read batch is needed", () => {
		const paths = ["README.md", ...Array.from({ length: 8 }, (_, index) => `docs/evidence-${index + 1}.md`)]
		const prompt = buildSubagentPrompt({
			nickname: "Nova",
			role: "review",
			objective: `Review ${paths.join(", ")}`,
			expectedOutput: ["Evidence for every named file"],
		})

		expect(prompt).toContain("Read those paths directly before discovery")
		expect(prompt).toContain("more than eight paths")
		expect(prompt).toContain("consecutive read_file batches of at most eight")
		expect(prompt).toContain("every named path returns contents or a direct read error")
		expect(prompt).toContain("never infer that an exact path is absent from listing or search output")
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
		expect(prompt).toContain("begin with the edit instead of broad repository reconnaissance")
		expect(prompt).toContain("Do not run Git status or diff solely to enumerate changed files")
		expect(prompt).toContain("Prefer one shell-compatible verification command")
		expect(prompt).toContain("at least one authorized change exists")
		expect(prompt).not.toMatch(/specific prompt|single action/i)
	})

	it("requires a captured delta before treating an editing worker as complete", () => {
		expect(getWorkerCompletionError("completed", [])).toBe(WORKER_NO_CHANGES_ERROR)
		expect(getWorkerCompletionError("completed", ["src/parser.ts"])).toBeUndefined()
		expect(getWorkerCompletionError("timed_out", [])).toBeUndefined()
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
		).toEqual([{ objective: "inspect docs", agent_kind: "explore" }])
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
			{ objective: "inspect docs", agent_kind: "explore" },
			{
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
					objective: "Create docs/subagent-worker-smoke-test.md",
					agent_kind: "worker",
					write_scope: ["docs/subagent-worker-smoke-test.md"],
				},
			]),
		).not.toThrow()
	})
})
