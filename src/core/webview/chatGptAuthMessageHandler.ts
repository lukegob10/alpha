import { chatGptAuthActionSchema, type ExtensionMessage } from "@alpha-code/types"

import { ChatGptAuthService } from "../../services/chatgpt/ChatGptAuthService"
import { t } from "../../i18n"

type AuthView = {
	postMessageToWebview(message: ExtensionMessage): Promise<void>
}

/** Browser sign-in belongs to the host service, so it never holds the settings message queue. */
export async function handleChatGptAuthMessage(
	view: AuthView,
	message: unknown,
	isCurrentWebview = () => true,
): Promise<void> {
	const post = async (response: ExtensionMessage) => {
		if (isCurrentWebview()) await view.postMessageToWebview(response)
	}
	const parsed = chatGptAuthActionSchema.safeParse(message)
	if (!parsed.success) {
		await post({ type: "chatGptAuthError", text: t("common:chatGptAuth.invalidAction") })
		return
	}
	const auth = ChatGptAuthService.tryGetInstance()
	if (!auth) {
		await post({ type: "chatGptAuthError", text: t("common:chatGptAuth.unavailable") })
		return
	}
	const publish = async () => post({ type: "chatGptAuthStatus", chatGptAuthStatus: await auth.getStatus() })
	const reportFailure = async (error: unknown) => {
		// OAuth failures can contain authorization codes or tokens. Only host-owned text crosses IPC.
		if (!(error instanceof Error && error.name === "AbortError")) {
			const unconfirmed =
				error instanceof Error && "code" in error && error.code === "chatgpt_revocation_unconfirmed"
			await post({
				type: "chatGptAuthError",
				text: t(unconfirmed ? "common:chatGptAuth.revocationUnconfirmed" : "common:chatGptAuth.failed"),
			})
		}
		await publish()
	}
	try {
		const action = parsed.data
		switch (action.type) {
			case "chatGptSignIn":
				// The service owns cancellation and shutdown for this bounded browser operation.
				void auth
					.signIn({ accountId: action.accountId, newAccount: action.newAccount })
					.then(publish, reportFailure)
					.catch(() => undefined)
				break
			case "chatGptCancelSignIn":
				auth.cancelSignIn()
				break
			case "chatGptSignOut":
				await auth.signOut()
				break
			case "chatGptSelectAccount":
				await auth.selectAccount(action.accountId)
				break
			case "chatGptAuthStatus":
				break
		}
		await publish()
	} catch (error) {
		await reportFailure(error)
	}
}
