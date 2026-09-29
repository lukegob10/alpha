import React from "react"

import { render, screen } from "@/utils/test-utils"
import { TranslationContext } from "@src/i18n/TranslationContext"
import i18n from "@src/i18n/setup"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@alpha/package", () => ({
	Package: {
		version: "3.1.1",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

const renderAnnouncement = (language = "en") =>
	render(
		<TranslationContext.Provider value={{ i18n, t: (key, options) => i18n.t(key, { ...options, lng: language }) }}>
			<Announcement hideAnnouncement={vi.fn()} />
		</TranslationContext.Provider>,
	)

describe("Announcement", () => {
	it("renders the current release announcement", () => {
		renderAnnouncement()

		expect(screen.getByText("Welcome to Alpha v3.1.1")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.1.1 keeps longer agent tasks moving and makes scheduled runs and task history more predictable.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Keep useful progress across repeated tool calls and recover when checkpoint setup is slow.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Give managed agents enough token budget to finish normal multi-step work."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Run scheduled tasks only in open VS Code workspaces, with one claim across windows."),
		).toBeInTheDocument()
		expect(screen.getByText("Keep task history scoped to the current project.")).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.1.1 keeps longer agent tasks moving and makes scheduled runs and task history more predictable.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep useful progress across repeated tool calls and recover when checkpoint setup is slow.",
			),
		).toBeInTheDocument()
	})
})
