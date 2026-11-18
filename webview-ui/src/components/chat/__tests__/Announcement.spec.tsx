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
		"To review a backlog, enter “$builtin:alpha-tickets check these tickets against the spec” in chat. Use Plan or Code for the review and Code to save changes."

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
