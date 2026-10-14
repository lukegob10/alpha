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
		version: "3.1.12",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.1.12" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.1.12")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.1.12 improves incident investigations, tool outcome visibility, and ticket search.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Investigations retain clearer tool and command evidence, with visible gaps when history is incomplete.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"The Incidents dashboard distinguishes failed, denied, cancelled, and unknown tool outcomes.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Incident reports include a concise summary and a follow-up prompt grounded in the available evidence.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Alpha Tickets suggestions reuse unchanged records and respond sooner while you type."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.1.12 improves incident investigations, tool outcome visibility, and ticket search.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Investigations retain clearer tool and command evidence, with visible gaps when history is incomplete.",
			),
		).toBeInTheDocument()
	})
})
