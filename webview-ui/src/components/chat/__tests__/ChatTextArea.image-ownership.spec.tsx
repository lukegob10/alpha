import { useLayoutEffect } from "react"
import { act, fireEvent, render, screen } from "@src/utils/test-utils"
import { defaultModeSlug } from "@alpha/modes"
import { ChatTextArea } from "../ChatTextArea"
import { useTaskComposer } from "../hooks/useTaskComposer"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")
vi.mock("../ChatView", () => ({ MAX_IMAGES_PER_MESSAGE: 20 }))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useShellState: () => ({ filePaths: [], openedTabs: [], taskHistory: [], clineMessages: [], cwd: "/workspace" }),
	useExtensionState: () => ({ filePaths: [], openedTabs: [], taskHistory: [], clineMessages: [], cwd: "/workspace" }),
}))

class ControlledFileReader {
	static pending: ControlledFileReader[] = []
	result: string | null = null
	error: DOMException | null = null
	readyState = 0
	onloadend: (() => void) | null = null
	abort = vi.fn(() => {
		this.readyState = 2
		this.onloadend?.()
	})
	readAsDataURL() {
		this.readyState = 1
		ControlledFileReader.pending.push(this)
	}
	finish(result: string) {
		this.result = result
		this.readyState = 2
		this.onloadend?.()
	}
}

const noOp = () => {}
const image = "data:image/png;base64,origin-image"

function Composer({
	taskId,
	visible = true,
	onImageUpdate,
}: {
	taskId?: string
	visible?: boolean
	onImageUpdate?: () => void
}) {
	const composer = useTaskComposer(taskId)
	const { updateTaskDraft } = composer
	useLayoutEffect(() => {
		updateTaskDraft(undefined, (draft) => ({ ...draft, inputValue: "new chat draft" }))
	}, [updateTaskDraft])
	return (
		<>
			<output data-testid="task-a-images">{JSON.stringify(composer.getTaskDraft("a").selectedImages)}</output>
			<output data-testid="task-b-images">{JSON.stringify(composer.getTaskDraft("b").selectedImages)}</output>
			<output data-testid="new-draft">{JSON.stringify(composer.getTaskDraft(undefined))}</output>
			<ChatTextArea
				inputValue={composer.inputValue}
				setInputValue={composer.setInputValue}
				selectedImages={composer.selectedImages}
				setSelectedImages={
					onImageUpdate
						? (action) => {
								onImageUpdate()
								composer.setSelectedImages(action)
							}
						: composer.setSelectedImages
				}
				sendingDisabled={false}
				selectApiConfigDisabled={false}
				placeholderText="Message"
				onSend={noOp}
				onSelectImages={noOp}
				shouldDisableImages={false}
				mode={defaultModeSlug}
				setMode={noOp}
				modeShortcutText=""
				conversationTaskId={taskId}
				conversationClineMessages={[]}
				isVisible={visible}
			/>
		</>
	)
}

function startImageRead(method: "paste" | "drop", container: HTMLElement) {
	const file = new File(["image"], "image.png", { type: "image/png" })
	if (method === "paste") {
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				getData: () => "",
				items: [{ type: file.type, getAsFile: () => file }],
			},
		})
	} else {
		fireEvent.drop(container.querySelector(".chat-text-area")!, {
			dataTransfer: { getData: () => "", files: [file] },
		})
	}
	return ControlledFileReader.pending.at(-1)!
}

describe("asynchronous composer image ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		ControlledFileReader.pending = []
		vi.stubGlobal("FileReader", ControlledFileReader)
	})
	afterEach(() => vi.unstubAllGlobals())

	it.each(["paste", "drop"] as const)("keeps a pending %s with task A after selecting B", async (method) => {
		const view = render(<Composer taskId="a" />)
		const reader = startImageRead(method, view.container)
		expect(reader).toBeDefined()
		view.rerender(<Composer taskId="b" />)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft b" } })
		await act(async () => reader.finish(image))
		expect(screen.getByTestId("task-a-images")).toHaveTextContent(JSON.stringify([image]))
		expect(screen.getByTestId("task-b-images")).toHaveTextContent("[]")
		expect(screen.getByRole("textbox")).toHaveValue("draft b")
		expect(screen.getByTestId("new-draft")).toHaveTextContent('"inputValue":"new chat draft"')
	})

	it("keeps new-chat paste ownership after selecting an existing task", async () => {
		const view = render(<Composer />)
		const reader = startImageRead("paste", view.container)
		view.rerender(<Composer taskId="b" />)
		await act(async () => reader.finish(image))
		expect(screen.getByTestId("task-b-images")).toHaveTextContent("[]")
		expect(screen.getByTestId("new-draft")).toHaveTextContent(`"selectedImages":["${image}"]`)
		expect(screen.getByTestId("new-draft")).toHaveTextContent('"inputValue":"new chat draft"')
	})

	it("retains pasted attachments when the composer loses focus or becomes hidden", async () => {
		const view = render(<Composer taskId="a" />)
		const reader = startImageRead("paste", view.container)
		fireEvent.blur(screen.getByRole("textbox"))
		view.rerender(<Composer taskId="a" visible={false} />)
		await act(async () => reader.finish(image))
		expect(screen.getByTestId("task-a-images")).toHaveTextContent(JSON.stringify([image]))
	})

	it.each(["paste", "drop"] as const)(
		"aborts pending %s reads and ignores completion after disposal",
		async (method) => {
			const onImageUpdate = vi.fn()
			const view = render(<Composer taskId="a" onImageUpdate={onImageUpdate} />)
			const reader = startImageRead(method, view.container)
			view.unmount()
			expect(reader.abort).toHaveBeenCalledTimes(1)
			vi.mocked(vscode.postMessage).mockClear()
			await act(async () => reader.finish(image))
			expect(onImageUpdate).not.toHaveBeenCalled()
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "draggedImages" }))
		},
	)

	it("ignores an already-read image when disposal precedes its queued completion", async () => {
		const onImageUpdate = vi.fn()
		const view = render(<Composer taskId="a" onImageUpdate={onImageUpdate} />)
		const reader = startImageRead("paste", view.container)
		await act(async () => {
			reader.finish(image)
			view.unmount()
		})
		expect(onImageUpdate).not.toHaveBeenCalled()
		expect(reader.abort).not.toHaveBeenCalled()
	})
})
