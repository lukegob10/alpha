import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import PromptsSettings from "../PromptsSettings"

const { postMessage, extensionState } = vi.hoisted(() => ({
	postMessage: vi.fn(),
	extensionState: { currentTaskId: undefined as string | undefined },
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		listApiConfigMeta: [{ id: "config-1", name: "Config 1" }],
		...extensionState,
	}),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
	Select: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => {
		const isPersonality = value === "default" || value === "none"
		return (
			<select
				data-testid={
					isPersonality
						? "personality-control"
						: ["ENHANCE", "EXPLAIN"].includes(value)
							? "support-prompt-type"
							: "enhancement-api-config"
				}
				value={value}
				onChange={(event) => onValueChange(event.target.value)}>
				{isPersonality ? (
					<>
						<option value="default">Default</option>
						<option value="none">None</option>
					</>
				) : (
					<>
						<option value="ENHANCE">Enhance</option>
						<option value="EXPLAIN">Explain</option>
						<option value="-">Current configuration</option>
						<option value="config-1">Config 1</option>
					</>
				)}
			</select>
		)
	},
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectValue: () => null,
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeTextArea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../Section", () => ({
	Section: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("PromptsSettings buffering", () => {
	beforeEach(() => {
		postMessage.mockClear()
		extensionState.currentTaskId = undefined
	})

	const createProps = () => ({
		personality: "default" as const,
		setPersonality: vi.fn(),
		customSupportPrompts: { ENHANCE: "Buffered support prompt" },
		setCustomSupportPrompts: vi.fn(),
		includeTaskHistoryInEnhance: false,
		setIncludeTaskHistoryInEnhance: vi.fn(),
		enhancementApiConfigId: "config-1",
		setEnhancementApiConfigId: vi.fn(),
	})
	const startPreview = () => {
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "Keep my preview" } })
		fireEvent.click(screen.getByText("prompts:supportPrompts.enhance.previewButton"))
		return postMessage.mock.calls.filter(([message]) => message.type === "enhancePrompt").at(-1)![0]
	}
	const reply = (requestId: string, data: Record<string, string> = {}) => {
		act(() =>
			window.dispatchEvent(new MessageEvent("message", { data: { type: "enhancedPrompt", requestId, ...data } })),
		)
	}

	it("edits the supplied personality buffer without sending settings messages", () => {
		const props = createProps()
		const view = render(<PromptsSettings {...props} />)
		expect(screen.getByTestId("personality-control")).toHaveValue("default")
		fireEvent.change(screen.getByTestId("personality-control"), { target: { value: "none" } })
		expect(props.setPersonality).toHaveBeenCalledWith("none")
		expect(postMessage).not.toHaveBeenCalled()

		view.rerender(<PromptsSettings {...props} personality="none" />)
		expect(screen.getByTestId("personality-control")).toHaveValue("none")
		fireEvent.change(screen.getByTestId("personality-control"), { target: { value: "default" } })
		expect(props.setPersonality).toHaveBeenLastCalledWith("default")
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("cancels preview without editing settings or replacing the draft with a late result", () => {
		const props = createProps()
		render(<PromptsSettings {...props} />)
		const request = startPreview()
		fireEvent.click(screen.getByText("prompts:supportPrompts.enhance.cancelButton"))
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
		reply(request.requestId, { text: "Late preview" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
		expect(screen.getByText("prompts:supportPrompts.enhance.previewButton")).toBeEnabled()
		expect(props.setCustomSupportPrompts).not.toHaveBeenCalled()
		expect(props.setEnhancementApiConfigId).not.toHaveBeenCalled()
		expect(props.setIncludeTaskHistoryInEnhance).not.toHaveBeenCalled()
	})

	it("cancels once on Escape while keeping the preview draft", () => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
		fireEvent(screen.getByTestId("test-prompt-textarea"), escape)
		fireEvent.keyDown(screen.getByTestId("test-prompt-textarea"), { key: "Escape" })
		expect(escape.defaultPrevented).toBe(true)
		expect(postMessage.mock.calls.filter(([message]) => message.type === "cancelEnhancePrompt")).toEqual([
			[{ type: "cancelEnhancePrompt", requestId: request.requestId }],
		])
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
	})

	it("cancels a request when its preview draft is edited", () => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "Newer preview" } })
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
		reply(request.requestId, { text: "Late preview" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Newer preview")
	})

	it.each([
		{ enhancementApiConfigId: "" },
		{ includeTaskHistoryInEnhance: true },
		{ customSupportPrompts: { ENHANCE: "New buffered instructions" } },
	])("cancels when buffered enhancement options change: %j", (changed) => {
		const props = createProps()
		const view = render(<PromptsSettings {...props} />)
		const request = startPreview()
		view.rerender(<PromptsSettings {...props} {...changed} />)
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
		reply(request.requestId, { text: "Stale options" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
		expect(screen.getByText("prompts:supportPrompts.enhance.previewButton")).toBeEnabled()
	})

	it.each(["configuration", "history", "support"])("cancels synchronously on native %s edits", (control) => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		if (control === "configuration") {
			fireEvent.change(screen.getByTestId("enhancement-api-config"), { target: { value: "-" } })
		} else if (control === "history") {
			fireEvent.click(screen.getByRole("checkbox"))
		} else {
			fireEvent.input(screen.getAllByRole("textbox")[0], { target: { value: "New buffered instructions" } })
		}
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
		reply(request.requestId, { text: "Stale options" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
		expect(
			postMessage.mock.calls.every(([message]) =>
				["enhancePrompt", "cancelEnhancePrompt"].includes(message.type),
			),
		).toBe(true)
	})

	it("cancels the originating task request on navigation", () => {
		extensionState.currentTaskId = "task-a"
		const props = createProps()
		const view = render(<PromptsSettings {...props} />)
		const request = startPreview()
		extensionState.currentTaskId = "task-b"
		view.rerender(<PromptsSettings {...props} />)
		expect(postMessage).toHaveBeenCalledWith({
			type: "cancelEnhancePrompt",
			requestId: request.requestId,
			taskId: "task-a",
		})
		reply(request.requestId, { text: "Other task" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
	})

	it("cancels on unmount", () => {
		const view = render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		view.unmount()
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
	})

	it("cancels when leaving the enhancement section", () => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		fireEvent.change(screen.getByTestId("support-prompt-type"), { target: { value: "EXPLAIN" } })
		expect(postMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
	})

	it.each(["error", "cancelled"])("keeps %s diagnostic text out of the preview", (enhancementStatus) => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		reply(request.requestId, { enhancementStatus, text: "Diagnostic text" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
		expect(screen.getByText("prompts:supportPrompts.enhance.previewButton")).toBeEnabled()
	})

	it("keeps a retry pending when the cancelled request replies late", () => {
		render(<PromptsSettings {...createProps()} />)
		const request = startPreview()
		fireEvent.keyDown(screen.getByTestId("test-prompt-textarea"), { key: "Escape" })
		fireEvent.click(screen.getByText("prompts:supportPrompts.enhance.previewButton"))
		const retry = postMessage.mock.calls.filter(([message]) => message.type === "enhancePrompt").at(-1)![0]
		expect(retry.requestId).not.toBe(request.requestId)
		reply(request.requestId, { enhancementStatus: "cancelled" })
		reply(request.requestId, { text: "Late preview" })
		expect(screen.getByText("prompts:supportPrompts.enhance.previewButton")).toBeDisabled()
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
		reply(retry.requestId, { enhancementStatus: "success", text: "Improved retry" })
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Improved retry")
		expect(screen.getByText("prompts:supportPrompts.enhance.previewButton")).toBeEnabled()
	})

	it("keeps unrelated enhancement responses out of the buffered preview", () => {
		render(
			<PromptsSettings
				personality="default"
				setPersonality={vi.fn()}
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				includeTaskHistoryInEnhance={false}
				setIncludeTaskHistoryInEnhance={vi.fn()}
				setEnhancementApiConfigId={vi.fn()}
			/>,
		)
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "Keep my preview" } })
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "enhancedPrompt", requestId: "other-composer", text: "Foreign prompt" },
				}),
			)
		})
		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("Keep my preview")
	})

	it("buffers enhancement settings without persisting before Save", () => {
		const setIncludeTaskHistoryInEnhance = vi.fn()
		const setEnhancementApiConfigId = vi.fn()

		const props = {
			personality: "default" as const,
			setPersonality: vi.fn(),
			customSupportPrompts: {},
			setCustomSupportPrompts: vi.fn(),
			includeTaskHistoryInEnhance: true,
			setIncludeTaskHistoryInEnhance,
			enhancementApiConfigId: "config-1",
			setEnhancementApiConfigId,
		}
		const { rerender } = render(<PromptsSettings {...props} />)

		fireEvent.click(screen.getByRole("checkbox"))
		fireEvent.change(screen.getByTestId("enhancement-api-config"), { target: { value: "-" } })

		expect(setIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(false)
		expect(setEnhancementApiConfigId).toHaveBeenCalledWith("")
		expect(postMessage).not.toHaveBeenCalled()

		// SettingsView discards by restoring its original cached state. Controlled
		// inputs must therefore return to the original values without host writes.
		rerender(<PromptsSettings {...props} />)
		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByTestId("enhancement-api-config")).toHaveValue("config-1")
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("previews with the buffered enhancement settings without persisting them", () => {
		render(
			<PromptsSettings
				personality="default"
				setPersonality={vi.fn()}
				customSupportPrompts={{ ENHANCE: "Buffered support prompt: {{userInput}}" }}
				setCustomSupportPrompts={vi.fn()}
				includeTaskHistoryInEnhance={false}
				setIncludeTaskHistoryInEnhance={vi.fn()}
				enhancementApiConfigId="config-1"
				setEnhancementApiConfigId={vi.fn()}
			/>,
		)

		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "Preview me" } })
		fireEvent.click(screen.getByText("prompts:supportPrompts.enhance.previewButton"))

		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({
			type: "enhancePrompt",
			requestId: expect.any(String),
			text: "Preview me",
			enhancementOptions: {
				apiConfigId: "config-1",
				includeTaskHistory: false,
				supportPrompt: "Buffered support prompt: {{userInput}}",
			},
		})
	})

	it("accepts only the latest unchanged preview request and settles its own failure", () => {
		render(
			<PromptsSettings
				personality="default"
				setPersonality={vi.fn()}
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				includeTaskHistoryInEnhance={false}
				setIncludeTaskHistoryInEnhance={vi.fn()}
				setEnhancementApiConfigId={vi.fn()}
			/>,
		)
		const input = screen.getByTestId("test-prompt-textarea")
		const button = screen.getByText("prompts:supportPrompts.enhance.previewButton")
		fireEvent.change(input, { target: { value: "Original preview" } })
		fireEvent.click(button)
		const originalRequest = postMessage.mock.calls.at(-1)![0]
		fireEvent.change(input, { target: { value: "Updated preview" } })
		expect(button).not.toBeDisabled()
		fireEvent.click(button)
		const latestRequest = postMessage.mock.calls.at(-1)![0]
		expect(latestRequest.requestId).not.toBe(originalRequest.requestId)
		act(() => {
			for (const requestId of [originalRequest.requestId, undefined]) {
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "enhancedPrompt", requestId, text: "Stale preview" } }),
				)
			}
		})
		expect(input).toHaveValue("Updated preview")
		expect(button).toBeDisabled()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "enhancedPrompt", requestId: latestRequest.requestId } }),
			)
		})
		expect(input).toHaveValue("Updated preview")
		expect(button).not.toBeDisabled()
		fireEvent.click(button)
		const retry = postMessage.mock.calls.at(-1)![0]
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "enhancedPrompt", requestId: retry.requestId, text: "Improved preview" },
				}),
			)
		})
		expect(input).toHaveValue("Improved preview")
		expect(button).not.toBeDisabled()
	})
})
