import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SkillMetadata, ScheduledTask, WebviewMessage } from "@alpha-code/types"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import labels from "@/i18n/locales/en/scheduledTasks.json"
import ScheduledTasksView from "../ScheduledTasksView"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, string | number>) =>
			labels[key.replace("scheduledTasks:", "") as keyof typeof labels]?.replace(
				/\{\{(\w+)\}\}/g,
				(_, name: string) => String(options?.[name] ?? ""),
			) ?? key,
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
const skill: SkillMetadata = {
	name: "email-workflow",
	description: "Review the inbox",
	path: "/scheduled/.agents/skills/email-workflow/SKILL.md",
	source: "project",
}
const saved: ScheduledTask = {
	id: "scheduled",
	name: "Morning review",
	prompt: "Summarize changes",
	enabled: true,
	workspace: "/scheduled",
	mode: "architect",
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

const select = (name: string, value: string) =>
	fireEvent.change(screen.getByRole("combobox", { name: new RegExp(`^${name}`) }), { target: { value } })
const input = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const messages = () => vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message as WebviewMessage)
const replySkills = (
	skills: SkillMetadata[],
	request = messages()
		.filter((message) => message.type === "requestScheduledTaskSkills")
		.at(-1)!,
) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "scheduledTaskSkills",
					scheduledTaskSkills: { requestId: request.scheduledTaskSkillsRequest?.requestId, skills },
				},
			}),
		)
	})

