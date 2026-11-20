import { render, screen, fireEvent } from "@/utils/test-utils"

import { useCopyToClipboard } from "@/utils/clipboard"

import { CopyButton } from "../CopyButton"

vi.mock("@/utils/clipboard")
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("CopyButton", () => {
	const mockCopy = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useCopyToClipboard).mockReturnValue({
			showCopyFeedback: false,
			copyWithFeedback: mockCopy,
		})
	})

	it("copies task content when clicked", () => {
		render(<CopyButton itemTask="Test task content" />)

		const copyButton = screen.getByRole("button")
		fireEvent.click(copyButton)

		expect(mockCopy).toHaveBeenCalledWith("Test task content")
	})
})
