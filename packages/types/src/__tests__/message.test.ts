// pnpm --filter @alpha-code/types test src/__tests__/message.test.ts

import { clineAsks, isIdleAsk, isInteractiveAsk, isResumableAsk, isNonBlockingAsk } from "../message.js"
import type { WebviewMessage } from "../vscode-extension-host.js"

describe("ask messages", () => {
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
