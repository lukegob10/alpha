import { act, renderHook } from "@testing-library/react"
import type { AlphaMessage } from "@alpha-code/types"

import { usePromptHistory } from "./usePromptHistory"

describe("usePromptHistory", () => {
	it("does not restore a different chat's saved draft when prompt histories are identical", () => {
		const setInputValue = vi.fn()
		const clineMessages: AlphaMessage[] = [{ type: "say", say: "user_feedback", text: "same prompt", ts: 1 }]
		const { result, rerender } = renderHook(
			({ taskId, inputValue }) =>
				usePromptHistory({ taskId, clineMessages, taskHistory: [], cwd: "/repo", inputValue, setInputValue }),
			{ initialProps: { taskId: "task-a", inputValue: "private draft A" } },
		)
		const textarea = document.createElement("textarea")
		textarea.value = "private draft A"
		textarea.setSelectionRange(0, 0)
		act(() => {
			result.current.handleHistoryNavigation(
				{
					key: "ArrowUp",
					currentTarget: textarea,
					preventDefault: vi.fn(),
				} as unknown as React.KeyboardEvent<HTMLTextAreaElement>,
				false,
				false,
			)
		})
		expect(result.current.historyIndex).toBe(0)
		setInputValue.mockClear()
		rerender({ taskId: "task-b", inputValue: "draft B" })
		textarea.value = "draft B"
		textarea.setSelectionRange(0, 0)
		act(() => {
			result.current.handleHistoryNavigation(
				{
					key: "ArrowDown",
					currentTarget: textarea,
					preventDefault: vi.fn(),
				} as unknown as React.KeyboardEvent<HTMLTextAreaElement>,
				false,
				false,
			)
		})
		expect(setInputValue).not.toHaveBeenCalled()
		expect(result.current.tempInput).toBe("")
		expect(result.current.historyIndex).toBe(-1)
	})

	it("preserves the saved draft across unrelated streaming transcript updates", () => {
		const setInputValue = vi.fn()
		const userMessage: AlphaMessage = {
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
			clineMessages: [userMessage, { type: "say", say: "text", text: "streamed token", ts: 2, partial: true }],
			inputValue: "previous prompt",
		})

		expect(result.current.tempInput).toBe("current draft")
		expect(result.current.historyIndex).toBe(0)
	})
})
