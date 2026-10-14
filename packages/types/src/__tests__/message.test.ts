// pnpm --filter @alpha-code/types test src/__tests__/message.test.ts

import {
	alphaAsks,
	alphaMessageSchema,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isNonBlockingAsk,
	queuedMessageSchema,
} from "../message.js"
import type { WebviewMessage } from "../vscode-extension-host.js"

describe("ask messages", () => {
	test("retains bounded queued input identities on feedback and accepts older saved messages", () => {
		const legacy = { type: "say", say: "user_feedback", ts: 1, text: "Continue the task" }
		expect(alphaMessageSchema.parse(legacy)).toEqual(legacy)
		const correlated = { ...legacy, queuedMessageIds: ["submission-1"] }
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(correlated)))).toEqual(correlated)
		for (const queuedMessageIds of [[""], ["x".repeat(257)], Array(101).fill("submission"), [123]]) {
			expect(alphaMessageSchema.safeParse({ ...legacy, queuedMessageIds }).success).toBe(false)
		}
	})

	test("accepts legacy queued input and its pending delivery projection", () => {
		const legacy = { id: "input-identity", timestamp: 1, text: "arbitrary input", images: ["attachment"] }
		expect(queuedMessageSchema.parse(legacy)).toEqual(legacy)
		expect(queuedMessageSchema.parse({ ...legacy, deliveryState: "delivering" })).toEqual({
			...legacy,
			deliveryState: "delivering",
		})
		expect(queuedMessageSchema.safeParse({ ...legacy, deliveryState: "unknown" }).success).toBe(false)
	})

	test("round trips optional reasoning synopses without changing old saved traces", () => {
		const old = { type: "say", say: "reasoning", ts: 1, text: "Full original reasoning." }
		expect(alphaMessageSchema.parse(old)).toEqual(old)
		const current = {
			...old,
			reasoningSummary: "Checking the implementation.",
			reasoningSummaryUsage: {
				tokensIn: 10,
				tokensOut: 5,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 0.001,
			},
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(current)))).toEqual(current)
		expect(alphaMessageSchema.safeParse({ ...current, reasoningSummary: "x".repeat(281) }).success).toBe(false)
	})
	test("retains command output correlation while accepting older messages", () => {
		const oldMessage = { type: "say", say: "command_output", ts: 1000, text: "output" }
		expect(alphaMessageSchema.parse(oldMessage)).toEqual(oldMessage)
		expect(alphaMessageSchema.parse({ ...oldMessage, commandExecutionId: "900" })).toEqual({
			...oldMessage,
			commandExecutionId: "900",
		})
		expect(alphaMessageSchema.safeParse({ ...oldMessage, commandExecutionId: 900 }).success).toBe(false)
	})
	test("round trips the approval choices and amendments offered by the scheduler", () => {
		const message = {
			type: "ask" as const,
			ask: "command" as const,
			ts: 42,
			text: "node scripts/check.js",
			toolApprovalRequest: {
				requestId: "task-1:call-1",
				taskId: "task-1",
				toolName: "execute_command",
				description: "node scripts/check.js",
				cwd: "/workspace",
				availableDecisions: [
					"approve_once",
					"approve_with_amendment",
					"approve_persistently",
					"deny",
					"abort",
				] as const,
				proposedAmendment: { kind: "exact_command", command: "node scripts/check.js" },
				proposedPersistentAmendment: {
					kind: "command_prefix",
					prefix: "node scripts/check.js",
				},
			},
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
		expect(alphaMessageSchema.safeParse({ ...message, ask: "tool" }).success).toBe(false)
		expect(
			alphaMessageSchema.safeParse({
				...message,
				toolApprovalRequest: { ...message.toolApprovalRequest, availableDecisions: ["timeout"] },
			}).success,
		).toBe(false)
		expect(
			alphaMessageSchema.safeParse({
				...message,
				toolApprovalRequest: {
					...message.toolApprovalRequest,
					availableDecisions: ["approve_with_amendment"],
					proposedAmendment: undefined,
				},
			}).success,
		).toBe(false)

		const response: WebviewMessage = {
			type: "toolApprovalResponse",
			taskId: "task-1",
			approvalRequestId: "task-1:call-1",
			toolApprovalDecision: { decision: "abort" },
		}
		expect(response.toolApprovalDecision).toEqual({ decision: "abort" })
	})
	test("all ask messages are classified", () => {
		for (const ask of alphaAsks) {
			expect(
				isIdleAsk(ask) || isInteractiveAsk(ask) || isResumableAsk(ask) || isNonBlockingAsk(ask),
				`${ask} is not classified`,
			).toBe(true)
		}
	})
})

describe("webview messages", () => {
	test("accepts boolean VS Code setting values", () => {
		const message: WebviewMessage = {
			type: "updateVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
			value: true,
		}

		expect(message.value).toBe(true)
	})
})
