import userEvent from "@testing-library/user-event"
import type { SkillMetadata } from "@alpha-code/types"

import { act, cleanup, render, screen, waitFor, within } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { vscode } from "@/utils/vscode"

import { SkillsSettings } from "../SkillsSettings"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) =>
			key === "settings:helpFor" ? `Help for ${options?.label}` : key,
	}),
}))

const skill: SkillMetadata = {
	name: "review-changes",
	description: "Review local changes for correctness and regressions.",
	path: "/workspace/.agents/skills/review-changes/SKILL.md",
	source: "project",
	modeSlugs: ["code"],
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ cwd: "/workspace", customModes: [], skills: [skill] }),
}))

describe("compact Skills settings with real tooltips and help", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		vi.clearAllMocks()
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it("shows the skill name and actions without descriptions, source paths, or mode details", () => {
		const { container } = render(<SkillsSettings embedded />)
		const row = screen.getByRole("group", { name: skill.name })

		expect(within(row).getByText(skill.name)).toBeVisible()
		expect(within(row).getByRole("button", { name: "settings:skills.editSkill" })).toBeEnabled()
		expect(within(row).getByRole("button", { name: `Help for ${skill.name}` })).toBeEnabled()
		expect(screen.queryByText(skill.description)).not.toBeInTheDocument()
		expect(screen.queryByText(skill.path)).not.toBeInTheDocument()
		expect(container.querySelector("code")).toBeNull()
		expect(screen.queryByText("settings:skills.appliesImmediately")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:skills.builtinDescription")).not.toBeInTheDocument()
	})

	it("shows the actual skill description on hover without exposing its path", async () => {
		const user = userEvent.setup()
		render(<SkillsSettings embedded />)

		await user.hover(screen.getByText(skill.name))

		expect(await screen.findByRole("tooltip")).toHaveTextContent(skill.description)
		expect(screen.queryByText(skill.path)).not.toBeInTheDocument()
	})

	it("makes the description available when the skill name receives keyboard focus", async () => {
		render(<SkillsSettings embedded />)
		const name = screen.getByText(skill.name)

		act(() => name.focus())

		expect(name).toHaveFocus()
		expect(await screen.findByRole("tooltip")).toHaveTextContent(skill.description)
	})

	it("offers the description through a touch-accessible help action and restores focus on Escape", async () => {
		const user = userEvent.setup()
		render(<SkillsSettings embedded />)
		const help = screen.getByRole("button", { name: `Help for ${skill.name}` })

		await user.pointer([
			{ keys: "[TouchA>]", target: help },
			{ keys: "[/TouchA]", target: help },
		])

		expect(await screen.findByRole("dialog", { name: `Help for ${skill.name}` })).toHaveTextContent(
			skill.description,
		)
		expect(screen.queryByText(skill.path)).not.toBeInTheDocument()
		await user.keyboard("{Escape}")

		await waitFor(() => expect(help).toHaveFocus())
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestSkills" })
	})
})
