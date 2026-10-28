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
		version: "3.2.15",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.15" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.15")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.15 restores GPT-5.6 Sol, Terra, and Luna with their reasoning levels."),
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
				"Choose GPT-5.6 with OpenAI, Sign in with ChatGPT, GitHub Copilot, OpenRouter, or Amazon Bedrock.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Set GPT-5.6 reasoning to None, Low, Medium, High, XHigh, or Max independently of the model.",
			),
		).toBeInTheDocument()
		expect(screen.getByText("Existing model defaults and saved selections stay in place.")).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.15 restores GPT-5.6 Sol, Terra, and Luna with their reasoning levels."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Choose your model and reasoning level separately without waiting for discovery."),
		).toBeInTheDocument()
	})
})
