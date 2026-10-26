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
		version: "3.2.10",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.10" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.10")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.10 adds optional local memories and improves conversation reliability."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Preserve conversation state and execution settings through follow-ups, recovery, and reloads.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Choose curated frontier models and supported reasoning settings across providers."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Enable local memories with separate controls for use, background generation, and reset."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Use a cleaner settings layout and notification sounds without legacy speech controls."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.10 adds optional local memories and improves conversation reliability."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Preserve conversation state and execution settings through follow-ups, recovery, and reloads.",
			),
		).toBeInTheDocument()
	})
})
