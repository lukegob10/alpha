import { useEffect, useRef, useState } from "react"
import type { ChatGptAuthStatus, ExtensionMessage } from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, SearchableSelect } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

type AccountState = Pick<ChatGptAuthStatus, "connected" | "connecting" | "email" | "accountId" | "accounts">
type AuthAction = "signIn" | "signOut" | "cancel" | "selectAccount"

/** Account authentication is host-owned; provider forms never receive or store its tokens. */
export const ChatGptAuth = () => {
	const { t } = useAppTranslation()
	const [status, setStatus] = useState<AccountState>({ connected: false, connecting: false })
	const [pending, setPending] = useState<AuthAction>()
	const [error, setError] = useState<string>()
	const pendingRef = useRef<AuthAction>()

	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "chatGptAuthStatus" && event.data.chatGptAuthStatus) {
				const next = event.data.chatGptAuthStatus
				setStatus({
					connected: next.connected,
					connecting: next.connecting,
					email: next.email,
					accountId: next.accountId,
					accounts: next.accounts?.map(({ id, email, connected }) => ({ id, email, connected })),
				})
				pendingRef.current = undefined
				setPending(undefined)
				if (next.connected) setError(undefined)
			} else if (event.data.type === "chatGptAuthError") {
				setError(event.data.text)
				setStatus((previous) => ({ ...previous, connecting: false }))
				pendingRef.current = undefined
				setPending(undefined)
			}
		}
		window.addEventListener("message", receive)
		vscode.postMessage({ type: "chatGptAuthStatus" })
		return () => window.removeEventListener("message", receive)
	}, [])

	const busy = status.connecting || pending !== undefined
	const connecting = status.connecting || pending === "signIn" || pending === "cancel"
	const startAction = (action: AuthAction, send: () => void) => {
		if (pendingRef.current || (status.connecting && action !== "cancel")) return
		pendingRef.current = action
		setPending(action)
		setError(undefined)
		send()
	}
	const accounts = status.accounts ?? []
	const accountLabel = status.email ?? status.accountId
	const shortAccountId = (id: string) => (id.length > 16 ? `${id.slice(0, 4)}…${id.slice(-8)}` : id)

	return (
		<div className="flex flex-col gap-2" data-testid="chatgpt-auth">
			<div className="text-sm text-vscode-descriptionForeground" role="status" aria-live="polite">
				{connecting
					? t("settings:providers.chatGpt.connecting")
					: status.connected
						? accountLabel
							? t("settings:providers.chatGpt.connectedAs", { account: accountLabel })
							: t("settings:providers.chatGpt.connected")
						: t("settings:providers.chatGpt.disconnected")}
			</div>
			{accounts.length > 0 && (
				<div className="flex flex-col gap-1">
					<label className="block font-medium">{t("settings:providers.chatGpt.account")}</label>
					<SearchableSelect
						value={status.accountId ?? ""}
						disabled={busy}
						options={accounts.map(({ id, email }) => ({
							value: id,
							label: email ? `${email} (${shortAccountId(id)})` : id,
						}))}
						onValueChange={(accountId) => {
							if (accountId === status.accountId) return
							startAction("selectAccount", () =>
								vscode.postMessage({ type: "chatGptSelectAccount", accountId }),
							)
						}}
						placeholder={t("settings:providers.chatGpt.selectAccount")}
						searchPlaceholder={t("settings:providers.chatGpt.searchAccounts")}
						emptyMessage={t("settings:providers.chatGpt.noAccounts")}
						aria-label={t("settings:providers.chatGpt.account")}
					/>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{status.connected ? (
					<Button
						type="button"
						variant="secondary"
						disabled={busy}
						onClick={() => startAction("signOut", () => vscode.postMessage({ type: "chatGptSignOut" }))}>
						{t("settings:providers.chatGpt.signOut")}
					</Button>
				) : (
					<Button
						type="button"
						disabled={busy}
						onClick={() =>
							startAction("signIn", () =>
								vscode.postMessage({ type: "chatGptSignIn", accountId: status.accountId }),
							)
						}>
						{t("settings:providers.chatGpt.signIn")}
					</Button>
				)}
				{connecting && (
					<Button
						type="button"
						variant="secondary"
						disabled={pending === "cancel"}
						onClick={() => {
							// Cancellation may supersede the pending sign-in action.
							if (pendingRef.current === "signIn") pendingRef.current = undefined
							startAction("cancel", () => vscode.postMessage({ type: "chatGptCancelSignIn" }))
						}}>
						{t("settings:providers.chatGpt.cancel")}
					</Button>
				)}
				{accounts.length > 0 && (
					<Button
						type="button"
						variant="secondary"
						disabled={busy}
						onClick={() =>
							startAction("signIn", () => vscode.postMessage({ type: "chatGptSignIn", newAccount: true }))
						}>
						{t("settings:providers.chatGpt.addAccount")}
					</Button>
				)}
			</div>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.chatGpt.description")}
			</div>
			{error && (
				<div role="alert" className="text-sm text-vscode-errorForeground">
					{error}
				</div>
			)}
		</div>
	)
}