describe("scheduled task setup", () => {
	let state: ReturnType<typeof useExtensionState>
	beforeEach(() => {
		vi.clearAllMocks()
		state = {
			scheduledTasks: [],
			scheduledTaskRuns: [],
			cwd: "/coding",
			mode: "code",
			customModes: [],
			listApiConfigMeta: [
				{ ...apiConfig, apiProvider: "openai" },
				{ id: "coding", name: "Coding", apiProvider: "anthropic" },
			],
		} as unknown as ReturnType<typeof useExtensionState>
		vi.mocked(useExtensionState).mockImplementation(() => state)
	})

	it("saves a prompt without a skill on an explicitly selected profile", () => {
		render(<ScheduledTasksView onDone={() => {}} />)
		input("Name", "Prompt review")
		input("Prompt", "Review the repository")
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
		select("Profile", apiConfig.id)
		select("Mode", "architect")
		fireEvent.click(screen.getByRole("button", { name: "Create" }))
		expect(messages().at(-1)).toMatchObject({
			type: "createScheduledTask",
			scheduledTask: {
				apiConfig,
				prompt: "Review the repository",
				execution: { type: "prompt" },
				mode: "architect",
				workspace: "/coding",
			},
		})
		expect(messages().some((message) => message.type === "requestScheduledTaskSkills")).toBe(false)
	})

	it("lists imported skills and saves the skill and arguments without requiring a prompt", () => {
		render(<ScheduledTasksView onDone={() => {}} />)
		input("Name", "Morning email")
		select("Profile", apiConfig.id)
		select("Execution", "skill")
		expect(messages().at(-1)).toMatchObject({
			type: "requestScheduledTaskSkills",
			scheduledTaskSkillsRequest: { workspace: "/coding", mode: "code" },
		})
		replySkills([skill])
		select("Skill", skill.name)
		input("Arguments", "unread")
		fireEvent.click(screen.getByRole("button", { name: "Create" }))
		expect(messages().at(-1)).toMatchObject({
			type: "createScheduledTask",
			scheduledTask: {
				apiConfig,
				prompt: "",
				execution: { type: "skill", skillName: skill.name, skillPath: skill.path, arguments: "unread" },
			},
		})
	})

	it("clears skill fields when switching back to Prompt", () => {
		render(<ScheduledTasksView onDone={() => {}} />)
		input("Name", "Review")
		select("Profile", apiConfig.id)
		select("Execution", "skill")
		replySkills([skill])
		select("Skill", skill.name)
		input("Arguments", "unread")
		select("Execution", "prompt")
		input("Prompt", "Review the repository")
		fireEvent.click(screen.getByRole("button", { name: "Create" }))
		expect(messages().at(-1)?.scheduledTask?.execution).toEqual({ type: "prompt" })
	})

	it("edits a legacy schedule without changing its workspace and requires a profile", () => {
		state.scheduledTasks = [saved]
		render(<ScheduledTasksView onDone={() => {}} />)
		expect(screen.getByLabelText("Prompt")).toHaveValue(saved.prompt)
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
		select("Profile", apiConfig.id)
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(messages().at(-1)).toMatchObject({
			type: "updateScheduledTask",
			scheduledTaskUpdate: { apiConfig, workspace: "/scheduled", mode: "architect", prompt: saved.prompt },
		})
	})

	it("rejects late skill catalogs after changing mode and preserves unavailable selections", () => {
		state.scheduledTasks = [
			{ ...saved, apiConfig, execution: { type: "skill", skillName: skill.name, skillPath: skill.path } },
		]
		render(<ScheduledTasksView onDone={() => {}} />)
		const oldRequest = messages().at(-1)!
		replySkills([skill])
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
		select("Mode", "code")
		replySkills([skill], oldRequest)
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
		replySkills([])
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
	})

	it("keeps local edits when state refreshes and disables a renamed profile", () => {
		state.scheduledTasks = [{ ...saved, apiConfig }]
		const view = render(<ScheduledTasksView onDone={() => {}} />)
		input("Prompt", "Unsaved edits")
		state = { ...state, listApiConfigMeta: [{ ...apiConfig, name: "Renamed", apiProvider: "openai" }] }
		view.rerender(<ScheduledTasksView onDone={() => {}} />)
		expect(screen.getByLabelText("Prompt")).toHaveValue("Unsaved edits")
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
		expect(screen.getByRole("status")).toHaveTextContent("Internal models")
	})

	it("shows interval units and hides repetition for a one-time schedule", () => {
		state.scheduledTasks = [{ ...saved, apiConfig }]
		render(<ScheduledTasksView onDone={() => {}} />)
		select("Schedule", "weekly")
		input("Repeat every", "3")
		expect(screen.getByText("weeks")).toBeVisible()
		select("Schedule", "once")
		expect(screen.queryByRole("spinbutton", { name: "Repeat every" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(messages().at(-1)?.scheduledTaskUpdate?.schedule).toEqual({
			type: "once",
			startAt: expect.any(Number),
			timezone: expect.any(String),
		})
		select("Schedule", "weekly")
		expect(screen.getByRole("spinbutton", { name: "Repeat every" })).toHaveValue(3)
	})

	it("keeps approval choices when collapsed or disabled without submitting the form", async () => {
		const user = userEvent.setup()
		state.scheduledTasks = [{ ...saved, apiConfig }]
		render(<ScheduledTasksView onDone={() => {}} />)
		const approvals = screen.getByRole("button", { name: /Auto-approval/ })
		expect(approvals).toHaveAttribute("aria-expanded", "false")
		await user.click(approvals)
		await user.click(screen.getByRole("checkbox", { name: "Write files" }))
		await user.click(approvals)
		expect(approvals).toHaveTextContent("Selected: 2")
		await user.click(approvals)
		expect(screen.getByRole("checkbox", { name: "Write files" })).toBeChecked()
		await user.click(screen.getByRole("checkbox", { name: "Enable auto-approval" }))
		expect(screen.getByRole("checkbox", { name: "Write files" })).toBeDisabled()
		expect(messages()).toEqual([])
		await user.click(screen.getByRole("button", { name: "Save" }))
		expect(messages().at(-1)?.scheduledTaskUpdate?.autoApproval).toMatchObject({
			autoApprovalEnabled: false,
			alwaysAllowWrite: true,
		})
	})

	it("keeps command execution approval enabled", async () => {
		const user = userEvent.setup()
		render(<ScheduledTasksView onDone={() => {}} />)
		select("Execution", "command")
		await user.click(screen.getByRole("button", { name: /Auto-approval/ }))
		for (const name of ["Enable auto-approval", "Execute commands"]) {
			expect(screen.getByRole("checkbox", { name })).toBeChecked()
			expect(screen.getByRole("checkbox", { name })).toBeDisabled()
		}
	})

	it("shows the effective command approvals when editing a legacy schedule", async () => {
		const user = userEvent.setup()
		state.scheduledTasks = [{ ...saved, execution: { type: "command", command: "pnpm test" } }]
		render(<ScheduledTasksView onDone={() => {}} />)
		await user.click(screen.getByRole("button", { name: /Auto-approval/ }))
		for (const name of ["Enable auto-approval", "Execute commands"]) {
			expect(screen.getByRole("checkbox", { name })).toBeChecked()
			expect(screen.getByRole("checkbox", { name })).toBeDisabled()
		}
	})

	it("runs the selected schedule without submitting unsaved edits", async () => {
		const user = userEvent.setup()
		state.scheduledTasks = [{ ...saved, apiConfig }]
		render(<ScheduledTasksView onDone={() => {}} />)
		input("Prompt", "Unsaved edits")
		await user.click(screen.getByRole("button", { name: "Run Now" }))
		expect(messages()).toEqual([{ type: "runScheduledTaskNow", scheduledTaskId: saved.id }])
		expect(screen.getByLabelText("Prompt")).toHaveValue("Unsaved edits")
	})

	it("makes secondary actions keyboard accessible and restores focus to the menu trigger", async () => {
		// Shared test setup replaces DOM focus. Observe focus requests and dispatch keys to their targets.
		const focus = vi.fn()
		const originalFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, get: () => focus })
		try {
			state.scheduledTasks = [{ ...saved, apiConfig }]
			render(<ScheduledTasksView onDone={() => {}} />)
			const trigger = screen.getByRole("button", { name: "More actions" })
			fireEvent.keyDown(trigger, { key: "Enter" })
			const pause = await screen.findByRole("menuitem", { name: "Pause" })
			await waitFor(() => expect(focus.mock.contexts).toContain(screen.getByRole("menu")))
			fireEvent.keyDown(pause, { key: "Enter" })
			expect(messages()).toEqual([{ type: "pauseScheduledTask", scheduledTaskId: saved.id }])
			await waitFor(() => expect(focus.mock.contexts.at(-1)).toBe(trigger))
			fireEvent.keyDown(trigger, { key: "Enter" })
			fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }))
			expect(messages().at(-1)).toEqual({ type: "duplicateScheduledTask", scheduledTaskId: saved.id })
			fireEvent.keyDown(trigger, { key: "Enter" })
			fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
			expect(messages().at(-1)).toEqual({ type: "deleteScheduledTask", scheduledTaskId: saved.id })
			expect(screen.getByRole("heading", { name: "New scheduled task" })).toBeVisible()
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", originalFocus)
		}
	})
})
