import { act, render } from "@/utils/test-utils"

const mermaidMocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
}))

vi.mock("mermaid", () => ({
	default: mermaidMocks,
}))

vi.mock("../CodeBlock", () => ({
	default: () => null,
}))

vi.mock("../MermaidButton", () => ({
	MermaidButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ showCopyFeedback: false, copyWithFeedback: vi.fn() }),
}))

const deferred = <T,>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve
	})
	return { promise, resolve }
}

describe("MermaidBlock security configuration", () => {
	it("initializes Mermaid with strict sanitization", async () => {
		await import("../MermaidBlock")

		expect(mermaidMocks.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				startOnLoad: false,
				securityLevel: "strict",
			}),
		)
	})
})

describe("MermaidBlock rendering", () => {
	afterEach(() => vi.useRealTimers())

	it("does not let an older render overwrite newer code", async () => {
		vi.useFakeTimers()
		mermaidMocks.parse.mockReset()
		mermaidMocks.render.mockReset()
		mermaidMocks.parse.mockResolvedValue(true)

		const pending = new Map<string, ReturnType<typeof deferred<{ svg: string }>>>()
		mermaidMocks.render.mockImplementation((_id: string, code: string) => {
			const result = deferred<{ svg: string }>()
			pending.set(code, result)
			return result.promise
		})

		const { default: MermaidBlock } = await import("../MermaidBlock")
		const { container, rerender } = render(<MermaidBlock code="diagram A" />)

		await act(async () => {
			vi.advanceTimersByTime(500)
			await Promise.resolve()
		})
		expect(pending.has("diagram A")).toBe(true)

		rerender(<MermaidBlock code="diagram B" />)
		await act(async () => {
			vi.advanceTimersByTime(500)
			await Promise.resolve()
		})
		expect(pending.has("diagram B")).toBe(true)

		await act(async () => {
			pending.get("diagram B")?.resolve({ svg: '<svg data-code="B"></svg>' })
		})
		expect(container.querySelector('[data-code="B"]')).toBeInTheDocument()

		await act(async () => {
			pending.get("diagram A")?.resolve({ svg: '<svg data-code="A"></svg>' })
		})

		expect(container.querySelector('[data-code="B"]')).toBeInTheDocument()
		expect(container.querySelector('[data-code="A"]')).not.toBeInTheDocument()
	})
})
