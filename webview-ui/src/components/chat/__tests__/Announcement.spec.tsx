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
		version: "3.1.0",
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

		expect(screen.getByText("Welcome to Alpha v3.1.0")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.1.0 brings a shared agent runtime and a clearer code review experience."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Use one provider-neutral TypeScript engine for model steps, tools, approvals, and delegated work.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Apply Ask, Auto, and Full Access policies consistently, including to child tasks."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Expand a completed turn's Worked for summary to inspect its full activity trace."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Review the whole turn or open per-file diffs in Alpha Diff, with added and removed line counts.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.1.0 brings a shared agent runtime and a clearer code review experience."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Use one provider-neutral TypeScript engine for model steps, tools, approvals, and delegated work.",
			),
		).toBeInTheDocument()
	})
})
