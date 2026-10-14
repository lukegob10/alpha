import * as vscode from "vscode"
import type { TaskWorkPlan } from "@alpha-code/types"

import { Task } from "../Task"
import { decideParentCompletion, type ParentCompletionDecision } from "../../agent/ParentVerification"
import { classifyRequestWorkClass } from "../../agent/requestWorkClass"

const objective =
	"Implement the complete twelve-section product specification: accounts, authentication, billing, search, reports, " +
	"exports, administration, audit, notifications, settings, accessibility, and deployment."

const declaredPlan: TaskWorkPlan = {
	objective,
	constraints: [],
	notes: [],
	checks: [
		{
			id: "all-sections",
			description: "Verify the complete product specification",
			command: "pnpm test",
			cwd: null,
			paths: ["src/app.ts"],
			reusable: true,
		},
	],
}

function fixture(plan?: TaskWorkPlan, latestHumanRequest = objective): Task {
	const history = [{ role: "user", content: objective }]
	if (latestHumanRequest !== objective) history.push({ role: "user", content: latestHumanRequest })
	return Object.assign(Object.create(Task.prototype), {
		taskId: "spec-coverage-investigation",
		taskKind: "primary",
		apiConversationHistory: history,
		metadata: { task: objective },
		todoList: [
			{ id: "accounts", content: "Implement accounts", status: "completed" },
			{ id: "authentication", content: "Implement authentication", status: "completed" },
			{ id: "remaining", content: "Implement the remaining ten specification sections", status: "pending" },
		],
		workContext: plan ? { plan, receipts: [], skills: [] } : undefined,
		workspacePath: process.cwd(),
		commandExecutionEvidence: new Map(),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		completionRuntimeRevision: 0,
		hasPendingAgentMessages: () => false,
		alphaIgnoreController: { validateAccess: () => true },
		providerRef: {
			deref: () => ({
				getParentCompletionDecision: async () => decideParentCompletion([]) satisfies ParentCompletionDecision,
			}),
		},
	}) as Task
}

describe("specification coverage investigation: ordinary completion gate observations", () => {
	let preventOpenTodos = false

	beforeEach(() => {
		preventOpenTodos = false
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (key: string, fallback?: unknown) =>
				key === "preventCompletionWithOpenTodos" ? preventOpenTodos : fallback,
		} as unknown as vscode.WorkspaceConfiguration)
	})

	afterEach(() => vi.restoreAllMocks())

	it("currently admits a partial large-spec candidate when no acceptance checks were registered and open todos are allowed", async () => {
		const task = fixture()
		expect(task.todoList?.filter((item) => item.status !== "completed")).toHaveLength(1)
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
	})

	it("blocks the same candidate when the existing open-todo policy is enabled", async () => {
		preventOpenTodos = true
		expect(await fixture().getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "todos_open",
		})
	})

	it("blocks a full implementation candidate with a registered acceptance check lacking a passed receipt", async () => {
		expect(await fixture(declaredPlan).getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "verification_missing",
		})
	})

	it("currently admits a work plan with no checks because prose scope is not evaluated by the gate", async () => {
		expect(await fixture({ ...declaredPlan, checks: [] }).getCompletionGateDecision()).toMatchObject({
			allowed: true,
			classification: "ready",
		})
	})

	it("preserves a separate lookup reply after an earlier implementation request and its unfinished work plan", async () => {
		expect(await fixture(declaredPlan, "Where is retryLimit defined?").getCompletionGateDecision()).toMatchObject({
			allowed: true,
			classification: "ready",
		})
	})

	it("classifies an interrogative action request as implementation work", () => {
		expect(classifyRequestWorkClass("Can you add all twelve product sections described in SPEC.md?").class).toBe(
			"full",
		)
	})

	it("does not bypass a registered acceptance check when the user phrases the requested mutation as a question", async () => {
		expect(
			await fixture(
				declaredPlan,
				"Can you add all twelve product sections described in SPEC.md?",
			).getCompletionGateDecision(),
		).toMatchObject({ allowed: false, reasonCode: "verification_missing" })
	})
})
