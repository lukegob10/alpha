// pnpm --filter @alpha-code/types test src/__tests__/message.test.ts

import {
	clineAsks,
	clineMessageSchema,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isNonBlockingAsk,
} from "../message.js"
import type { WebviewMessage } from "../vscode-extension-host.js"

describe("ask messages", () => {
	test("round trips optional reasoning synopses without changing old saved traces", () => {
		const old = { type: "say", say: "reasoning", ts: 1, text: "Full original reasoning." }
		expect(clineMessageSchema.parse(old)).toEqual(old)
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
		expect(clineMessageSchema.parse(JSON.parse(JSON.stringify(current)))).toEqual(current)
		expect(clineMessageSchema.safeParse({ ...current, reasoningSummary: "x".repeat(281) }).success).toBe(false)
	})
	test("retains command output correlation while accepting older messages", () => {
		const oldMessage = { type: "say", say: "command_output", ts: 1000, text: "output" }
		expect(clineMessageSchema.parse(oldMessage)).toEqual(oldMessage)
		expect(clineMessageSchema.parse({ ...oldMessage, commandExecutionId: "900" })).toEqual({
			...oldMessage,
			commandExecutionId: "900",
		})
		expect(clineMessageSchema.safeParse({ ...oldMessage, commandExecutionId: 900 }).success).toBe(false)
	})
	test("all ask messages are classified", () => {
		for (const ask of clineAsks) {
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
