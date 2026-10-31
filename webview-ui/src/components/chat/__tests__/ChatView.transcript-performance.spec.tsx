import React, { useImperativeHandle, useRef } from "react"
import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import type { AlphaMessage, ExtensionState } from "@alpha-code/types"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView from "../ChatView"
import { usePromptHistory } from "../hooks/usePromptHistory"

const captured = vi.hoisted(() => ({
	conversationMessages: [] as AlphaMessage[],
	onNewChat: undefined as (() => void) | undefined,
	onBackToHome: undefined as (() => void) | undefined,
	onViewAll: undefined as (() => void) | undefined,
}))

vi.mock("@/i18n/TranslationContext", async () => {
	const { default: i18n } = await import("@/i18n/setup")
	return { useAppTranslation: () => ({ t: (key: string) => key, i18n }) }
})
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("use-sound", () => ({ default: () => [() => {}] }))
vi.mock("@src/components/cloud/CloudUpsellDialog", () => ({ CloudUpsellDialog: () => null }))
vi.mock("@src/hooks/useCloudUpsell", () => ({
	useCloudUpsell: () => ({ isOpen: false, openUpsell: vi.fn(), closeUpsell: vi.fn(), handleConnect: vi.fn() }),
}))
vi.mock("@src/components/welcome/AlphaHero", () => ({ default: () => null }))
vi.mock("../../common/TelemetryBanner", () => ({ default: () => null }))
vi.mock("../Announcement", () => ({ default: () => null }))
vi.mock("../TaskHeader", () => ({ default: () => null }))
vi.mock("../CheckpointWarning", () => ({ CheckpointWarning: () => null }))
vi.mock("../QueuedMessages", () => ({ QueuedMessages: () => null }))
vi.mock("../WorktreeSelector", () => ({ WorktreeSelector: () => null }))
vi.mock("../FileChangesPanel", () => ({ default: () => null }))
vi.mock("../CrossTaskPanel", () => ({ CrossTaskPanel: () => null }))
vi.mock("../SubagentDock", () => ({ SubagentDock: () => null }))
vi.mock("../../history/HistoryPreview", () => ({ default: () => null }))
vi.mock("../../history/ChatHistorySwitcher", () => ({
	default: (props: { onBackToHome: () => void; onViewAll: () => void }) => {
		captured.onBackToHome = props.onBackToHome
		captured.onViewAll = props.onViewAll
		return <button onClick={props.onBackToHome}>Home</button>
	},
}))
vi.mock("../ChatToolbar", () => ({
	default: ({ onNewChat, navigation }: { onNewChat: () => void; navigation?: React.ReactNode }) => {
		captured.onNewChat = onNewChat
		return <>{navigation}</>
	},
}))
vi.mock("../ActivityTraceToggle", () => ({
	ActivityTraceToggle: ({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) => (
		<button data-testid="activity-toggle" aria-expanded={expanded} onClick={onToggle}>
			Activity
		</button>
	),
}))
vi.mock("../ChatRow", () => ({
	default: ({ message, isTaskPrompt }: { message: AlphaMessage; isTaskPrompt?: boolean }) => (
		<div data-testid="chat-row" data-message-ts={message.ts} data-task-prompt={Boolean(isTaskPrompt)}>
			{message.text}
		</div>
	),
}))
vi.mock("../ChatTextArea", () => {
	interface ComposerProps {
		inputValue: string
		setInputValue: (value: string) => void
		conversationAlphaMessages: AlphaMessage[]
		conversationTaskId?: string
		isInTask: boolean
	}
	const Composer = React.forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(props, ref) {
		const textarea = useRef<HTMLTextAreaElement>(null)
		useImperativeHandle(ref, () => textarea.current!)
		captured.conversationMessages = props.conversationAlphaMessages
		const { handleHistoryNavigation, resetOnInputChange } = usePromptHistory({
			taskId: props.conversationTaskId,
			alphaMessages: props.conversationAlphaMessages,
			taskHistory: undefined,
			cwd: undefined,
			inputValue: props.inputValue,
			setInputValue: props.setInputValue,
			isInTask: props.isInTask,
		})
		return (
			<textarea
				ref={textarea}
				aria-label="Message"
				value={props.inputValue}
				onChange={(event) => {
					resetOnInputChange()
					props.setInputValue(event.target.value)
				}}
				onKeyDown={(event) => handleHistoryNavigation(event, false, false)}
			/>
		)
	})
	return { ChatTextArea: Composer }
})

const openingPrompt: AlphaMessage = { ts: 1, type: "say", say: "text", text: "Task" }
const narrative = (ts: number, text = "Assistant output"): AlphaMessage => ({ ts, type: "say", say: "text", text })
const feedback = (ts: number, text: string): AlphaMessage => ({ ts, type: "say", say: "user_feedback", text })
const tool = (ts: number, payload: Record<string, unknown>, overrides?: Partial<AlphaMessage>): AlphaMessage => ({
	ts,
	type: "ask",
	ask: "tool",
	isAnswered: true,
	text: JSON.stringify(payload),
	...overrides,
})

