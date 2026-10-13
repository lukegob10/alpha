import { render, screen } from "@/utils/test-utils"
import { GoalApproval } from "../GoalApproval"

describe("GoalApproval", () => {
	it("shows the concrete objective, budget and autonomous continuation bound before approval", () => {
		const { container } = render(
			<GoalApproval
				activity={{ operation: "create", objective: "Check <script>alert(1)</script>", tokenBudget: 10000 }}
			/>,
		)
		expect(screen.getByRole("group", { name: "Goal approval" })).toBeInTheDocument()
		expect(screen.getByText("Check <script>alert(1)</script>")).toBeInTheDocument()
		expect(screen.getByText("Goal token budget: 10000")).toBeInTheDocument()
		expect(screen.getByText(/Up to 20 automatic continuations/)).toBeInTheDocument()
		expect(container.querySelector("script")).toBeNull()
	})

	it("makes pause approval explicit", () => {
		render(<GoalApproval activity={{ operation: "pause", objective: "Parser" }} />)
		expect(screen.getByText("Pause this goal?")).toBeInTheDocument()
		expect(screen.queryByText(/automatic continuations/)).not.toBeInTheDocument()
	})

	it.each([
		undefined,
		{ operation: "resume", objective: "Parser" },
		{ operation: "create", objective: "Parser", tokenBudget: -1 },
	])("safely rejects malformed approval details %j", (activity) => {
		render(<GoalApproval activity={activity} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Goal approval details are unavailable")
	})
})
