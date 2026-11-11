import { expect } from "vitest"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { Section } from "../Section"

describe("shared settings card", () => {
	it("keeps nested controls in one frame and retains drafts through a parent refresh", () => {
		const view = (label: string) => (
			<Section grouped data-testid="page-card">
				<h4>{label}</h4>
				<Section>
					<input aria-label="Pending command" defaultValue="" />
				</Section>
				<Section>
					<button>Manage integration</button>
				</Section>
			</Section>
		)
		const { container, rerender } = render(view("Preferences"))
		const draft = screen.getByRole("textbox", { name: "Pending command" })
		fireEvent.change(draft, { target: { value: "pnpm pending-draft" } })

		rerender(view("Updated preferences"))

		expect(container.querySelectorAll(".surface-raised")).toHaveLength(1)
		expect(draft.closest(".surface-raised")).toBe(screen.getByTestId("page-card"))
		expect(screen.getByRole("button").closest(".surface-raised")).toBe(screen.getByTestId("page-card"))
		expect(screen.getByRole("textbox")).toBe(draft)
		expect(draft).toHaveValue("pnpm pending-draft")
	})

	it("preserves a separate frame outside the grouped page", () => {
		const { container } = render(
			<>
				<Section grouped data-testid="grouped-page">
					<Section>
						<button>Grouped control</button>
					</Section>
				</Section>
				<Section data-testid="provider-card">
					<button>Provider control</button>
				</Section>
			</>,
		)

		expect(container.querySelectorAll(".surface-raised")).toHaveLength(2)
		expect(screen.getByRole("button", { name: "Grouped control" }).closest(".surface-raised")).toBe(
			screen.getByTestId("grouped-page"),
		)
		expect(screen.getByRole("button", { name: "Provider control" }).closest(".surface-raised")).toBe(
			screen.getByTestId("provider-card"),
		)
	})
})