const postState = (alphaMessages: AlphaMessage[], taskId = "task-a") => {
	const state: Partial<ExtensionState> = {
		version: "1.0.0",
		alphaMessages,
		currentTaskId: taskId,
		currentTaskItem: { id: taskId, number: 1, task: taskId, ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0 },
		taskHistory: [],
		shouldShowAnnouncement: false,
		allowedCommands: [],
		alwaysAllowExecute: false,
		telemetrySetting: "enabled",
	}
	window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
}

const renderView = () =>
	render(
		<ExtensionStateContextProvider>
			<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => {}} />
		</ExtensionStateContextProvider>,
	)

const hydrate = async (messages: AlphaMessage[]) => {
	renderView()
	await act(async () => postState(messages))
	await waitFor(() => expect(screen.getByTestId("chat-transcript-content")).toBeInTheDocument())
}

const input = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" })
const historyUp = () => {
	input().setSelectionRange(0, 0)
	fireEvent.keyDown(input(), { key: "ArrowUp" })
}
const historyDown = () => {
	input().setSelectionRange(0, 0)
	fireEvent.keyDown(input(), { key: "ArrowDown" })
}
const openActivities = () => {
	for (const toggle of screen.queryAllByTestId("activity-toggle")) {
		if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle)
	}
}
const renderedRows = () =>
	screen
		.getAllByTestId("chat-row")
		.filter((row) => row.dataset.taskPrompt !== "true")
		.map((row) => ({ ts: Number(row.dataset.messageTs), text: row.textContent ?? "" }))

