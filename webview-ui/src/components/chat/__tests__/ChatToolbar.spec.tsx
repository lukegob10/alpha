import { cleanup, fireEvent, render, screen, waitFor } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"

import ChatToolbar, { type ChatToolbarProps } from "../ChatToolbar"

const createProps = (overrides: Partial<ChatToolbarProps> = {}): ChatToolbarProps => ({
	renderContext: "editor",
	debug: false,
	onNewChat: vi.fn(),
	onOpenSettings: vi.fn(),
	onOpenTickets: vi.fn(),
	onOpenIncidents: vi.fn(),
	onOpenScheduledTasks: vi.fn(),
	onOpenMarketplace: vi.fn(),
	...overrides,
})

const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" })

describe("ChatToolbar", () => {
	it("omits the entire empty sidebar toolbar so history starts at the top", () => {
		const { container } = render(<ChatToolbar {...createProps({ renderContext: "sidebar" })} />)
		expect(screen.queryByRole("group", { name: "Chat actions" })).not.toBeInTheDocument()
		expect(container).toBeEmptyDOMElement()
	})

	it("keeps sidebar navigation without duplicating native host actions", () => {
		render(<ChatToolbar {...createProps({ renderContext: "sidebar", navigation: <button>Switch chat</button> })} />)
		expect(screen.getByRole("button", { name: "Switch chat" })).toBeInTheDocument()
		expect(screen.getAllByRole("button")).toHaveLength(1)
		for (const label of ["New chat", "Settings", "Alpha Tickets", "More actions"]) {
			expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument()
		}
	})

	it("cleans up an open editor menu when the host changes to sidebar", () => {
		const props = createProps({ navigation: <button>Switch chat</button> })
		const { rerender } = render(<ChatToolbar {...props} />)
		openMenu()
		expect(screen.getByRole("menu")).toBeInTheDocument()
		rerender(<ChatToolbar {...props} renderContext="sidebar" />)
		expect(screen.queryByRole("menu")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument()
	})
	it("preserves the navigation slot and dedicated chat actions", () => {
		const props = createProps({ navigation: <button>Switch chat</button> })
		render(<ChatToolbar {...props} />)

		expect(screen.getByRole("button", { name: "Switch chat" })).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "New chat" }))
		fireEvent.click(screen.getByRole("button", { name: "Settings" }))
		fireEvent.click(screen.getByRole("button", { name: "Alpha Tickets" }))
		expect(props.onNewChat).toHaveBeenCalledTimes(1)
		expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
		expect(props.onOpenTickets).toHaveBeenCalledTimes(1)
		expect(props.onOpenIncidents).not.toHaveBeenCalled()
	})

	it("limits the standard More menu to Scheduled Tasks and Marketplace", () => {
		const props = createProps()
		render(<ChatToolbar {...props} />)
		openMenu()

		expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
			"Scheduled Tasks",
			"Marketplace",
		])
		fireEvent.click(screen.getByRole("menuitem", { name: "Scheduled Tasks" }))
		expect(props.onOpenScheduledTasks).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole("menu")).not.toBeInTheDocument()
		openMenu()
		fireEvent.click(screen.getByRole("menuitem", { name: "Marketplace" }))
		expect(props.onOpenMarketplace).toHaveBeenCalledTimes(1)
		expect(props.onOpenIncidents).not.toHaveBeenCalled()
	})

	it("gates Incident Dashboard with the current developer setting", () => {
		const props = createProps({ debug: true })
		const { rerender } = render(<ChatToolbar {...props} />)
		openMenu()

		expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
			"Alpha: Incident Dashboard",
			"Scheduled Tasks",
			"Marketplace",
		])
		fireEvent.click(screen.getByRole("menuitem", { name: "Alpha: Incident Dashboard" }))
		expect(props.onOpenIncidents).toHaveBeenCalledTimes(1)
		openMenu()
		rerender(<ChatToolbar {...props} debug={false} />)
		expect(screen.queryByRole("menuitem", { name: "Alpha: Incident Dashboard" })).not.toBeInTheDocument()
		expect(screen.getAllByRole("menuitem")).toHaveLength(2)
	})

	it("supports keyboard menu navigation, selection, Escape, and focus return", async () => {
		const previousFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
		const previousActiveElement = Object.getOwnPropertyDescriptor(document, "activeElement")
		let activeElement: Element = document.body
		const focusOn = (element: HTMLElement) => {
			activeElement = element
			element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
		}
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement })
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: function (this: HTMLElement) {
				focusOn(this)
			},
		})

		try {
			const user = userEvent.setup()
			const props = createProps()
			render(<ChatToolbar {...props} />)
			const trigger = screen.getByRole("button", { name: "More actions" })
			trigger.focus()
			await user.keyboard("{Enter}")
			await waitFor(() => expect(screen.getByRole("menuitem", { name: "Scheduled Tasks" })).toHaveFocus())
			await user.keyboard("{ArrowDown}")
			expect(screen.getByRole("menuitem", { name: "Marketplace" })).toHaveFocus()
			await user.keyboard("{Enter}")
			expect(props.onOpenMarketplace).toHaveBeenCalledTimes(1)
			await waitFor(() => expect(trigger).toHaveFocus())

			await user.keyboard("{Enter}")
			await waitFor(() => expect(screen.getByRole("menuitem", { name: "Scheduled Tasks" })).toHaveFocus())
			await user.keyboard("{Escape}")
			await waitFor(() => {
				expect(screen.queryByRole("menu")).not.toBeInTheDocument()
				expect(trigger).toHaveFocus()
			})
			expect(props.onOpenScheduledTasks).not.toHaveBeenCalled()
		} finally {
			cleanup()
			if (previousFocus) Object.defineProperty(HTMLElement.prototype, "focus", previousFocus)
			if (previousActiveElement) Object.defineProperty(document, "activeElement", previousActiveElement)
			else Reflect.deleteProperty(document, "activeElement")
		}
	})
})
