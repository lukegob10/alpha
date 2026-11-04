import React from "react"
import { act, cleanup, fireEvent, render, screen } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AlphaMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"chat:fileOperations.wantsToEdit": "Alpha wants to edit this file",
				"chat:fileOperations.wantsToEditProtected": "Alpha wants to edit a protected file",
				"chat:fileOperations.wantsToEditOutsideWorkspace": "Alpha wants to edit outside workspace",
				"chat:fileOperations.wantsToCreate": "Alpha wants to create a new file",
				"chat:fileOperations.wantsToApplyBatchChanges": "Alpha wants to apply batch changes",
			}
			return map[key] || key
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock CodeBlock (avoid ESM/highlighter costs)
vi.mock("@src/components/common/CodeBlock", () => ({
	default: () => null,
}))

const queryClient = new QueryClient()

function createToolAskMessage(toolPayload: Record<string, unknown>): AlphaMessage {
	return {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		partial: false,
		text: JSON.stringify(toolPayload),
	}
}

function renderChatRow(message: AlphaMessage, isExpanded = false) {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={message}
					isExpanded={isExpanded}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
					onBatchFileResponse={() => {}}
					onFollowUpUnmount={() => {}}
					isFollowUpAnswered={false}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - inline diff stats and actions", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		vi.clearAllMocks()
		mockPostMessage.mockClear()
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it.each(["{Enter}", " "])("opens a read source from the keyboard with %s", async (key) => {
		const user = userEvent.setup()
		renderChatRow(
			createToolAskMessage({ tool: "readFile", path: "src/file.ts", content: "src/file.ts", startLine: 3 }),
			true,
		)
		const source = screen.getByRole("button", { name: /src\/file\.ts/ })
		await user.tab()
		await user.tab()
		expect(source).toHaveFocus()
		await user.keyboard(key)

		expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "openFile")).toEqual([
			[{ type: "openFile", text: "src/file.ts", values: { line: 3 } }],
		])
		expect(source.querySelector("button, a, input, [tabindex]")).toBeNull()
	})

	it.each([
		{ flags: { isProtected: true }, label: "Alpha wants to edit a protected file", lock: true },
		{ flags: { isOutsideWorkspace: true }, label: "Alpha wants to edit outside workspace", lock: false },
	])("shows batch approval scope: $label", ({ flags, label, lock }) => {
		const message = createToolAskMessage({
			tool: "appliedDiff",
			...flags,
			batchDiffs: [{ path: "file.txt", content: "-old\n+new", changeCount: 1 }],
		})
		const { container } = renderChatRow(message)
		expect(screen.getByText(label)).toBeInTheDocument()
		expect(!!container.querySelector(".codicon-lock")).toBe(lock)
	})

	it("exposes sent-message actions as native buttons", () => {
		const message: AlphaMessage = {
			type: "say",
			say: "user_feedback",
			ts: 123,
			text: "Please update the implementation",
		}
		renderChatRow(message)
		const editButton = screen.getByRole("button", { name: "chat:messageActions.edit" })
		const deleteButton = screen.getByRole("button", { name: "common:confirmation.deleteMessage" })
		expect(editButton.tagName).toBe("BUTTON")
		expect(deleteButton.tagName).toBe("BUTTON")
		expect(deleteButton).toHaveAttribute("type", "button")
		expect(editButton).toBeDisabled()
		expect(deleteButton).toBeDisabled()
		expect(screen.getByRole("button", { name: "chat:messageActions.copy" })).toBeEnabled()
		fireEvent.click(deleteButton)
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteMessage" }))

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "native-actions-task" } },
				}),
			)
		})
		expect(editButton).toBeEnabled()
		expect(deleteButton).toBeEnabled()

		fireEvent.click(deleteButton)

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "deleteMessage",
			value: 123,
			taskId: "native-actions-task",
		})
	})

	it("uses appliedDiff edit treatment (header/icon/diff stats)", () => {
		const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n"
		const message = createToolAskMessage({
			tool: "appliedDiff",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message, false)

		expect(screen.getByText("Alpha wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("uses same edit treatment for editedExistingFile", () => {
		const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n"
		const message = createToolAskMessage({
			tool: "editedExistingFile",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 1 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Alpha wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("uses same edit treatment for searchAndReplace", () => {
		const diff = "-a\n-b\n+c\n"
		const message = createToolAskMessage({
			tool: "searchAndReplace",
			path: "src/file.ts",
			diff,
			diffStats: { added: 1, removed: 2 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Alpha wants to edit this file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-2")).toBeInTheDocument()
	})

	it("shows a creation label and line counts for newFileCreated", () => {
		const content = "a\nb\nc"
		const message = createToolAskMessage({
			tool: "newFileCreated",
			path: "src/new-file.ts",
			content,
			diffStats: { added: 3, removed: 0 },
		})

		const { container } = renderChatRow(message)

		expect(screen.getByText("Alpha wants to create a new file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-diff")).toBeInTheDocument()
		expect(screen.getByText("+3")).toBeInTheDocument()
		expect(screen.getByText("-0")).toBeInTheDocument()
	})

	it.each(["{Enter}", " "])("opens the complete new-file row with %s without inline expansion", async (key) => {
		const user = userEvent.setup()
		const message = createToolAskMessage({
			tool: "newFileCreated",
			path: "src/new-file.ts",
			content: "+new file",
			originalContent: "",
			finalContent: "new file\n",
			diffStats: { added: 1, removed: 0 },
		})
		const { container } = renderChatRow(message, true)
		const row = screen.getByRole("button", { name: /src\/new-file.ts/ })
		row.focus()
		await user.keyboard(key)
		expect(container.querySelector(".codicon-link-external")).toBeNull()
		expect(row).not.toHaveAttribute("aria-expanded")
		expect(row).not.toHaveAttribute("aria-controls")
		expect(container.querySelector("[data-testid='diff-view']")).toBeNull()
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "chat:fileChangesInConversation.diffTitleForFile",
				files: [{ path: "src/new-file.ts", originalContent: "", finalContent: "new file\n" }],
			},
		})
	})

	it("opens a legacy edit's saved patch in the editor", () => {
		renderChatRow(createToolAskMessage({ tool: "appliedDiff", path: "legacy.ts", diff: "-old\n+new" }), true)
		fireEvent.click(screen.getByRole("button", { name: /legacy.ts/ }))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "chat:fileChangesInConversation.diffTitleForFile",
				patch: { path: "legacy.ts", content: "Index: legacy.ts\n-old\n+new" },
			},
		})
	})

	it("opens batch-file rows directly while preserving the approval scope", () => {
		renderChatRow(
			createToolAskMessage({
				tool: "appliedDiff",
				isProtected: true,
				batchDiffs: [
					{
						path: "batch.ts",
						content: "-old\n+new",
						originalContent: "old\n",
						finalContent: "new\n",
						changeCount: 1,
					},
				],
			}),
			true,
		)
		expect(screen.getByText("Alpha wants to edit a protected file")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /batch.ts/ }))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openDiff",
			payload: {
				title: "chat:fileChangesInConversation.diffTitleForFile",
				files: [{ path: "batch.ts", originalContent: "old\n", finalContent: "new\n" }],
			},
		})
	})

	it("preserves protected and outside-workspace messaging in unified branch", () => {
		const outsideWorkspaceMessage = createToolAskMessage({
			tool: "searchAndReplace",
			path: "../outside/file.ts",
			diff: "-a\n+b\n",
			isOutsideWorkspace: true,
			diffStats: { added: 1, removed: 1 },
		})
		renderChatRow(outsideWorkspaceMessage)
		expect(screen.getByText("Alpha wants to edit outside workspace")).toBeInTheDocument()

		const protectedMessage = createToolAskMessage({
			tool: "appliedDiff",
			path: "src/protected.ts",
			diff: "-a\n+b\n",
			isProtected: true,
			diffStats: { added: 1, removed: 1 },
		})
		const { container } = renderChatRow(protectedMessage)
		expect(screen.getByText("Alpha wants to edit a protected file")).toBeInTheDocument()
		expect(container.querySelector(".codicon-lock")).toBeInTheDocument()
	})

	it("keeps batch diff handling for unified edit tools", () => {
		const message = createToolAskMessage({
			tool: "searchAndReplace",
			batchDiffs: [
				{
					path: "src/a.ts",
					changeCount: 1,
					key: "a",
					content: "@@ -1,1 +1,1 @@\n-a\n+b\n",
					diffStats: { added: 1, removed: 1 },
				},
			],
		})

		renderChatRow(message)

		expect(screen.getByText("Alpha wants to apply batch changes")).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
	})
})
