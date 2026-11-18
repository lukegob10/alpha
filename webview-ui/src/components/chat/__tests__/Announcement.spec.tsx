import React from "react"

import { Package } from "@alpha/package"

import { render, screen } from "@/utils/test-utils"
import { TranslationContext } from "@src/i18n/TranslationContext"
import i18n from "@src/i18n/setup"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
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
	const description =
		"Use Steer to redirect a running task between tool calls. GPT and Claude can now find definitions and references in your workspace. Claude Haiku 5.5 on GitHub Copilot can make targeted edits."

	it("renders the current release announcement", () => {
		renderAnnouncement()
		expect(
			screen.getByRole("dialog", { name: `Welcome to Alpha v${Package.version}` }),
		).toHaveAccessibleDescription(description)
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(screen.getByRole("dialog")).toHaveAccessibleDescription(description)
	})
})
