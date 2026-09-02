import { switchModeTool } from "../SwitchModeTool"

describe("SwitchModeTool", () => {
	it("uses the awaited provider mode transition as the execution barrier without an extra timer", async () => {
		vi.useFakeTimers()
		try {
			let releaseModeSwitch!: () => void
			const modeSwitch = new Promise<void>((resolve) => {
				releaseModeSwitch = resolve
			})
			let reportModeSwitchStarted!: () => void
			const modeSwitchStarted = new Promise<void>((resolve) => {
				reportModeSwitchStarted = resolve
			})
			const provider = {
				getState: vi.fn().mockResolvedValue({ customModes: [] }),
				setTaskMode: vi.fn(() => {
					reportModeSwitchStarted()
					return modeSwitch
				}),
			}
			const task = {
				taskId: "task-1",
				providerRef: { deref: () => provider },
				getTaskMode: vi.fn().mockResolvedValue("code"),
				recordToolError: vi.fn(),
				consecutiveMistakeCount: 0,
				didToolFailInCurrentTurn: false,
			} as any
			const askApproval = vi.fn().mockResolvedValue(true)
			let reportResultPushed!: () => void
			const resultPushed = new Promise<void>((resolve) => {
				reportResultPushed = resolve
			})
			const pushToolResult = vi.fn(() => reportResultPushed())
			const handleError = vi.fn()

			const execution = switchModeTool.execute({ mode_slug: "architect", reason: "plan first" }, task, {
				askApproval,
				pushToolResult,
				handleError,
			} as any)

			await modeSwitchStarted
			expect(pushToolResult).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)

			releaseModeSwitch()
			await resultPushed
			expect(pushToolResult).toHaveBeenCalledWith(
				expect.stringMatching(
					/Successfully switched from .*Code mode to .*Architect mode because: plan first\./,
				),
			)
			expect(vi.getTimerCount()).toBe(0)
			await execution
			expect(handleError).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})
