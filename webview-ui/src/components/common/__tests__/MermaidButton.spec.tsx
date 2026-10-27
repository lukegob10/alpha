import userEvent from "@testing-library/user-event"
import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import common from "@/i18n/locales/en/common.json"
import { MermaidButton } from "../MermaidButton"

const mermaidMocks = vi.hoisted(() => ({ initialize: vi.fn(), parse: vi.fn(), render: vi.fn() }))
vi.mock("mermaid", () => ({ default: mermaidMocks }))
vi.mock("../CodeBlock", () => ({ default: () => null }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			key
				.replace(/^common:/, "")
				.split(".")
				.reduce<unknown>(
					(value, part) => (value && typeof value === "object" ? Reflect.get(value, part) : key),
					common,
				),
	}),
}))

describe("Mermaid viewer actions", () => {
	let restoreFocus: () => void
	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
	})
	afterEach(() => {
		restoreFocus()
	})

	it("offers a visible action to open the vector preview without saving or rasterizing", () => {
		const open = vi.fn()
		const save = vi.fn(async () => {})
		render(
			<MermaidButton code="flowchart LR; A-->B" isLoading={false} onOpen={open} onSave={save}>
				<span>Preview</span>
			</MermaidButton>,
		)
		fireEvent.click(screen.getByRole("button", { name: common.mermaid.buttons.open }))
		expect(open).toHaveBeenCalledTimes(1)
		expect(save).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: common.mermaid.buttons.save }))
		expect(save).toHaveBeenCalledTimes(1)
		expect(open).toHaveBeenCalledTimes(1)
	})

	it("preserves the accessible source view and restores keyboard focus when closed", async () => {
		const code = "flowchart LR\n A[Source] --> B[Workbook]"
		render(
			<MermaidButton code={code} isLoading={false} onOpen={vi.fn()} onSave={vi.fn(async () => {})}>
				<span>Preview</span>
			</MermaidButton>,
		)
		const source = screen.getByRole("button", { name: common.mermaid.buttons.viewCode })
		await userEvent.click(source)
		expect(screen.getByRole("textbox", { name: common.mermaid.modal.codeTitle })).toHaveValue(code)
		await userEvent.keyboard("{Escape}")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(source).toHaveFocus()
	})

	it("disables opening and hides export actions until the diagram is ready", () => {
		render(
			<MermaidButton code="flowchart LR; A-->B" isLoading onOpen={vi.fn()} onSave={vi.fn(async () => {})}>
				<span>Loading</span>
			</MermaidButton>,
		)
		expect(screen.getByRole("button", { name: common.mermaid.buttons.open })).toBeDisabled()
		expect(screen.queryByRole("button", { name: common.mermaid.buttons.save })).not.toBeInTheDocument()
	})

	it("preserves the source opener and its focus through the modal's body pointer lock", async () => {
		vi.useFakeTimers()
		mermaidMocks.parse.mockResolvedValue(true)
		mermaidMocks.render.mockResolvedValue({ svg: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>' })
		const { default: MermaidBlock } = await import("../MermaidBlock")
		const { unmount } = render(<MermaidBlock code="flowchart LR; A-->B" />)
		try {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500)
			})
			const opener = screen.getByRole("button", { name: common.mermaid.buttons.viewCode })
			opener.focus()
			await act(async () => {
				fireEvent.click(opener)
				await Promise.resolve()
			})
			expect(screen.getByRole("dialog", { name: common.mermaid.modal.codeTitle })).toBeInTheDocument()
			expect(document.body.style.pointerEvents).toBe("none")
			expect(opener).toBeInTheDocument()
			fireEvent.keyDown(document, { key: "Escape" })
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
			expect(opener).toHaveFocus()
		} finally {
			unmount()
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0)
			})
			vi.useRealTimers()
		}
	})
})
