import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Mention } from "../Mention"
import { vscode } from "../../../utils/vscode"

vi.mock("../../../utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
afterEach(() => vi.clearAllMocks())

describe("ticket mention aliases", () => {
	it.each(["ticket:PM-01", "tickets:PM-01", "PM-01"])("opens the clickable %s mention", (mention) => {
		render(<Mention text={`Work on @${mention}.`} />)
		fireEvent.click(screen.getByRole("button", { name: `@${mention}` }))
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "openMention", text: mention })
	})
})
