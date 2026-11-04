import * as vscode from "vscode"
import type { TaskWorkPlan } from "@alpha-code/types"
import { Task } from "../Task"
import { decideParentCompletion } from "../../agent/ParentVerification"

const plan: TaskWorkPlan = {
	objective: "Implement all product sections",
	constraints: [],
	notes: [],
	checks: [
		{
			id: "all-sections",
			description: "Verify the product specification",
			command: "pnpm test",
			cwd: null,
			paths: ["src/app.ts"],
			reusable: true,
		},
	],
}

function fixture(request: string) {
	return Object.assign(Object.create(Task.prototype), {
		taskId: "completion-obligations",
		taskKind: "primary",
		apiConversationHistory: [{ role: "user", content: request, input_origin: "human" }],
		workContext: { plan, receipts: [], skills: [] },
		workspacePath: process.cwd(),
		commandExecutionEvidence: new Map(),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		completionRuntimeRevision: 0,
		hasPendingAgentMessages: () => false,
		alphaIgnoreController: { validateAccess: () => true },
		providerRef: { deref: () => ({ getParentCompletionDecision: async () => decideParentCompletion([]) }) },
	}) as Task
}

afterEach(() => vi.restoreAllMocks())

it.each(["failed", "stale", "unavailable", "running"] as const)(
	"retains %s acceptance evidence without making it a completion requirement",
	async (status) => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (_key: string, fallback: unknown) => fallback,
		} as unknown as vscode.WorkspaceConfiguration)
		const task = fixture("Implement all product sections")
		task.workContext!.receipts.push({
			checkId: "all-sections",
			definitionDigest: "declared-check",
			executionId: "check-process",
			status,
			observedAt: 1,
		})
		const before = structuredClone(task.workContext)

		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
		expect(task.workContext).toEqual(before)
	},
)

it.each(["Implement all product sections", "Can you add all product sections described in SPEC.md?"])(
	"keeps registered acceptance evidence advisory for an implementation request: %s",
	async (request) => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (_key: string, fallback: unknown) => fallback,
		} as unknown as vscode.WorkspaceConfiguration)
		expect(await fixture(request).getCompletionGateDecision()).toMatchObject({
			allowed: true,
			reasonCode: "ready",
		})
	},
)

it("permits a separate lookup reply without consuming unfinished implementation checks", async () => {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
	} as unknown as vscode.WorkspaceConfiguration)
	const task = fixture("Where is retryLimit defined?")
	task.apiConversationHistory.unshift({ role: "user", content: plan.objective, input_origin: "human" })
	expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
	expect(task.workContext?.plan?.checks).toHaveLength(1)
	expect(task.workContext?.receipts).toEqual([])
})

it("does not invent acceptance checks from a prose-only work plan", async () => {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
	} as unknown as vscode.WorkspaceConfiguration)
	const task = fixture("Implement all product sections")
	task.workContext = { plan: { ...plan, checks: [] }, receipts: [], skills: [] }

	expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
})
