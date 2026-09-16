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
		version: "2.1.43",
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

		expect(screen.getByText("Welcome to Alpha v2.1.43")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v2.1.43 makes file evidence safer and more precise while preserving the proven Code loop.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Large reads return complete visible lines with an honest continuation when more evidence is needed.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Batch reads and searches honor each file's requested scope and output mode."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"File edits preserve the user's bytes, including line endings and literal replacement text.",
			),
		).toBeInTheDocument()
		expect(screen.getByText("Plan and Code remain the ordinary user-facing mode choices.")).toBeInTheDocument()
	})
})
