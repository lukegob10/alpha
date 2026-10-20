import { vscodeLlmModels } from "@alpha-code/types"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"
import { hashAgentTurnEvidenceId } from "../AgentTurnEventLog"
import {
	incidentDiagnosticsSchema,
	MAX_INCIDENT_RECEIPTS,
	projectDiagnosticIdentity,
	projectIncidentDiagnostics,
} from "../IncidentDiagnostics"
import { projectRuntimeDiagnostics } from "../../webview/diagnosticsEvidence"

describe("bounded incident diagnostic projection", () => {
	it("joins pending input, approval and mailbox receipts without exporting their bodies or opaque identifiers", () => {
		const secret = "private-canary-credential-or-prompt"
		const result = projectIncidentDiagnostics({
			task: { id: secret, status: "interactive", kind: "primary", ask: "tool", prompt: secret },
			provider: { name: "vscode-lm", modelId: secret, apiKey: secret, endpoint: `https://${secret}` },
			lifecycle: {
				runId: secret,
				turnId: secret,
				status: "in_progress",
				phase: "awaiting_approval",
				lastSequence: 7,
				items: [
					{ type: "assistant_text", text: secret },
					{ type: "approval", approvalId: secret, toolCallId: secret, status: "requested", reason: secret },
					{ type: "approval", approvalId: "resolved", status: "approved" },
					{ type: "error", message: secret, code: secret },
				],
			},
			queuedMessages: [
				{ id: secret, deliveryState: "delivering", text: secret, images: [secret], timestamp: 12 },
				{ id: "next", text: secret },
			],
			mailbox: {
				available: true,
				pendingCount: 1,
				claimedCount: 1,
				entries: [
					{
						eventId: secret,
						claimId: secret,
						kind: "result",
						sequence: 9,
						claimChannel: "wait",
						payload: { message: secret },
					},
				],
			},
			setup: {
				contextInitialized: true,
				subagentBudgetDefaultsMigration: "started",
				profiles: { available: true, total: 3, invalid: 1, unsupported: 1, configurations: secret },
			},
		})

		expect(result).toMatchObject({
			task: { idSha256: hashAgentTurnEvidenceId(secret), status: "interactive", ask: "tool" },
			provider: { provider: "vscode-lm", modelIdSha256: hashAgentTurnEvidenceId(secret) },
			lifecycle: {
				phase: "awaiting_approval",
				pendingApprovalCount: 1,
				pendingApprovals: [{ idSha256: hashAgentTurnEvidenceId(secret) }],
				lastError: { messageSha256: hashAgentTurnEvidenceId(secret) },
			},
			humanInput: {
				pendingCount: 1,
				deliveringCount: 1,
				receipts: [{ idSha256: hashAgentTurnEvidenceId(secret), state: "delivering" }, { state: "pending" }],
			},
			mailbox: {
				pendingCount: 1,
				claimedCount: 1,
				receipts: [
					{
						eventIdSha256: hashAgentTurnEvidenceId(secret),
						claimIdSha256: hashAgentTurnEvidenceId(secret),
						channel: "wait",
					},
				],
			},
			setup: {
				contextInitialized: true,
				subagentBudgetDefaultsMigration: "started",
				profiles: { total: 3, invalid: 1, unsupported: 1 },
			},
		})
		expect(JSON.stringify(result)).not.toContain(secret)
		expect(incidentDiagnosticsSchema.safeParse(result).success).toBe(true)
	})

	it("prints only known provider/model catalog identities and hashes custom endpoints, paths and IDs", () => {
		const model = Object.keys(vscodeLlmModels)[0]
		expect(projectDiagnosticIdentity("vscode-lm", model)).toMatchObject({ provider: "vscode-lm", model })
		expect(projectDiagnosticIdentity("anthropic", undefined)).toMatchObject({ provider: "anthropic" })
		for (const value of [
			"C:\\private\\model",
			"/home/private/model",
			"https://user:credential@private/model",
			"Bearer credential",
			"custom-private-model",
		]) {
			const output = projectDiagnosticIdentity(value, value)
			expect(output).toEqual({
				providerIdSha256: hashAgentTurnEvidenceId(value),
				modelIdSha256: hashAgentTurnEvidenceId(value),
			})
			expect(JSON.stringify(output)).not.toContain(value)
		}
	})

	it("bounds every receipt list and the error/lifecycle inspection window", () => {
		const result = projectIncidentDiagnostics({
			lifecycle: {
				items: [
					...Array.from({ length: 300 }, (_, index) => ({
						type: "approval",
						approvalId: `approval-${index}`,
						status: "requested",
					})),
					{ type: "error", message: "private".repeat(10_000) },
				],
			},
			queuedMessages: Array.from({ length: 100 }, (_, index) => ({
				id: `input-${index}`,
				text: "private".repeat(100),
			})),
			mailbox: {
				available: true,
				pendingCount: 100,
				claimedCount: 0,
				entries: Array.from({ length: 100 }, (_, index) => ({
					eventId: `mail-${index}`,
					kind: "message",
					payload: "private",
				})),
			},
		})
		expect(result.lifecycle.pendingApprovals).toHaveLength(MAX_INCIDENT_RECEIPTS)
		expect(result.humanInput.receipts).toHaveLength(MAX_INCIDENT_RECEIPTS)
		expect(result.mailbox.receipts).toHaveLength(MAX_INCIDENT_RECEIPTS)
		expect(result.lifecycle.truncated).toBe(true)
		expect(result.humanInput.truncated).toBe(true)
		expect(result.mailbox.truncated).toBe(true)
		expect(result.lifecycle.lastError).toMatchObject({ capturedBytes: 8_192, truncated: true })
		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(25_000)
		expect(JSON.stringify(result)).not.toContain("private")
	})

	it.each([
		undefined,
		null,
		"private",
		123,
		{
			lifecycle: { phase: "private", status: "private" },
			setup: { subagentBudgetDefaultsMigration: "private", profiles: { total: Infinity, invalid: -1 } },
		},
	])("omits malformed or unsupported state without converting it into success", (value) => {
		const result = projectIncidentDiagnostics(value)
		expect(result.mailbox.available).toBe(false)
		expect(result.setup.profiles.available).toBe(false)
		expect(JSON.stringify(result)).not.toContain("private")
		expect(incidentDiagnosticsSchema.safeParse(result).success).toBe(true)
	})

	it("rejects extra arbitrary fields and invalid receipts again at the export boundary", () => {
		const valid = projectIncidentDiagnostics({ task: { id: "task" } })
		expect(projectRuntimeDiagnostics({ incident: valid })).toMatchObject({ incident: valid })
		for (const invalid of [
			{ ...valid, prompt: "private" },
			{ ...valid, provider: { model: "private" } },
			{ ...valid, humanInput: { ...valid.humanInput, receipts: [{ idSha256: "private", state: "pending" }] } },
		]) {
			expect(projectRuntimeDiagnostics({ incident: invalid })).toMatchObject({ incident: { unavailable: true } })
			expect(JSON.stringify(projectRuntimeDiagnostics({ incident: invalid }))).not.toContain("private")
		}
	})
})

