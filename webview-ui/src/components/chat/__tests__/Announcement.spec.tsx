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
		version: "3.2.20",
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
		expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.20" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.20")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.20 improves task reliability, lifecycle hooks, and Alpha Tickets."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Keep task completion, cancellation, and recovery consistent during long-running work."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Use command and MCP lifecycle hooks with Alpha's native approval and workspace protections.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep sub-agent permissions and task handoffs consistent with the parent chat."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Track ticket progress, import and export ticket bundles, and delete selected tickets with one approval.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.20 improves task reliability, lifecycle hooks, and Alpha Tickets."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep task completion, cancellation, and recovery consistent during long-running work."),
		).toBeInTheDocument()
	})
})
