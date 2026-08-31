import { act, renderHook } from "@testing-library/react"
import type { ClineMessage } from "@alpha-code/types"

import { usePromptHistory } from "./usePromptHistory"

describe("usePromptHistory", () => {
	it("preserves the saved draft across unrelated streaming transcript updates", () => {
		const setInputValue = vi.fn()
		const userMessage: ClineMessage = {
			type: "say",
			say: "user_feedback",
			text: "previous prompt",
			ts: 1,
		}
		const { result, rerender } = renderHook(
			({ clineMessages, inputValue }) =>
				usePromptHistory({ clineMessages, taskHistory: [], cwd: "/repo", inputValue, setInputValue }),
			{
				initialProps: { clineMessages: [userMessage], inputValue: "current draft" },
			},
		)
		const textarea = {
			selectionStart: 0,
			selectionEnd: 0,
			value: "current draft",
			setSelectionRange: vi.fn(),
		} as unknown as HTMLTextAreaElement

		act(() => {
			result.current.handleHistoryNavigation(
				{ key: "ArrowUp", currentTarget: textarea, preventDefault: vi.fn() } as any,
				false,
				false,
			)
		})
		expect(result.current.tempInput).toBe("current draft")
		expect(result.current.historyIndex).toBe(0)

		rerender({
			clineMessages: [
				userMessage,
				{ type: "say", say: "text", text: "streamed token", ts: 2, partial: true },
			],
			inputValue: "previous prompt",
		})

		expect(result.current.tempInput).toBe("current draft")
		expect(result.current.historyIndex).toBe(0)
	})
})
