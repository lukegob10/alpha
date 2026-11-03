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
		version: "3.2.21",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.21" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.21")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.21 improves command recovery, task history, and completed-turn folding."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Keep completed turns folded and load task history sooner when opening a VS Code window."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Recover completed commands cleanly and preserve tool and reasoning state with GitHub Copilot.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep long-running tasks and sub-agent handoffs consistent as work continues."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Ticket import and export notices dismiss automatically after a short delay."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.21 improves command recovery, task history, and completed-turn folding."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep completed turns folded and load task history sooner when opening a VS Code window."),
		).toBeInTheDocument()
	})
})
