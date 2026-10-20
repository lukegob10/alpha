import { AlphaProvider } from "../AlphaProvider"
import { hashAgentTurnEvidenceId } from "../../agent/AgentTurnEventLog"
import type { Task } from "../../task/Task"

function fixture() {
	const secret = "private-backend-canary"
	const task = {
		taskId: "selected-task",
		instanceId: "instance",
		taskStatus: "interactive",
		taskKind: "primary",
		taskAsk: { ask: "tool", text: secret },
		apiConfiguration: { apiProvider: "vscode-lm", apiKey: secret },
		api: { getModel: vi.fn(() => ({ id: secret, info: { private: secret } })) },
		queuedMessages: [{ id: "selected-receipt", text: secret, deliveryState: "delivering" }],
		getCommandExecutionEvidence: vi.fn(() => []),
		getCompletionStageMetrics: vi.fn(() => ({})),
		abortTask: vi.fn(),
		start: vi.fn(),
	} as unknown as Task
	const provider = {
		getTaskOwner: vi.fn(() => undefined),
		getAgentControlRootTaskId: vi.fn(() => task.taskId),
		getAgentLifecycleSnapshot: vi.fn(() => ({
			status: "in_progress",
			phase: "awaiting_approval",
			items: [{ type: "approval", approvalId: "approval", status: "requested", reason: secret }],
		})),
		context: { globalState: { get: vi.fn(() => "started") } },
		contextProxy: {
			isInitialized: true,
			getValue: vi.fn(() => [
				{ availability: "invalid", name: secret, invalidFields: [secret] },
				{ availability: "unsupported", name: secret },
				{ name: secret },
			]),
		},
		providerSettingsManager: { listConfig: vi.fn() },
		agentControlStore: {
			getVerificationObligations: vi.fn(() => []),
			getPendingMailboxDiagnostics: vi.fn(() => ({
				available: true,
				pendingCount: 1,
				claimedCount: 1,
				entries: [{ eventId: "mail", kind: "result", claimId: "claim", payload: secret }],
			})),
		},
	} as unknown as AlphaProvider
	return { task, provider, secret }
}

describe("AlphaProvider diagnostic observation", () => {
	it("uses the selected task's backend identity and cached profile availability without taking storage locks", () => {
		const { task, provider, secret } = fixture()

		const result = AlphaProvider.prototype.getTaskSettlementDiagnostics.call(provider, task)

		expect(result.incident).toMatchObject({
			task: { status: "interactive", ask: "tool" },
			provider: { provider: "vscode-lm", modelIdSha256: hashAgentTurnEvidenceId(secret) },
			lifecycle: { phase: "awaiting_approval", pendingApprovalCount: 1 },
			humanInput: { deliveringCount: 1 },
			mailbox: { pendingCount: 1, claimedCount: 1 },
			setup: {
				contextInitialized: true,
				subagentBudgetDefaultsMigration: "started",
				profiles: { available: true, source: "cached", total: 3, invalid: 1, unsupported: 1 },
			},
		})
		expect(provider.contextProxy.getValue).toHaveBeenCalledWith("listApiConfigMeta")
		expect(provider.providerSettingsManager.listConfig).not.toHaveBeenCalled()
		expect(task.abortTask).not.toHaveBeenCalled()
		expect(task.start).not.toHaveBeenCalled()
		expect(JSON.stringify(result)).not.toContain(secret)
	})

	it("records unavailable setup/control evidence independently while preserving the rest of the snapshot", () => {
		const { task, provider, secret } = fixture()
		vi.mocked(task.api.getModel).mockImplementation(() => {
			throw new Error(secret)
		})
		vi.mocked(provider.contextProxy.getValue).mockImplementation(() => {
			throw new Error(secret)
		})
		vi.mocked(provider.context.globalState.get).mockImplementation(() => {
			throw new Error(secret)
		})
		vi.mocked(provider.getAgentLifecycleSnapshot).mockImplementation(() => {
			throw new Error(secret)
		})
		const store = (
			provider as unknown as { agentControlStore: { getVerificationObligations: ReturnType<typeof vi.fn> } }
		).agentControlStore
		store.getVerificationObligations.mockImplementation(() => {
			throw new Error(secret)
		})

		const result = AlphaProvider.prototype.getTaskSettlementDiagnostics.call(provider, task)

		expect(result.incident).toMatchObject({
			provider: { provider: "vscode-lm" },
			humanInput: { deliveringCount: 1 },
			mailbox: { available: false },
			lifecycle: { available: false },
			setup: { subagentBudgetDefaultsMigration: "unavailable", profiles: { available: false } },
		})
		expect(JSON.stringify(result)).not.toContain(secret)
	})
})