describe("selected-task mailbox diagnostic observation", () => {
	it("reads only bounded pending receipt metadata without publishing, claiming, acknowledging or writing", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "root", status: "running" })
		await store.createAgent({
			taskId: "child",
			parentTaskId: "root",
			nickname: "Child",
			role: "review",
			objective: "private",
		})
		for (let index = 0; index < 35; index++) {
			await store.appendEvent({
				eventId: `receipt-${index}`,
				sender: "child",
				recipient: "root",
				kind: "message",
				name: "agent_progress",
				payload: { message: "private" },
			})
		}
		await store.appendEvent({
			eventId: "other-recipient",
			sender: "root",
			recipient: "child",
			kind: "message",
			name: "parent_message",
			payload: { message: "private" },
		})
		await store.claimMailbox("root", { channel: "wait", limit: 2, rootTaskId: "root" })
		const before = store.getSnapshot()
		const write = vi.spyOn(persistence, "write")
		const published = vi.fn()
		store.subscribe(published)

		const result = store.getPendingMailboxDiagnostics("root", "root")

		expect(result).toMatchObject({ available: true, pendingCount: 35, claimedCount: 2, truncated: true })
		expect(result.entries).toHaveLength(32)
		expect(result.entries.every((entry) => entry.eventId.startsWith("receipt-"))).toBe(true)
		expect(JSON.stringify(result)).not.toContain("private")
		expect(JSON.stringify(result)).not.toContain("other-recipient")
		expect(store.getSnapshot()).toEqual(before)
		expect(write).not.toHaveBeenCalled()
		expect(published).not.toHaveBeenCalled()
	})
})
