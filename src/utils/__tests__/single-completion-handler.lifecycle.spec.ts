import { describe, expect, it, vi } from "vitest"

import { buildApiHandler } from "../../api"
import { singleCompletionHandler } from "../single-completion-handler"

vi.mock("../../api", () => ({ buildApiHandler: vi.fn() }))

const configuration = { apiProvider: "vscode-lm" as const }

describe("single completion provider ownership", () => {
	it("does not construct a provider for an already cancelled enhancement", async () => {
		vi.mocked(buildApiHandler).mockClear()
		const controller = new AbortController()
		const reason = new Error("Enhancement cancelled")
		controller.abort(reason)

		await expect(singleCompletionHandler(configuration, "Original", { signal: controller.signal })).rejects.toBe(
			reason,
		)
		expect(buildApiHandler).not.toHaveBeenCalled()
	})

	it("forwards caller cancellation, disposes promptly, and ignores a late provider result", async () => {
		const controller = new AbortController()
		const reason = new Error("Draft changed")
		let finish!: (value: string) => void
		const delayed = new Promise<string>((resolve) => (finish = resolve))
		const completePrompt = vi.fn(() => delayed)
		const dispose = vi.fn()
		const handler = {
			createMessage: vi.fn(),
			getModel: vi.fn(),
			countTokens: vi.fn(async () => 0),
			completePrompt,
			dispose,
		}
		vi.mocked(buildApiHandler).mockReturnValue(handler)

		const completion = singleCompletionHandler(configuration, "Original", { signal: controller.signal })
		const rejected = expect(completion).rejects.toBe(reason)
		controller.abort(reason)
		await rejected
		expect(completePrompt).toHaveBeenCalledWith("Original", { signal: controller.signal })
		expect(dispose).toHaveBeenCalledOnce()
		finish("Late enhanced draft")
		await Promise.resolve()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it.each(["success", "error"] as const)("releases provider listeners after %s", async (outcome) => {
		const listeners = new Set<() => void>()
		const listener = vi.fn()
		listeners.add(listener)
		let finish!: (value: string) => void
		let fail!: (error: Error) => void
		const pending = new Promise<string>((resolve, reject) => {
			finish = resolve
			fail = reject
		})
		const dispose = vi.fn(() => listeners.delete(listener))
		const completePrompt = vi.fn(() => pending)
		const handler = {
			createMessage: vi.fn(),
			getModel: vi.fn(),
			countTokens: vi.fn(async () => 0),
			completePrompt,
			dispose,
		}
		vi.mocked(buildApiHandler).mockReturnValue(handler)

		const completion = singleCompletionHandler(configuration, "Enhance the prompt")
		expect(listeners.size).toBe(1)
		expect(dispose).not.toHaveBeenCalled()
		if (outcome === "success") {
			finish("Enhanced prompt")
			await expect(completion).resolves.toBe("Enhanced prompt")
		} else {
			const error = new Error("Provider disconnected")
			fail(error)
			await expect(completion).rejects.toBe(error)
		}

		expect(completePrompt).toHaveBeenCalledWith("Enhance the prompt")
		expect(listeners.size).toBe(0)
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("releases an unsupported provider before returning its capability error", async () => {
		const dispose = vi.fn()
		vi.mocked(buildApiHandler).mockReturnValue({
			createMessage: vi.fn(),
			getModel: vi.fn(),
			countTokens: vi.fn(async () => 0),
			dispose,
		})

		await expect(singleCompletionHandler(configuration, "Enhance the prompt")).rejects.toThrow(
			"The selected API provider does not support prompt enhancement",
		)
		expect(dispose).toHaveBeenCalledOnce()
	})
})
