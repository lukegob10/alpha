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
		version: "3.2.17",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.17" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.17")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.17 expands GitHub Copilot model choices and preserves reasoning settings."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(screen.getByText("Keep the resolved reasoning level visible throughout a chat.")).toBeInTheDocument()
		expect(
			screen.getByText("Choose Grok 4.6, Grok 4.7, and Claude Haiku 5.5 in GitHub Copilot."),
		).toBeInTheDocument()
		expect(screen.getByText("Use each model's supported reasoning levels for delegated work.")).toBeInTheDocument()
		expect(
			screen.getByText("Select the full GPT-5.6 family, GPT-6 Astra, Luna and Sol, and GPT-6.1 Terra and Sol."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.17 expands GitHub Copilot model choices and preserves reasoning settings."),
		).toBeInTheDocument()
		expect(screen.getByText("Keep the resolved reasoning level visible throughout a chat.")).toBeInTheDocument()
	})
})
