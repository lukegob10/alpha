import { Profiler } from "react"
import type { ExtensionState, IndexingStatus } from "@alpha-code/types"

import { act, cleanup, fireEvent, render, screen } from "@src/utils/test-utils"
import { PopoverTrigger } from "@src/components/ui"
import { ExtensionStateContextProvider, useExtensionState } from "@src/context/ExtensionStateContext"

import { CodeIndexPopover } from "../CodeIndexPopover"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
}))

vi.mock("@src/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))

vi.mock("@src/hooks/useEscapeKey", () => ({ useEscapeKey: vi.fn() }))

const indexingStatus: IndexingStatus = {
	systemStatus: "Standby",
	processedItems: 0,
	totalItems: 0,
}

const publishState = (state: Partial<ExtensionState>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const TranscriptProbe = () => {
	const { alphaMessages } = useExtensionState()
	return <output data-testid="transcript-text">{alphaMessages.at(-1)?.text}</output>
}

const renderPopover = (onRender = vi.fn()) => {
	render(
		<ExtensionStateContextProvider>
			<Profiler id="code-index-popover" onRender={onRender}>
				<CodeIndexPopover indexingStatus={indexingStatus}>
					<PopoverTrigger asChild>
						<button type="button">Open code index</button>
					</PopoverTrigger>
				</CodeIndexPopover>
			</Profiler>
			<TranscriptProbe />
		</ExtensionStateContextProvider>,
	)
	return onRender
}

const getProjectField = () => {
	const fields = [
		...new Set(
			screen
				.getAllByPlaceholderText("settings:placeholders.projectId")
				.map((element) => element.closest<HTMLElement>("vscode-text-field")),
		),
	]
	expect(fields).toHaveLength(1)
	const [field] = fields
	if (!field) throw new Error("Expected the Vertex project field")
	return field
}

describe("CodeIndexPopover context isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})

	afterEach(async () => {
		try {
			cleanup()
			await act(async () => {
				await vi.runOnlyPendingTimersAsync()
			})
		} finally {
			vi.unstubAllGlobals()
			vi.useRealTimers()
		}
	})

	it("does not render the closed popover during 100 accepted streaming frames", () => {
		let pendingFrame: FrameRequestCallback | undefined
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			pendingFrame = callback
			return 1
		})
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		const onRender = renderPopover()
		publishState({
			currentTaskId: "streaming-task",
			alphaMessagesSeq: 1,
			alphaMessages: [{ ts: 1, type: "say", say: "text", text: "initial", partial: true }],
		})
		const rendersAfterHydration = onRender.mock.calls.length

		for (let index = 1; index <= 100; index++) {
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "messageUpdated",
							taskId: "streaming-task",
							alphaMessagesSeq: index + 1,
							alphaMessage: { ts: 1, type: "say", say: "text", text: `chunk-${index}`, partial: true },
						},
					}),
				)
			})
			expect(pendingFrame).toBeDefined()
			const frame = pendingFrame
			pendingFrame = undefined
			act(() => frame?.(index * 16))
		}

		expect(screen.getByTestId("transcript-text")).toHaveTextContent("chunk-100")
		expect(onRender.mock.calls.length - rendersAfterHydration).toBe(0)
	})

	it("resyncs host configuration while keeping unsaved project edits", async () => {
		const onRender = renderPopover()
		const config: ExtensionState["codebaseIndexConfig"] = {
			codebaseIndexEnabled: true,
			codebaseIndexEmbedderProvider: "vertex",
			codebaseIndexVertexProjectId: "initial-project",
			codebaseIndexVertexRegion: "global",
		}
		publishState({ codebaseIndexConfig: config })
		const rendersAfterHydration = onRender.mock.calls.length
		publishState({ codebaseIndexConfig: { ...config, codebaseIndexVertexProjectId: "updated-project" } })
		expect(onRender.mock.calls.length).toBeGreaterThan(rendersAfterHydration)

		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		expect(getProjectField()).toHaveProperty("value", "updated-project")

		publishState({ codebaseIndexConfig: { ...config, codebaseIndexVertexProjectId: "latest-project" } })
		expect(getProjectField()).toHaveProperty("value", "latest-project")
		act(() => {
			Object.assign(getProjectField(), { value: "draft-project" })
			fireEvent.input(getProjectField())
		})
		publishState({ codebaseIndexConfig: { ...config, codebaseIndexVertexProjectId: "peer-project" } })
		expect(getProjectField()).toHaveProperty("value", "draft-project")
	})
})
