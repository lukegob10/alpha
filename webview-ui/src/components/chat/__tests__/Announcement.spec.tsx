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
		version: "3.2.7",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.7" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.7")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.7 improves task reliability, responsiveness, and Codex CLI alignment."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Keep task startup, cancellation, history, and image drafts consistent across chat surfaces.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Run bounded command-output searches, isolate custom tools, and preserve provider responses and usage.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Validate worker changes and deliver results after Apply and verification have settled."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Track files with less repeated work and protect concurrent skill edits."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.7 improves task reliability, responsiveness, and Codex CLI alignment."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep task startup, cancellation, history, and image drafts consistent across chat surfaces.",
			),
		).toBeInTheDocument()
	})
})
