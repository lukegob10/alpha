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
		version: "3.2.0",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.0" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.0")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.0 improves task reliability, recovery, and alignment with Codex CLI."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Tasks preserve context and recover more reliably after interruptions, cancellations, and reloads.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Commands, tools, and model providers report clearer outcomes and retain ordered results.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Delegated agents and questions keep their progress and responses through task handoffs."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Skills, previews, Alpha Tickets, and scheduled tasks remain integrated with the shared task engine.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.0 improves task reliability, recovery, and alignment with Codex CLI."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Tasks preserve context and recover more reliably after interruptions, cancellations, and reloads.",
			),
		).toBeInTheDocument()
	})
})
