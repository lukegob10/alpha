import React from "react"

import { render, screen } from "@/utils/test-utils"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@alpha/package", () => ({
	Package: {
		version: "2.1.3",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

describe("Announcement", () => {
	it("renders the current release announcement", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Welcome to Alpha v2.1.3")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v2.1.3 focuses everyday agent work on a clean Plan and Code workflow without changing the proven Code loop.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(screen.getByText("Plan and Code are the only ordinary user-facing mode choices.")).toBeInTheDocument()
		expect(screen.getByText("Press Shift+Tab in the chat composer to switch between them.")).toBeInTheDocument()
		expect(screen.getByText("Code and Plan stay in the same task and provider configuration.")).toBeInTheDocument()
		expect(screen.getByText("Existing legacy and custom-mode tasks remain compatible.")).toBeInTheDocument()
	})
})
