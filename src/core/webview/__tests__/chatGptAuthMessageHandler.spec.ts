import type { ExtensionMessage } from "@alpha-code/types"

const { auth, tryGetInstance } = vi.hoisted(() => {
	const auth = {
		getStatus: vi.fn(),
		signIn: vi.fn(),
		cancelSignIn: vi.fn(),
		signOut: vi.fn(),
		selectAccount: vi.fn(),
	}
	return { auth, tryGetInstance: vi.fn(() => auth) }
})
vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: { tryGetInstance },
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { handleChatGptAuthMessage } from "../chatGptAuthMessageHandler"

describe("ChatGPT account messages", () => {
	const status = { connected: false, connecting: false, accounts: [] }
	const view = { postMessageToWebview: vi.fn<(_: ExtensionMessage) => Promise<void>>() }
	beforeEach(() => {
		vi.clearAllMocks()
		tryGetInstance.mockReturnValue(auth)
		auth.getStatus.mockResolvedValue(status)
		auth.signIn.mockResolvedValue(status)
		auth.signOut.mockResolvedValue(undefined)
		auth.selectAccount.mockResolvedValue(status)
		view.postMessageToWebview.mockResolvedValue(undefined)
	})

	it("reads local public status without starting sign-in", async () => {
		await handleChatGptAuthMessage(view, { type: "chatGptAuthStatus" })
		expect(view.postMessageToWebview).toHaveBeenCalledWith({ type: "chatGptAuthStatus", chatGptAuthStatus: status })
		expect(auth.signIn).not.toHaveBeenCalled()
	})

	it("leaves the message queue available while browser authorization is pending", async () => {
		let finish!: () => void
		auth.signIn.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)))
		await handleChatGptAuthMessage(view, { type: "chatGptSignIn", newAccount: true })
		expect(auth.signIn).toHaveBeenCalledWith({ accountId: undefined, newAccount: true })
		await handleChatGptAuthMessage(view, { type: "chatGptCancelSignIn" })
		expect(auth.cancelSignIn).toHaveBeenCalledOnce()
		finish()
	})

	it.each([
		{ type: "chatGptSelectAccount", accountId: "" },
		{ type: "chatGptSelectAccount", accountId: 123 },
		{ type: "chatGptSignIn", accountId: "saved", newAccount: true },
		{ type: "chatGptSignIn", newAccount: "yes" },
	])("rejects malformed $type actions before reaching credentials", async (message) => {
		await handleChatGptAuthMessage(view, message)
		expect(tryGetInstance).not.toHaveBeenCalled()
		expect(view.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatGptAuthError",
			text: "common:chatGptAuth.invalidAction",
		})
	})

	it("selects a saved registration by its host-owned identity", async () => {
		await handleChatGptAuthMessage(view, { type: "chatGptSelectAccount", accountId: "saved-registration" })
		expect(auth.selectAccount).toHaveBeenCalledWith("saved-registration")
	})

	it("reports a failed account action without disclosing its credentials", async () => {
		auth.signOut.mockRejectedValueOnce(new Error("Authorization: Bearer private-refresh-token"))
		await handleChatGptAuthMessage(view, { type: "chatGptSignOut" })
		expect(view.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatGptAuthError",
			text: "common:chatGptAuth.failed",
		})
		expect(JSON.stringify(view.postMessageToWebview.mock.calls)).not.toContain("private-refresh-token")
	})

	it("does not publish an old view's account status after navigation", async () => {
		await handleChatGptAuthMessage(view, { type: "chatGptAuthStatus" }, () => false)
		expect(view.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("explains how to finish remote sign-out after local credentials have been cleared", async () => {
		auth.signOut.mockRejectedValueOnce(
			Object.assign(new Error("private details"), { code: "chatgpt_revocation_unconfirmed" }),
		)
		await handleChatGptAuthMessage(view, { type: "chatGptSignOut" })
		expect(view.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatGptAuthError",
			text: "common:chatGptAuth.revocationUnconfirmed",
		})
		expect(JSON.stringify(view.postMessageToWebview.mock.calls)).not.toContain("private details")
	})
})
