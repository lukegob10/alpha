import type { SubagentModelRouteState } from "@alpha-code/types"
import { render, screen } from "@testing-library/react"
import i18next from "i18next"
import { initReactI18next } from "react-i18next"

import chat from "@/i18n/locales/en/chat.json"
import { SubagentModelStamp } from "../SubagentModelStamp"

const route: SubagentModelRouteState = {
	source: "parent",
	resolution: "selected",
	profileName: "Parent",
	provider: "openai-native",
	modelId: "child-model",
}

describe("SubagentModelStamp", () => {
	beforeAll(async () => {
		await i18next.use(initReactI18next).init({ lng: "en", resources: { en: { chat } } })
	})

	it("uses the frozen effective effort instead of a requested effort", () => {
		render(
			<SubagentModelStamp
				modelRoute={{
					...route,
					requestedReasoningEffort: "high",
					effectiveReasoning: { kind: "effort", effort: "medium" },
				}}
			/>,
		)
		expect(screen.getByText("child-model · Reasoning: medium")).toBeInTheDocument()
	})

	it.each([
		{ effectiveReasoning: { kind: "off" as const }, label: "off" },
		{ effectiveReasoning: { kind: "on" as const }, label: "on" },
		{ effectiveReasoning: { kind: "default" as const }, label: "default" },
		{ effectiveReasoning: { kind: "custom" as const, value: "deep" }, label: "deep" },
		{ requestedReasoningEffort: "high" as const, label: "unknown" },
		{ reasoningConfiguration: { enableReasoningEffort: true, reasoningEffort: "low" as const }, label: "low" },
		{ reasoningConfiguration: { enableReasoningEffort: false }, label: "off" },
	])("renders captured reasoning as $label without consulting current settings", ({ label, ...captured }) => {
		render(<SubagentModelStamp modelRoute={{ ...route, ...captured }} />)
		expect(screen.getByText(`child-model · Reasoning: ${label}`)).toBeInTheDocument()
	})

	it("omits an unavailable route and includes profile details when requested", () => {
		const { rerender, container } = render(<SubagentModelStamp />)
		expect(container).toBeEmptyDOMElement()
		rerender(<SubagentModelStamp modelRoute={route} includeProfile />)
		expect(screen.getByText("Parent · openai-native · child-model · Reasoning: unknown")).toBeInTheDocument()
	})
})
