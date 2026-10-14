import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import type { ScheduledTask, TaskReasoningPreference, TaskReasoningState, WebviewMessage } from "@alpha-code/types"

import scheduledLabels from "@/i18n/locales/en/scheduledTasks.json"
import chatLabels from "@/i18n/locales/en/chat.json"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import ScheduledTasksView from "../ScheduledTasksView"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, string | number>) => {
			const [namespace, path] = key.split(":")
			const source =
				namespace === "scheduledTasks" ? scheduledLabels : namespace === "chat" ? chatLabels : undefined
			const value = path?.split(".").reduce<unknown>((current, part) => {
				if (!current || typeof current !== "object") return undefined
				return (current as Record<string, unknown>)[part]
			}, source)
			if (typeof value === "string") {
				return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ""))
			}
			if (key.startsWith("settings:providers.reasoningEffort.")) {
				return key
					.split(".")
					.at(-1)!
					.replace(/^./, (character) => character.toUpperCase())
			}
			return key
		},
		i18n: { resolvedLanguage: "en" },
	}),
}))
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value: string
		onValueChange: (value: string) => void
		children: React.ReactNode
	}) => (
		<select value={value} onChange={(event) => onValueChange(event.target.value)}>
			<option value="" />
			{children}
		</select>
	),
	SelectTrigger: () => null,
	SelectValue: () => null,
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
		<option value={value}>{children}</option>
	),
}))

const apiConfig = { id: "internal", name: "Internal models" }
const profiles = [
	{ ...apiConfig, apiProvider: "vertex", modelId: "gemini-2.5-pro" },
	{ id: "copilot", name: "Copilot", apiProvider: "copilot", modelId: "copilot-gpt-5.5" },
]

const savedTask: ScheduledTask = {
	id: "scheduled",
	name: "Morning review",
	prompt: "Summarize changes",
	enabled: true,
	workspace: "/coding",
	mode: "code",
	schedule: { type: "daily", startAt: Date.now() + 60_000, timezone: "UTC", intervalDays: 1 },
	permissions: {
		readFiles: true,
		runCommands: false,
		editFiles: false,
		stageChanges: false,
		commitChanges: false,
		pushBranches: false,
		openPullRequests: false,
		sendNotifications: false,
	},
	notificationPreference: "never",
	createdAt: 1,
	updatedAt: 1,
}

const state = {
	scheduledTasks: [],
	scheduledTaskRuns: [],
	cwd: "/coding",
	mode: "code",
	customModes: [],
	listApiConfigMeta: profiles,
} as unknown as ReturnType<typeof useExtensionState>

const allMessages = () => vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message as WebviewMessage)
const reasoningMessages = () => allMessages().filter((message) => message.type === "getReasoningCapabilities")
const select = (name: string, value: string) =>
	fireEvent.change(screen.getByRole("combobox", { name: new RegExp(`^${name}`) }), { target: { value } })

const reasoningState = (requested: TaskReasoningPreference = { kind: "default" }): TaskReasoningState => ({
	requested,
	effective: requested,
	capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
})

const replyReasoning = (response: { state?: unknown; error?: string }, request = reasoningMessages().at(-1)!) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "reasoningCapabilities",
					taskReasoningResponse: {
						requestId: request.requestId,
						...response,
					},
				},
			}),
		)
	})

function LayoutProbe({ epoch, onLayout }: { epoch: number; onLayout: (snapshot: unknown) => void }) {
	useLayoutEffect(() => {
		if (epoch === 0) return
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="reasoning-trigger"]')
		onLayout({
			dialogState: document.querySelector('[role="dialog"]')?.getAttribute("data-state"),
			mediumRadio: Boolean(document.querySelector('[role="radio"][aria-label="Medium"]')),
			disabled: trigger?.disabled ?? false,
			label: trigger?.getAttribute("aria-label"),
		})
	}, [epoch, onLayout])

	return <ScheduledTasksView onDone={() => {}} />
}

describe("scheduled task reasoning selector integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		profiles[0].modelId = "gemini-2.5-pro"
		vi.mocked(useExtensionState).mockImplementation(() => state)
	})

	it("renders the real selector and scopes capability state to the selected profile", async () => {
		const layoutSnapshots: unknown[] = []
		const onLayout = (snapshot: unknown) => layoutSnapshots.push(snapshot)
		const { rerender } = render(<LayoutProbe epoch={0} onLayout={onLayout} />)
		select("Profile", apiConfig.id)

		const firstRequest = reasoningMessages().at(-1)!
		expect(firstRequest).toMatchObject({
			type: "getReasoningCapabilities",
			reasoningProfileId: apiConfig.id,
			reasoningPreference: { kind: "default" },
		})
		expect(screen.getByTestId("reasoning-trigger")).toBeDisabled()
		expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: Loading…")

		replyReasoning({ state: reasoningState({ kind: "effort", effort: "medium" }) }, firstRequest)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-trigger")).toBeEnabled()
			expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: Medium")
		})

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		expect(screen.getByRole("dialog", { name: "Reasoning" })).toBeInTheDocument()
		expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuetext", "Medium")

		profiles[0].modelId = "gemini-2.5-flash"
		rerender(<LayoutProbe epoch={1} onLayout={onLayout} />)
		expect(layoutSnapshots.at(-1)).toEqual({
			dialogState: "closed",
			mediumRadio: false,
			disabled: true,
			label: "Reasoning: Loading…",
		})

		const secondRequest = reasoningMessages().at(-1)!
		expect(secondRequest).not.toEqual(firstRequest)
		expect(secondRequest).toMatchObject({ reasoningProfileId: apiConfig.id })

		// A response for the superseded capability request must not revive the old menu.
		replyReasoning({ state: reasoningState({ kind: "effort", effort: "high" }) }, firstRequest)
		expect(screen.getByTestId("reasoning-trigger")).toBeDisabled()
		expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: Loading…")

		replyReasoning({ error: "unavailable" }, secondRequest)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-trigger")).toBeDisabled()
			expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: Unavailable")
			expect(screen.getByRole("alert")).toHaveTextContent(
				"This model has no verified adjustable reasoning capability.",
			)
		})
	})

	it("selects a preference in the real dropdown and saves it with the schedule", async () => {
		state.scheduledTasks = [{ ...savedTask, apiConfig }]
		render(<ScheduledTasksView onDone={() => {}} />)

		const initialRequest = reasoningMessages().at(-1)!
		replyReasoning({ state: reasoningState({ kind: "effort", effort: "medium" }) }, initialRequest)
		await waitFor(() => expect(screen.getByTestId("reasoning-trigger")).toBeEnabled())

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		fireEvent.keyDown(screen.getByRole("slider", { name: "Reasoning" }), { key: "End" })

		const refreshedRequest = reasoningMessages().at(-1)!
		replyReasoning({ state: reasoningState({ kind: "effort", effort: "high" }) }, refreshedRequest)
		await waitFor(() => expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: High"))

		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "updateScheduledTask",
				scheduledTaskId: savedTask.id,
				scheduledTaskUpdate: expect.objectContaining({
					reasoningPreference: { kind: "effort", effort: "high" },
				}),
			})
		})
	})
})
