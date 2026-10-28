import { render, screen } from "@/utils/test-utils"

import AlphaHero from "../AlphaHero"

describe("AlphaHero", () => {
	afterEach(() => vi.unstubAllGlobals())

	it.each(["compact", "welcome"] as const)("pairs the wolf with lowercase alpha in the %s lockup", (variant) => {
		render(<AlphaHero variant={variant} />)

		expect(screen.getByText("alpha")).toBeInTheDocument()
		expect(screen.queryByText("Alpha Code")).not.toBeInTheDocument()
		expect(screen.getByTestId("alpha-wolf-icon")).toHaveAttribute("src", "/alpha-wolf-logo.svg")
		expect(screen.getByTestId("alpha-wolf-icon")).toHaveAttribute("alt", "")
	})

	it("keeps the new-task watermark decorative and free of a wordmark", () => {
		const { container } = render(<AlphaHero variant="watermark" />)

		expect(container.firstChild).toHaveAttribute("aria-hidden", "true")
		expect(screen.queryByText("alpha")).not.toBeInTheDocument()
		expect(screen.getByTestId("alpha-wolf-icon")).toHaveClass("brand-mark-watermark", "h-24", "w-24")
		expect(screen.queryByRole("img")).not.toBeInTheDocument()
	})

	it("loads the wolf from the host-provided image directory", () => {
		vi.stubGlobal("IMAGES_BASE_URI", "https://alpha-assets.test/images/")
		render(<AlphaHero />)

		expect(screen.getByTestId("alpha-wolf-icon")).toHaveAttribute(
			"src",
			"https://alpha-assets.test/images/alpha-wolf-logo.svg",
		)
	})
})
