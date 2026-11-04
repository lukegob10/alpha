import { act, renderHook } from "@testing-library/react"
import type { AlphaMessage } from "@alpha-code/types"

import { usePromptHistory } from "./usePromptHistory"
import { useTaskComposer } from "./useTaskComposer"

describe("usePromptHistory", () => {
	it("restores each chat's unsent draft after switching chats during history recall", () => {
		const alphaMessages: AlphaMessage[] = [{ type: "say", say: "user_feedback", text: "previous prompt", ts: 1 }]
		const taskHistory: [] = []
		const { result, rerender } = renderHook(
			({ taskId }) => {
				const composer = useTaskComposer(taskId)
				const history = usePromptHistory({
					taskId,
					alphaMessages,
					taskHistory,
					cwd: "/repo",
					inputValue: composer.inputValue,
					setInputValue: composer.setInputValue,
					onRestoreHistoryDraft: (owner, expected, original) =>
						composer.updateTaskDraft(owner, (draft) =>
							draft.inputValue === expected ? { ...draft, inputValue: original } : draft,
						),
				})
				return { ...composer, ...history }
			},
			{ initialProps: { taskId: "task-a" } },
		)
		const navigate = (key: "ArrowUp" | "ArrowDown") => {
			const textarea = document.createElement("textarea")
			textarea.value = result.current.inputValue
			textarea.setSelectionRange(0, 0)
			act(() => {
				result.current.handleHistoryNavigation(
					{
						key,
						currentTarget: textarea,
						preventDefault: vi.fn(),
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>,
					false,
					false,
				)
			})
		}
		act(() => result.current.setInputValue("private draft A"))
		navigate("ArrowUp")
		expect(result.current.inputValue).toBe("previous prompt")
		rerender({ taskId: "task-b" })
		expect(result.current.inputValue).toBe("")
		act(() => result.current.setInputValue("private draft B"))
		navigate("ArrowUp")
		rerender({ taskId: "task-a" })
		navigate("ArrowDown")
		expect(result.current.inputValue).toBe("private draft A")
		rerender({ taskId: "task-b" })
		navigate("ArrowDown")
		expect(result.current.inputValue).toBe("private draft B")

		rerender({ taskId: "task-a" })
		navigate("ArrowUp")
		act(() =>
			result.current.updateTaskDraft("task-a", (draft) => ({ ...draft, inputValue: "newer external edit" })),
		)
		rerender({ taskId: "task-b" })
		rerender({ taskId: "task-a" })
		expect(result.current.inputValue).toBe("newer external edit")
		navigate("ArrowUp")
		act(() => {
			result.current.resetOnInputChange()
			result.current.setInputValue("edited recalled prompt")
		})
		rerender({ taskId: "task-b" })
		rerender({ taskId: "task-a" })
		expect(result.current.inputValue).toBe("edited recalled prompt")
		navigate("ArrowUp")
		act(() => {
			result.current.resetHistoryNavigation()
			result.current.setInputValue("")
		})
		rerender({ taskId: "task-b" })
		rerender({ taskId: "task-a" })
		expect(result.current.inputValue).toBe("")
	})

	it("restores the owning draft when its recalled prompt changes or the composer unmounts", () => {
		const restore = vi.fn()
		const setInputValue = vi.fn()
		const oldMessages: AlphaMessage[] = [{ type: "say", say: "user_feedback", text: "previous prompt", ts: 1 }]
		const { result, rerender, unmount } = renderHook(
			({ alphaMessages }) =>
				usePromptHistory({
					taskId: "task-a",
					alphaMessages,
					taskHistory: [],
					cwd: "/repo",
					inputValue: "unsent draft",
					setInputValue,
					onRestoreHistoryDraft: restore,
				}),
			{ initialProps: { alphaMessages: oldMessages } },
		)
		const recall = () => {
			const textarea = document.createElement("textarea")
			textarea.value = "unsent draft"
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
		}
		recall()
		rerender({ alphaMessages: [{ ...oldMessages[0], text: "edited previous prompt" }] })
		expect(restore).toHaveBeenCalledTimes(1)
		expect(restore).toHaveBeenCalledWith("task-a", "previous prompt", "unsent draft")
		restore.mockClear()
		recall()
		unmount()
		expect(restore).toHaveBeenCalledTimes(1)
		expect(restore).toHaveBeenCalledWith("task-a", "edited previous prompt", "unsent draft")
	})

	it("does not serialize unchanged prompt history across 40 input edits", () => {
		const alphaMessages: AlphaMessage[] = Array.from({ length: 100 }, (_, ts) => ({
			type: "say",
			say: "user_feedback",
			text: "x".repeat(4_000),
			ts,
		}))
		const taskHistory: [] = []
		const setInputValue = vi.fn()
		const { result, rerender } = renderHook(
			({ inputValue }) =>
				usePromptHistory({ alphaMessages, taskHistory, cwd: "/repo", inputValue, setInputValue }),
			{ initialProps: { inputValue: "" } },
		)
		const history = result.current.promptHistory
		const stringify = vi.spyOn(JSON, "stringify")
		try {
			for (let length = 1; length <= 40; length++) rerender({ inputValue: "z".repeat(length) })
			expect(result.current.promptHistory).toBe(history)
			expect(stringify.mock.calls.filter(([value]) => value === history)).toHaveLength(0)
		} finally {
			stringify.mockRestore()
		}
	})

	it("does not restore a different chat's saved draft when prompt histories are identical", () => {
		const setInputValue = vi.fn()
		const alphaMessages: AlphaMessage[] = [{ type: "say", say: "user_feedback", text: "same prompt", ts: 1 }]
		const { result, rerender } = renderHook(
			({ taskId, inputValue }) =>
				usePromptHistory({ taskId, alphaMessages, taskHistory: [], cwd: "/repo", inputValue, setInputValue }),
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
			({ alphaMessages, inputValue }) =>
				usePromptHistory({ alphaMessages, taskHistory: [], cwd: "/repo", inputValue, setInputValue }),
			{
				initialProps: { alphaMessages: [userMessage], inputValue: "current draft" },
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
			alphaMessages: [userMessage, { type: "say", say: "text", text: "streamed token", ts: 2, partial: true }],
			inputValue: "previous prompt",
		})

		expect(result.current.tempInput).toBe("current draft")
		expect(result.current.historyIndex).toBe(0)
	})
})
