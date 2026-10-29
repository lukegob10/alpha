import { act, cleanup, fireEvent, render, screen } from "@/utils/test-utils"

const mermaidMocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
	postMessage: vi.fn(),
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

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: mermaidMocks.postMessage } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ showCopyFeedback: false, copyWithFeedback: vi.fn() }),
}))

const deferred = <T,>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve
		reject = promiseReject
	})
	return { promise, resolve, reject }
}

const originalClass = document.body.className
const originalStyle = document.body.getAttribute("style")
afterEach(() => {
	cleanup()
	document.body.className = originalClass
	if (originalStyle === null) document.body.removeAttribute("style")
	else document.body.setAttribute("style", originalStyle)
	vi.useRealTimers()
})

describe("MermaidBlock security configuration", () => {
	it("initializes Mermaid with strict sanitization and a customizable theme", async () => {
		vi.useFakeTimers()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		render(<MermaidBlock code="flowchart LR; A-->B" />)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})

		expect(mermaidMocks.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
			}),
		)
		vi.useRealTimers()
	})
})

describe("MermaidBlock rendering", () => {
	afterEach(() => vi.useRealTimers())

	it("opens the rendered SVG directly with UTF-8 text and its theme background", async () => {
		vi.useFakeTimers()
		mermaidMocks.postMessage.mockClear()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({
			svg: '<svg viewBox="0 0 1200 600"><foreignObject width="200" height="40"><div>Revenue £ → résumé</div></foreignObject></svg>',
		})
		const { default: MermaidBlock } = await import("../MermaidBlock")
		render(<MermaidBlock code="flowchart LR; A-->B" />)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		fireEvent.click(screen.getByRole("button", { name: "common:mermaid.buttons.open" }))
		expect(mermaidMocks.postMessage).toHaveBeenCalledTimes(1)
		const message = mermaidMocks.postMessage.mock.calls[0]![0]
		expect(message.type).toBe("openImage")
		expect(message.text).toMatch(/^data:image\/svg\+xml;base64,/)
		const markup = new TextDecoder().decode(
			Uint8Array.from(atob(message.text.split(",")[1]), (character) => character.charCodeAt(0)),
		)
		expect(markup).toContain("Revenue £ → résumé")
		expect(markup).toContain('xmlns="http://www.w3.org/1999/xhtml"')
		expect(markup).toContain('fill="#1e1e1e"')
		expect(markup).toContain('width="1200"')
	})

	it("uses VS Code colors and rerenders safely when the theme changes", async () => {
		vi.useFakeTimers()
		document.body.className = "vscode-light"
		document.body.style.setProperty("--vscode-editor-background", "#ffffff")
		document.body.style.setProperty("--vscode-editor-foreground", "#202020")
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		render(<MermaidBlock code="flowchart LR; A-->B" />)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({
				securityLevel: "strict",
				themeVariables: expect.objectContaining({
					background: "#ffffff",
					textColor: "#202020",
					darkMode: false,
				}),
			}),
		)
		await act(async () => {
			document.body.className = "vscode-dark"
			document.body.style.setProperty("--vscode-editor-background", "#1e1e1e")
			document.body.style.setProperty("--vscode-editor-foreground", "#eeeeee")
			await Promise.resolve()
		})
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({
				securityLevel: "strict",
				themeVariables: expect.objectContaining({
					background: "#1e1e1e",
					textColor: "#eeeeee",
					darkMode: true,
				}),
			}),
		)
		await act(async () => {
			document.body.style.setProperty("--vscode-editor-background", "#101820")
			await Promise.resolve()
		})
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(
			screen.getByRole("button", { name: "common:mermaid.buttons.open" }).querySelector("svg > rect"),
		).toHaveAttribute("fill", "#101820")
	})

	it("disconnects theme observation and cancels scheduled work when unmounted", async () => {
		vi.useFakeTimers()
		mermaidMocks.render.mockClear()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		const { unmount } = render(<MermaidBlock code="flowchart LR; A-->B" />)
		unmount()
		await act(async () => {
			document.body.className = "vscode-light"
			await vi.advanceTimersByTimeAsync(1000)
		})
		expect(mermaidMocks.render).not.toHaveBeenCalled()
	})

	it("preserves a wide diagram's readable SVG dimensions instead of shrinking it to the chat width", async () => {
		vi.useFakeTimers()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 1800px;" viewBox="0 0 1800 900"><text>Source records</text></svg>',
		})
		const { default: MermaidBlock } = await import("../MermaidBlock")
		const { container } = render(<MermaidBlock code="flowchart LR; A-->B" />)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		const svg = container.querySelector("svg")!
		expect(svg).toHaveAttribute("width", "1800")
		expect(svg).toHaveAttribute("height", "900")
		expect(svg.style.maxWidth).toBe("none")
	})

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
			vi.advanceTimersByTime(0)
			await Promise.resolve()
		})
		expect(pending.has("diagram A")).toBe(true)

		rerender(<MermaidBlock code="diagram B" />)
		await act(async () => {
			vi.advanceTimersByTime(0)
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

	it("renders completed diagrams on the next task without a fixed delay", async () => {
		vi.useFakeTimers()
		mermaidMocks.initialize.mockClear()
		mermaidMocks.parse.mockReset()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		render(
			<>
				<MermaidBlock code="flowchart LR; A-->B" />
				<MermaidBlock code="flowchart LR; C-->D" />
				<MermaidBlock code="flowchart LR; E-->F" />
			</>,
		)

		expect(mermaidMocks.render).not.toHaveBeenCalled()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})

		expect(mermaidMocks.render).toHaveBeenCalledTimes(3)
		expect(mermaidMocks.initialize).toHaveBeenCalledTimes(3)
		expect(screen.queryByText("common:mermaid.loading")).not.toBeInTheDocument()
	})

	it("does not separately parse diagrams that render already validates", async () => {
		vi.useFakeTimers()
		mermaidMocks.parse.mockReset()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		render(
			<>
				<MermaidBlock code="flowchart LR; A-->B" />
				<MermaidBlock code="flowchart LR; C-->D" />
				<MermaidBlock code="flowchart LR; E-->F" />
			</>,
		)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500)
		})

		expect(mermaidMocks.render).toHaveBeenCalledTimes(3)
		expect(mermaidMocks.parse).not.toHaveBeenCalled()
	})

	it("replaces scheduled work with the latest code before rendering", async () => {
		vi.useFakeTimers()
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		const { rerender } = render(<MermaidBlock code="flowchart LR; A-->B" />)
		rerender(<MermaidBlock code="flowchart LR; C-->D" />)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})

		expect(mermaidMocks.render).toHaveBeenCalledTimes(1)
		expect(mermaidMocks.render).toHaveBeenCalledWith(expect.any(String), "flowchart LR; C-->D")
	})

	it("shows render validation failures in the existing expandable error view", async () => {
		vi.useFakeTimers()
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockRejectedValue(new Error("Invalid diagram syntax"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { default: MermaidBlock } = await import("../MermaidBlock")
		try {
			render(<MermaidBlock code="invalid diagram" />)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})

			expect(screen.getByText("common:mermaid.render_error")).toBeInTheDocument()
			expect(screen.queryByText("common:mermaid.loading")).not.toBeInTheDocument()
			expect(screen.queryByText("Invalid diagram syntax")).not.toBeInTheDocument()
			fireEvent.click(screen.getByText("common:mermaid.render_error"))
			expect(screen.getByText("Invalid diagram syntax")).toBeInTheDocument()
			expect(screen.queryByRole("button", { name: "common:mermaid.buttons.open" })).not.toBeInTheDocument()
		} finally {
			warning.mockRestore()
		}
	})

	it("ignores a stale rejection after a newer diagram has rendered", async () => {
		vi.useFakeTimers()
		const pending = deferred<{ svg: string }>()
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockReturnValueOnce(pending.promise).mockResolvedValue({ svg: '<svg data-code="B"></svg>' })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { default: MermaidBlock } = await import("../MermaidBlock")
		try {
			const { container, rerender } = render(<MermaidBlock code="diagram A" />)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})
			rerender(<MermaidBlock code="diagram B" />)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})
			expect(container.querySelector('[data-code="B"]')).toBeInTheDocument()

			await act(async () => {
				pending.reject(new Error("Stale diagram failure"))
			})

			expect(container.querySelector('[data-code="B"]')).toBeInTheDocument()
			expect(screen.queryByText("common:mermaid.render_error")).not.toBeInTheDocument()
			expect(warning).not.toHaveBeenCalled()
		} finally {
			warning.mockRestore()
		}
	})

	it("ignores an in-flight render failure after unmount", async () => {
		vi.useFakeTimers()
		const pending = deferred<{ svg: string }>()
		mermaidMocks.render.mockReset()
		mermaidMocks.render.mockReturnValue(pending.promise)
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { default: MermaidBlock } = await import("../MermaidBlock")
		try {
			const { unmount } = render(<MermaidBlock code="diagram A" />)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})
			expect(mermaidMocks.render).toHaveBeenCalledTimes(1)
			unmount()
			await act(async () => {
				pending.reject(new Error("Unmounted diagram failure"))
			})
			expect(warning).not.toHaveBeenCalled()
		} finally {
			warning.mockRestore()
		}
	})
})