describe("ChatView transcript derivation", () => {
	it("preserves a typed new-chat draft when deferred history arrives", async () => {
		renderView()
		const draft: Partial<ExtensionState> = {
			currentView: { type: "newTaskDraft" },
			currentTaskId: undefined,
			alphaMessages: [],
			taskStateSeq: 1,
			alphaMessagesSeq: 1,
			apiConfiguration: { apiProvider: "openai", openAiModelId: "fixture-model" },
		}
		await act(async () =>
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: draft } })),
		)
		const composer = input()
		fireEvent.change(composer, { target: { value: "Draft written while history recovers" } })
		await act(async () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							...draft,
							taskStateSeq: 2,
							alphaMessagesSeq: 2,
							taskHistory: [
								{
									id: "saved",
									number: 1,
									ts: 1,
									task: "Saved chat",
									tokensIn: 0,
									tokensOut: 0,
									totalCost: 0,
								},
							],
						},
					},
				}),
			),
		)
		expect(input()).toBe(composer)
		expect(input()).toHaveValue("Draft written while history recovers")
	})

	it("does not inspect old prompt text while typing against an unchanged long transcript", async () => {
		let promptTextReads = 0
		const oldPrompt = feedback(2, "A saved request")
		Object.defineProperty(oldPrompt, "text", {
			enumerable: true,
			get: () => {
				promptTextReads++
				return "A saved request"
			},
		})
		const messages = [openingPrompt, oldPrompt, ...Array.from({ length: 999 }, (_, index) => narrative(index + 3))]
		await hydrate(messages)
		expect(screen.getAllByTestId("chat-row")).toHaveLength(80)
		const prompts = captured.conversationMessages
		const callbacks = [captured.onNewChat, captured.onBackToHome, captured.onViewAll]
		promptTextReads = 0

		for (const value of ["d", "dr", "draft"]) fireEvent.change(input(), { target: { value } })

		expect(input()).toHaveValue("draft")
		expect(promptTextReads).toBe(0)
		expect(captured.conversationMessages).toBe(prompts)
		expect(captured.onNewChat).toBe(callbacks[0])
		expect(captured.onBackToHome).toBe(callbacks[1])
		expect(captured.onViewAll).toBe(callbacks[2])
		expect(screen.getAllByTestId("chat-row")).toHaveLength(80)
	})

	it("keeps prompt navigation and task drafts through streaming updates and navigation", async () => {
		const messages = [openingPrompt, feedback(2, "First request"), feedback(3, "Latest request"), narrative(4)]
		await hydrate(messages)
		fireEvent.change(input(), { target: { value: "Unsent draft" } })
		historyUp()
		expect(input()).toHaveValue("Latest request")
		const prompts = captured.conversationMessages

		for (let frame = 0; frame < 4; frame++) {
			await act(async () =>
				postState([...messages.slice(0, -1), { ...narrative(4, `Stream ${frame}`), partial: true }]),
			)
			expect(captured.conversationMessages).toBe(prompts)
		}
		historyUp()
		expect(input()).toHaveValue("First request")
		historyDown()
		historyDown()
		expect(input()).toHaveValue("Unsent draft")

		await act(async () => postState([narrative(10, "Other task"), feedback(11, "Other request")], "task-b"))
		historyUp()
		expect(input()).toHaveValue("Other request")
		await act(async () => postState(messages))
		expect(input()).toHaveValue("Unsent draft")
		historyUp()
		expect(input()).toHaveValue("Latest request")
	})

	it("uses the exact prompt sequence when text contains the old key separator", async () => {
		await hydrate([openingPrompt, feedback(2, "First\0" + "3:Second"), narrative(4)])
		await act(async () => postState([openingPrompt, feedback(2, "First"), feedback(3, "Second"), narrative(4)]))

		historyUp()
		expect(input()).toHaveValue("Second")
		historyUp()
		expect(input()).toHaveValue("First")
	})

	it("updates navigation after a saved prompt is edited or removed", async () => {
		await hydrate([openingPrompt, feedback(2, "First"), feedback(3, "Latest"), narrative(4)])
		await act(async () => postState([openingPrompt, feedback(2, "First"), feedback(3, "Edited"), narrative(4)]))
		historyUp()
		expect(input()).toHaveValue("Edited")
		await act(async () => postState([openingPrompt, feedback(2, "First"), feedback(3, "  "), narrative(4)]))
		historyUp()
		expect(input()).toHaveValue("First")
	})

	it("keeps exact mixed legacy batching fields, message order and narrative boundaries", async () => {
		const firstRead = { tool: "readFile", path: "a.ts", reason: "1–2", content: "a", isOutsideWorkspace: true }
		const firstList = { tool: "listFilesRecursive", path: "src" }
		const firstEdit = {
			tool: "appliedDiff",
			path: "a.ts",
			content: "patch a",
			diffStats: { added: 1, removed: 2 },
			originalContent: "before",
			finalContent: "after",
		}
		await hydrate([
			openingPrompt,
			tool(2, firstRead),
			tool(3, { tool: "readFile", path: "b.ts", content: "b" }),
			tool(4, firstList),
			tool(5, { tool: "listFilesTopLevel", path: "assets", isOutsideWorkspace: true }),
			tool(6, firstEdit),
			tool(7, { tool: "newFileCreated", path: "b.ts", diff: "patch b" }),
			tool(8, { tool: "readFile", path: "separate.ts" }),
			narrative(9, "A narrative boundary"),
			tool(10, { tool: "readFile", path: "c.ts" }),
			tool(11, { tool: "readFile", path: "d.ts" }),
			narrative(12),
		])
		openActivities()
		const rows = renderedRows()
		expect(rows.map((row) => row.ts)).toEqual([2, 4, 6, 8, 9, 10, 12])
		expect(JSON.parse(rows[0].text)).toEqual({
			...firstRead,
			batchFiles: [
				{ path: "a.ts", lineSnippet: "1–2", content: "a", key: "a.ts (1–2)", isOutsideWorkspace: true },
				{ path: "b.ts", lineSnippet: "", content: "b", key: "b.ts", isOutsideWorkspace: false },
			],
		})
		expect(JSON.parse(rows[1].text)).toEqual({
			...firstList,
			batchDirs: [
				{ path: "src", recursive: true, isOutsideWorkspace: false, key: "src" },
				{ path: "assets", recursive: false, isOutsideWorkspace: true, key: "assets" },
			],
		})
		expect(JSON.parse(rows[2].text)).toEqual({
			...firstEdit,
			batchDiffs: [
				{
					path: "a.ts",
					changeCount: 1,
					key: "a.ts",
					content: "patch a",
					diffStats: firstEdit.diffStats,
					originalContent: "before",
					finalContent: "after",
				},
				{ path: "b.ts", changeCount: 1, key: "b.ts", content: "patch b" },
			],
		})
		expect(JSON.parse(rows[3].text)).toEqual({ tool: "readFile", path: "separate.ts" })
		expect(rows[4].text).toBe("A narrative boundary")
		expect(JSON.parse(rows[5].text).batchFiles.map((file: { path: string }) => file.path)).toEqual(["c.ts", "d.ts"])
	})

	it.each([
		["readFile", "batchFiles"],
		["listFilesRecursive", "batchDirs"],
		["appliedDiff", "batchDiffs"],
	])("preserves %s partial, pending, canonical and previously batched boundaries", async (name, batchField) => {
		const completed = (ts: number, overrides?: Partial<AlphaMessage>) =>
			tool(ts, { tool: name, path: `${ts}.ts` }, overrides)
		const canonical = { runId: "saved-run", turnId: "saved-turn" }
		const messages = [
			openingPrompt,
			completed(2),
			completed(3, { partial: true }),
			completed(4),
			completed(5, { turn: canonical }),
			completed(6, { turn: canonical }),
			completed(7),
			completed(8, { isAnswered: false }),
			completed(9),
			tool(10, { tool: name, path: "batch.ts", [batchField]: [] }),
			completed(11),
			completed(12, { text: "{malformed JSON" }),
			completed(13),
			narrative(14),
		]
		await hydrate(messages)
		openActivities()

		expect(renderedRows()).toEqual(messages.slice(1).map((message) => ({ ts: message.ts, text: message.text })))
	})

	it("starts a blank task through the stable home callback without submitting button event text", async () => {
		await hydrate([openingPrompt, narrative(2)])
		fireEvent.click(screen.getByRole("button", { name: "Home" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startBlankTask" })
		expect(input()).toHaveValue("")
	})
})
