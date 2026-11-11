import type { ExtensionMessage, SkillMetadata } from "@alpha-code/types"

import { act, render, screen } from "@/utils/test-utils"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const SkillsConsumer = () => {
	const { skills, skillsError } = useExtensionState()
	return (
		<>
			<div data-testid="skill-names">{skills?.map((skill) => skill.name).join(",")}</div>
			<div data-testid="skills-error">{skillsError ?? ""}</div>
		</>
	)
}

const sendSkills = (message: Pick<ExtensionMessage, "type" | "skills" | "skillsError">) => {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
}

describe("ExtensionStateContext skills catalog", () => {
	it("retains the last successful catalog on failure and clears the error after an empty successful refresh", () => {
		render(
			<ExtensionStateContextProvider>
				<SkillsConsumer />
			</ExtensionStateContextProvider>,
		)
		const skill: SkillMetadata = {
			name: "workspace-review",
			description: "Review workspace changes",
			path: "/workspace/.agents/skills/workspace-review/SKILL.md",
			source: "project",
		}
		sendSkills({ type: "skills", skills: [skill] })

		sendSkills({ type: "skills", skillsError: "unavailable" })

		expect(screen.getByTestId("skill-names")).toHaveTextContent(skill.name)
		expect(screen.getByTestId("skills-error")).toHaveTextContent("unavailable")

		// Catalog updates from older extension hosts and file watchers have no error field.
		sendSkills({ type: "skills", skills: [] })

		expect(screen.getByTestId("skill-names")).toBeEmptyDOMElement()
		expect(screen.getByTestId("skills-error")).toBeEmptyDOMElement()
	})

	it("does not let an incomplete skills message erase an error or catalog", () => {
		render(
			<ExtensionStateContextProvider>
				<SkillsConsumer />
			</ExtensionStateContextProvider>,
		)
		sendSkills({ type: "skills", skillsError: "unavailable" })

		sendSkills({ type: "skills" })

		expect(screen.getByTestId("skills-error")).toHaveTextContent("unavailable")
	})
})
