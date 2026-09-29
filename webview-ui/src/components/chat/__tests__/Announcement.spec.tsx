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
		version: "3.1.2",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.1.2" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.1.2")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.1.2 keeps delegated work visible, prevents search loops, and makes active traces easier to follow.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Open only managed-agent tasks that actually launched, with accurate terminal reasons when startup fails.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Recover from repeated search-only steps by consolidating evidence and taking a concrete next action.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("See a subtle pulse on folded command and edit traces while work is still running."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Use Codex-aligned Plan tools, command outcomes, prompts, and turn sequencing."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.1.2 keeps delegated work visible, prevents search loops, and makes active traces easier to follow.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Open only managed-agent tasks that actually launched, with accurate terminal reasons when startup fails.",
			),
		).toBeInTheDocument()
	})
})
