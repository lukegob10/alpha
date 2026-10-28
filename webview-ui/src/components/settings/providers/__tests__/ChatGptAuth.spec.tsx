import type { ComponentProps, PropsWithChildren } from "react"
import type { ChatGptAuthStatus, ExtensionMessage } from "@alpha-code/types"

import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { ChatGptAuth } from "../ChatGptAuth"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: { account?: string }) => (values?.account ? `${key}: ${values.account}` : key),
	}),
}))
vi.mock("@src/components/ui", () => ({
	Button: ({
		children,
		variant: _variant,
		...props
	}: PropsWithChildren<ComponentProps<"button"> & { variant?: string }>) => <button {...props}>{children}</button>,
	SearchableSelect: ({
		value,
		onValueChange,
		options,
		disabled,
		...props
	}: {
		value: string
		onValueChange: (value: string) => void
		options: Array<{ value: string; label: string }>
		disabled?: boolean
		"aria-label": string
	}) => (
		<select
			aria-label={props["aria-label"]}
			value={value}
			disabled={disabled}
			onChange={(event) => onValueChange(event.target.value)}>
			{options.map(({ value, label }) => (
				<option key={value} value={value}>
					{label}
				</option>
			))}
		</select>
	),
}))

function publish(status: ChatGptAuthStatus) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent<ExtensionMessage>("message", {
				data: { type: "chatGptAuthStatus", chatGptAuthStatus: status },
			}),
		),
	)
}

describe("ChatGPT account controls", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests only public account status on mount and has no token or API-key input", () => {
		render(<ChatGptAuth />)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "chatGptAuthStatus" })
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:providers.chatGpt.signIn" })).toBeEnabled()
	})

	it("prevents duplicate sign-in and supports cancelling the pending sign-in", () => {
		render(<ChatGptAuth />)
		const signIn = screen.getByRole("button", { name: "settings:providers.chatGpt.signIn" })
		fireEvent.click(signIn)
		fireEvent.click(signIn)

		expect(
			vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "chatGptSignIn"),
		).toHaveLength(1)
		const cancel = screen.getByRole("button", { name: "settings:providers.chatGpt.cancel" })
		fireEvent.click(cancel)
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "chatGptCancelSignIn" })
		expect(cancel).toBeDisabled()
		publish({ connected: false, connecting: false })
		expect(screen.getByRole("button", { name: "settings:providers.chatGpt.signIn" })).toBeEnabled()
	})

	it("shows the active account and allows sign-out without model discovery", () => {
		render(<ChatGptAuth />)
		publish({ connected: true, connecting: false, email: "person@example.com", availableModelIds: [] })

		expect(screen.getByRole("status")).toHaveTextContent("person@example.com")
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.chatGpt.signOut" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "chatGptSignOut" })
		expect(screen.getByRole("button", { name: "settings:providers.chatGpt.signOut" })).toBeDisabled()
	})

	it("distinguishes saved accounts and switches using account IDs", () => {
		render(<ChatGptAuth />)
		publish({
			connected: true,
			connecting: false,
			accountId: "account-one",
			accounts: [
				{ id: "account-one", email: "same@example.com", connected: true },
				{ id: "account-two", email: "same@example.com", connected: false },
			],
		})
		const picker = screen.getByRole("combobox", { name: "settings:providers.chatGpt.account" })
		const labels = Array.from(picker.querySelectorAll("option"), (option) => option.textContent)
		expect(new Set(labels).size).toBe(2)
		fireEvent.change(picker, { target: { value: "account-two" } })
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "chatGptSelectAccount",
			accountId: "account-two",
		})
		expect(picker).toBeDisabled()
	})

	it("adds an account without changing saved profile settings", () => {
		render(<ChatGptAuth />)
		publish({
			connected: true,
			connecting: false,
			accountId: "saved",
			accounts: [{ id: "saved", connected: true }],
		})
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.chatGpt.addAccount" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "chatGptSignIn", newAccount: true })
	})

	it("recovers the controls after a host authentication error", () => {
		render(<ChatGptAuth />)
		publish({ connected: false, connecting: true })
		act(() =>
			window.dispatchEvent(
				new MessageEvent<ExtensionMessage>("message", {
					data: { type: "chatGptAuthError", text: "Could not sign in" },
				}),
			),
		)

		expect(screen.getByRole("alert")).toHaveTextContent("Could not sign in")
		expect(screen.getByRole("button", { name: "settings:providers.chatGpt.signIn" })).toBeEnabled()
	})

	it("removes the account listener when the controls unmount", () => {
		const remove = vi.spyOn(window, "removeEventListener")
		const view = render(<ChatGptAuth />)
		view.unmount()
		expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
		remove.mockRestore()
	})
})
