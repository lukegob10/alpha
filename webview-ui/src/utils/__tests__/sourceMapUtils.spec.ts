import * as StackTrace from "stacktrace-js"
import { applySourceMapsToStack, applySourceMapsToComponentStack, enhanceErrorWithSourceMaps } from "../sourceMapUtils"

vi.mock("stacktrace-js", () => ({ fromError: vi.fn() }))

describe("sourceMapUtils", () => {
	beforeEach(() => {
		vi.mocked(StackTrace.fromError).mockReset().mockRejectedValue(new Error("Source map unavailable"))
		vi.spyOn(console, "error").mockImplementation(() => {})
	})
	afterEach(() => vi.restoreAllMocks())

	describe("applySourceMapsToStack", () => {
		test("should return original stack when source maps cannot be applied", async () => {
			const stackTrace = `Error: Test error
    at Function.execute (webpack:///./src/components/App.tsx:123:45)`

			const result = await applySourceMapsToStack(stackTrace)

			expect(result).toBe(stackTrace)
		})

		test("should handle empty stack", async () => {
			const emptyStack = ""
			const result = await applySourceMapsToStack(emptyStack)
			expect(result).toBe(emptyStack)
		})
	})

	describe("applySourceMapsToComponentStack", () => {
		test("retains component locations when the source maps cannot be loaded", async () => {
			const stack = "\n    at App (webview-ui.js:123:45)"

			expect(await applySourceMapsToComponentStack(stack)).toBe(stack)
			expect(StackTrace.fromError).toHaveBeenCalledTimes(1)
		})

		test("does not resolve empty or unrecognized component locations", async () => {
			expect(await applySourceMapsToComponentStack("")).toBe("")
			expect(await applySourceMapsToComponentStack("\n    at App")).toBe("\n    at App")
			expect(StackTrace.fromError).not.toHaveBeenCalled()
		})
	})

	describe("enhanceErrorWithSourceMaps", () => {
		test("should add sourceMappedStack property to error", async () => {
			const error = new Error("Test error")
			error.stack = `Error: Test error
    at Function.execute (webpack:///./src/components/App.tsx:123:45)`

			const enhancedError = await enhanceErrorWithSourceMaps(error)

			expect(enhancedError).toBe(error) // Should return the same error object
			expect("sourceMappedStack" in enhancedError).toBe(true)
		})

		test("should handle errors without stack", async () => {
			const error = new Error("Test error")
			error.stack = undefined

			const enhancedError = await enhanceErrorWithSourceMaps(error)

			expect(enhancedError).toBe(error)
			expect("sourceMappedStack" in enhancedError).toBe(false)
		})

		test("keeps the original error and component stacks when mapping is unavailable", async () => {
			const error = new Error("Render error")
			error.stack = "Error: Render error\n    at render (webview-ui.js:20:10)"
			const componentStack = "\n    at App (webview-ui.js:123:45)"

			const enhancedError = await enhanceErrorWithSourceMaps(error, componentStack)

			expect(enhancedError).toBe(error)
			expect(enhancedError.sourceMappedStack).toBe(error.stack)
			expect(enhancedError.sourceMappedComponentStack).toBe(componentStack)
		})
	})
})
