import { vscode } from "../vscode"

vi.mock("../vscode", () => ({ vscode: { postMessage: vi.fn() } }))

let errors: typeof import("../webviewErrors")
const disposers: (() => void)[] = []

beforeEach(async () => {
	vi.resetModules()
	vi.mocked(vscode.postMessage).mockReset()
	errors = await import("../webviewErrors")
})

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose()
	document.body.replaceChildren()
	vi.restoreAllMocks()
})

function rejection(reason: unknown) {
	const event = new Event("unhandledrejection")
	Object.defineProperty(event, "reason", { value: reason })
	return event
}

describe("bounded local webview errors", () => {
	it.each([
		[new RangeError("Maximum call stack size exceeded"), "RangeError", "stack_overflow"],
		[new RangeError("Invalid string length"), "RangeError", "invalid_string_length"],
		[new TypeError("Failed to fetch dynamically imported module: private-canary"), "TypeError", "chunk_load"],
		[Object.assign(new Error("private-canary"), { name: "ChunkLoadError" }), "ChunkLoadError", "chunk_load"],
		[new TypeError("private-canary"), "TypeError", "other"],
		[Object.assign(new Error("private-canary"), { name: "private-canary" }), "other", "other"],
	] as const)("classifies an error without sending its contents", (error, errorType, failure) => {
		error.stack = "private-canary"
		errors.reportWebviewError("render", error)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "webviewError",
			source: "render",
			errorType,
			failure,
			visibility: "visible",
			line: undefined,
			column: undefined,
			resourceType: undefined,
		})
		expect(JSON.stringify(vi.mocked(vscode.postMessage).mock.calls)).not.toContain("private-canary")
	})

	it.each(["private-canary", null, undefined, { message: "private-canary", stack: "private-canary" }])(
		"reports non-Error rejections without coercing or exposing them",
		(reason) => {
			disposers.push(errors.initializeWebviewErrorReporting())
			window.dispatchEvent(rejection(reason))
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ source: "rejection", errorType: "other", failure: "other" }),
			)
			expect(JSON.stringify(vi.mocked(vscode.postMessage).mock.calls)).not.toContain("private-canary")
		},
	)

	it("captures global errors with bounded numeric locations and no filename or message", () => {
		disposers.push(errors.initializeWebviewErrorReporting())
		window.dispatchEvent(
			new ErrorEvent("error", {
				error: new TypeError("private-canary"),
				message: "private-canary",
				filename: "https://private-canary.invalid/private-canary.js",
				lineno: 42,
				colno: 10,
			}),
		)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ source: "window", errorType: "TypeError", line: 42, column: 10 }),
		)
		expect(JSON.stringify(vi.mocked(vscode.postMessage).mock.calls)).not.toContain("private-canary")
	})

	it("records a hidden document and omits invalid numeric locations", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		errors.reportWebviewError("window", new Error("private-canary"), { line: Number.NaN, column: -1 })
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "hidden", line: undefined, column: undefined }),
		)
	})

	it.each([
		["script", "script"],
		["link", "style"],
		["img", "image"],
	] as const)("captures %s resource failures without sending resource URLs", (tag, resourceType) => {
		disposers.push(errors.initializeWebviewErrorReporting())
		const resource = document.createElement(tag)
		resource.setAttribute(tag === "link" ? "href" : "src", "https://private-canary.invalid/private-canary")
		document.body.append(resource)
		resource.dispatchEvent(new Event("error"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ source: "resource", failure: "resource_load", resourceType }),
		)
		expect(JSON.stringify(vi.mocked(vscode.postMessage).mock.calls)).not.toContain("private-canary")
	})

	it("deduplicates errors and caps reports across listener remounts for one document", () => {
		const dispose = errors.initializeWebviewErrorReporting()
		const failure = new ErrorEvent("error", { error: new Error("first"), lineno: 1 })
		window.dispatchEvent(failure)
		window.dispatchEvent(failure)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		dispose()
		disposers.push(errors.initializeWebviewErrorReporting())
		window.dispatchEvent(failure)
		for (let line = 2; line <= 15; line++) {
			window.dispatchEvent(new ErrorEvent("error", { error: new Error("other"), lineno: line }))
		}
		expect(vscode.postMessage).toHaveBeenCalledTimes(10)
	})

	it("removes both listeners when its owner unmounts", () => {
		const dispose = errors.initializeWebviewErrorReporting()
		dispose()
		dispose()
		const resource = document.createElement("script")
		document.body.append(resource)
		resource.dispatchEvent(new Event("error"))
		window.dispatchEvent(rejection(new Error("after disposal")))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("contains reporting failures and ignores hostile error accessors", () => {
		vi.mocked(vscode.postMessage).mockImplementationOnce(() => {
			throw new Error("private-canary")
		})
		expect(() => errors.reportWebviewError("render", new Error("failure"))).not.toThrow()
		const hostile = new Error("private-canary")
		Object.defineProperty(hostile, "name", {
			get() {
				throw new Error("private-canary")
			},
		})
		expect(() => errors.reportWebviewError("render", hostile)).not.toThrow()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})
})
