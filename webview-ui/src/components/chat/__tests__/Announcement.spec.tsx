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
		version: "3.2.5",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.5" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.5")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.2.5 improves agent coordination, saved settings, and chat responsiveness on VS Code 1.138.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Keep agent updates, queued messages, and chat recovery consistent across cancellation and reloads.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Retain saved provider profiles and report unavailable selections without silently switching providers.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Deliver sub-agent results and reviews while preserving workspace and approval limits."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Browse chats and file changes with less repeated work, and cancel prompt previews safely.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.2.5 improves agent coordination, saved settings, and chat responsiveness on VS Code 1.138.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep agent updates, queued messages, and chat recovery consistent across cancellation and reloads.",
			),
		).toBeInTheDocument()
	})
})
