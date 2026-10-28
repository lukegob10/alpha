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
		version: "3.2.14",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.14" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.14")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.14 adds frontier providers, instant model setup, and refreshed branding."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Choose your model and reasoning level separately without waiting for discovery."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Connect Amazon Bedrock, Sign in with ChatGPT, and Meta alongside the existing providers.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep selected models consistent across chats and delegated work, with clear errors for retired models.",
			),
		).toBeInTheDocument()
		expect(screen.getByText("Find the refreshed Alpha wolf branding throughout the extension.")).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.14 adds frontier providers, instant model setup, and refreshed branding."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Choose your model and reasoning level separately without waiting for discovery."),
		).toBeInTheDocument()
	})
})
