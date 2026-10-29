import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComponentProps } from "react"
import type { Ticket } from "@alpha-code/types"
import { TicketReader } from "../TicketReader"

const markdownRender = vi.hoisted(() => vi.fn())
const translation = vi.hoisted(() => ({ prefix: "" }))
vi.mock("react-markdown", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-markdown")>()
	const Markdown = actual.default
	return {
		...actual,
		default: (props: ComponentProps<typeof Markdown>) => {
			markdownRender(props.children)
			return <Markdown {...props} />
		},
	}
})
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => `${translation.prefix}${key}` }),
}))

const ticket: Ticket = {
	schemaVersion: 1,
	id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
	name: "Keep ticket content stable",
	status: "backlog",
	type: "bug",
	priority: "high",
	createdAt: "2026-09-07T00:00:00.000Z",
	updatedAt: "2026-09-07T00:00:00.000Z",
	linkedTaskIds: [],
	revision: "v1",
	description: "Keep **drafts** intact.",
	context: "[Docs](https://example.com/docs) [Local](file:///private) ![Diagram](https://example.com/image.png)",
	successCriteria: "- [x] Preserve content\n- [ ] Report conflicts",
	implementationSummary: "Keep existing ticket content.",
}

const props = {
	busy: false,
	changed: false,
	onEdit: vi.fn(),
	onAddChild: vi.fn(),
	onWork: vi.fn(),
	onReload: vi.fn(),
	onDelete: vi.fn(),
	onOpenRelated: vi.fn(),
	onOpenLinkedTask: vi.fn(),
	childTickets: [],
	relationsLoading: false,
	onStatusChange: vi.fn(),
	onPriorityChange: vi.fn(),
	onTypeChange: vi.fn(),
	statusPending: false,
}

beforeEach(() => {
	markdownRender.mockClear()
	translation.prefix = ""
})

describe("TicketReader Markdown invalidation", () => {
	it("reuses all four fields across 25 accepted metadata-only ticket revisions", () => {
		const { rerender } = render(<TicketReader {...props} ticket={ticket} />)
		expect(markdownRender).toHaveBeenCalledTimes(4)
		markdownRender.mockClear()

		for (let index = 0; index < 25; index++) {
			rerender(
				<TicketReader
					{...props}
					ticket={{
						...ticket,
						revision: `v${index + 2}`,
						status: index % 2 === 0 ? "in-progress" : "backlog",
						type: index % 2 === 0 ? "performance" : "bug",
						priority: index % 2 === 0 ? "low" : "high",
					}}
				/>,
			)
		}

		expect(markdownRender).not.toHaveBeenCalled()
		expect(screen.getByRole("combobox", { name: "statusOf" })).toHaveValue("in-progress")
		expect(screen.getByRole("combobox", { name: "type" })).toHaveValue("performance")
		expect(screen.getByRole("combobox", { name: "priority" })).toHaveValue("low")
		const context = screen.getByRole("region", { name: "context" })
		expect(within(context).getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://example.com/docs")
		expect(within(context).getByRole("link", { name: "Docs" })).toHaveAttribute("rel", "noreferrer noopener")
		expect(within(context).queryByRole("link", { name: "Local" })).not.toBeInTheDocument()
		expect(within(context).getByText("Local")).toBeVisible()
		expect(within(context).getByText("Diagram")).toBeVisible()
		expect(within(context).queryByRole("img")).not.toBeInTheDocument()
	})

	it.each(["description", "context", "successCriteria", "implementationSummary"] as const)(
		"renders only the changed %s field after reloading ticket content",
		(field) => {
			const { rerender } = render(<TicketReader {...props} ticket={ticket} />)
			markdownRender.mockClear()
			const content = `Updated **${field}** content.`
			rerender(<TicketReader {...props} ticket={{ ...ticket, [field]: content, revision: "v2" }} />)

			expect(markdownRender).toHaveBeenCalledExactlyOnceWith(content)
			expect(screen.getByRole("region", { name: field }).querySelector("strong")).toHaveTextContent(field)
		},
	)

	it("updates translated headings while reusing unchanged field content", () => {
		const { rerender } = render(<TicketReader {...props} ticket={ticket} />)
		markdownRender.mockClear()
		translation.prefix = "translated:"
		rerender(<TicketReader {...props} ticket={ticket} />)

		expect(markdownRender).not.toHaveBeenCalled()
		expect(screen.getByRole("region", { name: "translated:description" })).toHaveTextContent("Keep drafts intact.")
		expect(screen.queryByRole("heading", { name: "description" })).not.toBeInTheDocument()
	})

	it("keeps empty implementation notes visible and removes an optional field when cleared", () => {
		const { rerender } = render(<TicketReader {...props} ticket={ticket} />)
		markdownRender.mockClear()
		rerender(
			<TicketReader {...props} ticket={{ ...ticket, context: "", implementationSummary: "", revision: "v2" }} />,
		)

		expect(markdownRender).toHaveBeenCalledExactlyOnceWith("")
		expect(screen.queryByRole("region", { name: "context" })).not.toBeInTheDocument()
		expect(screen.getByRole("region", { name: "implementationSummary" })).toBeVisible()
	})
})
