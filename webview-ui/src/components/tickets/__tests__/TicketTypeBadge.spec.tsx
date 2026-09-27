import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ticketTypeSchema } from "@alpha-code/types"
import { TicketTypeBadge } from "../TicketTypeBadge"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("TicketTypeBadge", () => {
	it.each(ticketTypeSchema.options)("renders %s with its visible label and colored dot", (type) => {
		render(<TicketTypeBadge type={type} />)

		const label = screen.getByText(`types.${type}`)
		const badge = label.closest(".ticket-type-badge")
		expect(badge).toHaveAttribute("data-type", type)
		expect(badge?.querySelector(".ticket-type-dot")).toHaveAttribute("aria-hidden", "true")
	})
})
