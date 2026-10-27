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
		version: "3.2.13",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.13" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.13")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.13 completes the Alpha naming cleanup and fixes New Chat shortcut focus."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(screen.getByText("Open a new task directly in Alpha with the New Chat shortcut.")).toBeInTheDocument()
		expect(
			screen.getByText("Use Alpha-only configuration paths, credentials, saved fields, and public APIs."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Configure a fresh profile; previous naming aliases are no longer supported."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep your previous release profile and package available when returning to an earlier version.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.13 completes the Alpha naming cleanup and fixes New Chat shortcut focus."),
		).toBeInTheDocument()
		expect(screen.getByText("Open a new task directly in Alpha with the New Chat shortcut.")).toBeInTheDocument()
	})
})
