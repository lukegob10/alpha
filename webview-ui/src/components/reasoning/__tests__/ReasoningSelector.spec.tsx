import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"

import type { ComponentProps } from "react"
import { useState } from "react"
import type { TaskReasoningPreference, TaskReasoningProjection } from "@alpha-code/types"

import { ReasoningSelector } from "../ReasoningSelector"

vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			if (key === "chat:reasoning.label") return `Reasoning: ${String(options?.value ?? "")}`
			if (key === "chat:reasoning.budget") return `Budget: ${String(options?.tokens ?? "")} tokens`
			if (key === "chat:reasoning.fallback") {
				return `Requested ${String(options?.requested ?? "")} but using ${String(options?.effective ?? "")}`
			}
			if (key === "chat:reasoning.current") return `Current: ${String(options?.value ?? "")}`
			if (key.startsWith("settings:providers.reasoningEffort.")) {
				return key
					.split(".")
					.at(-1)!
					.replace(/^./, (character) => character.toUpperCase())
			}
			const labels: Record<string, string> = {
				"chat:reasoning.default": "Default",
				"chat:reasoning.off": "Off",
				"chat:reasoning.on": "On",
				"chat:reasoning.none": "None",
				"chat:reasoning.loading": "Loading",
				"chat:reasoning.unavailable": "Unavailable",
				"chat:reasoning.nextStep": "next step",
				"chat:reasoning.title": "Reasoning",
				"chat:reasoning.help": "Choose how much reasoning to use.",
				"chat:reasoning.unavailableHelp": "Reasoning is unavailable.",
				"chat:reasoning.reasons.unsupported": "Unsupported",
				"chat:reasoning.advanced": "Advanced",
				"chat:reasoning.custom": "Custom reasoning token",
				"chat:reasoning.customHelp": "Use a provider token.",
				"chat:reasoning.invalidCustom": "Invalid custom token",
				"chat:reasoning.apply": "Apply",
				"chat:reasoning.saving": "Saving",
				"chat:reasoning.saveFailed": "Save failed",
			}
			return labels[key] ?? key
		},
	}),
}))

const effortState = (overrides: Partial<TaskReasoningProjection> = {}): TaskReasoningProjection => ({
	taskId: "task-1",
	requested: { kind: "effort", effort: "medium" },
	effective: { kind: "effort", effort: "medium" },
	capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
	...overrides,
})

const renderSelector = (
	state: TaskReasoningProjection | undefined,
	props: Partial<ComponentProps<typeof ReasoningSelector>> = {},
) =>
	render(
		<ReasoningSelector
			state={state}
			scopeKey={props.scopeKey ?? "task-1/profile-a"}
			onChange={props.onChange ?? vi.fn()}
			loading={props.loading}
			saving={props.saving}
			error={props.error}
			onOpenAdvanced={props.onOpenAdvanced}
		/>,
	)

describe("ReasoningSelector", () => {
	it("shows only the level while retaining a descriptive accessible name", () => {
		renderSelector(effortState())

		const trigger = screen.getByRole("button", { name: "Reasoning: Medium" })
		expect(trigger).toHaveTextContent(/^Medium$/)
		expect(trigger).toHaveAttribute("title", "Reasoning: Medium")
	})

	it("shows a compact effort slider and reports a selected preference", () => {
		const onChange = vi.fn()
		renderSelector(effortState(), { onChange })

		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		expect(screen.queryAllByRole("radio")).toHaveLength(0)
		expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuenow", "1")
		expect(screen.getByTestId("reasoning-effort-slider-panel").textContent).toBe("Medium")
		expect(screen.queryByRole("button", { name: "Default" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Off" })).not.toBeInTheDocument()

		fireEvent.keyDown(screen.getByRole("slider", { name: "Reasoning" }), { key: "End" })

		expect(onChange).toHaveBeenCalledWith({ kind: "effort", effort: "high" })
		expect(screen.queryByRole("slider", { name: "Reasoning" })).not.toBeInTheDocument()
	})

	it("keeps the effort slider limited to provider levels", () => {
		renderSelector(
			effortState({
				capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: false },
			}),
		)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		expect(screen.getByRole("slider", { name: "Reasoning" })).toBeInTheDocument()
		expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuemax", "1")
		expect(screen.queryByRole("button", { name: "Default" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Off" })).not.toBeInTheDocument()
	})

	it("keeps long provider effort lists on the slider without listing every level", () => {
		renderSelector(
			effortState({
				effective: { kind: "effort", effort: "high" },
				requested: { kind: "effort", effort: "high" },
				capabilities: {
					kind: "effort",
					efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
					canDisable: true,
				},
			}),
		)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuemax", "6")
		expect(screen.getByTestId("reasoning-effort-slider-panel").textContent).toBe("High")
		expect(screen.queryByText("None")).not.toBeInTheDocument()
		expect(screen.queryByText("Max")).not.toBeInTheDocument()
		expect(screen.queryByText("Minimal")).not.toBeInTheDocument()
		expect(screen.queryByText("Xhigh")).not.toBeInTheDocument()
	})

	it("offers only Default, Off, and On for binary capabilities", async () => {
		const onChange = vi.fn()
		function ControlledBinarySelector() {
			const [selection, setSelection] = useState<TaskReasoningPreference>({ kind: "on" })
			return (
				<ReasoningSelector
					state={{
						...effortState(),
						capabilities: { kind: "binary", canDisable: true },
						requested: selection,
						effective: selection,
					}}
					scopeKey="task-1/profile-a"
					onChange={(preference) => {
						onChange(preference)
						setSelection(preference)
					}}
				/>
			)
		}
		render(<ControlledBinarySelector />)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		expect(screen.queryAllByRole("radio")).toHaveLength(0)
		expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Off" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument()
		expect(screen.queryByRole("slider", { name: "Reasoning" })).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Default" }))
		expect(onChange).toHaveBeenLastCalledWith({ kind: "default" })
		await waitFor(() => expect(screen.getByTestId("reasoning-trigger")).toHaveAttribute("aria-expanded", "false"))
		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		fireEvent.click(screen.getByRole("button", { name: "Off" }))
		expect(onChange).toHaveBeenLastCalledWith({ kind: "off" })
		await waitFor(() => expect(screen.getByTestId("reasoning-trigger")).toHaveAttribute("aria-expanded", "false"))
		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		fireEvent.click(screen.getByRole("button", { name: "On" }))
		expect(onChange).toHaveBeenLastCalledWith({ kind: "on" })
		expect(onChange).toHaveBeenCalledTimes(3)
	})

	it("keeps the provider None level on the effort slider", async () => {
		const onChange = vi.fn()
		function ControlledNoneSelector() {
			const [selection, setSelection] = useState<TaskReasoningPreference>({ kind: "effort", effort: "none" })
			return (
				<ReasoningSelector
					state={{
						...effortState(),
						requested: selection,
						effective: selection,
						capabilities: { kind: "effort", efforts: ["none", "low"], canDisable: true },
					}}
					scopeKey="task-1/profile-a"
					onChange={(preference) => {
						onChange(preference)
						setSelection(preference)
					}}
				/>
			)
		}
		render(<ControlledNoneSelector />)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuenow", "0")
		expect(screen.getByTestId("reasoning-effort-slider-panel").textContent).toBe("None")
		expect(screen.queryByRole("button", { name: "Default" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Off" })).not.toBeInTheDocument()

		fireEvent.keyDown(screen.getByRole("slider", { name: "Reasoning" }), { key: "ArrowRight" })
		expect(onChange).toHaveBeenLastCalledWith({ kind: "effort", effort: "low" })
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("renders budget providers with only Default, Off, On, tokens, and Advanced", () => {
		const onOpenAdvanced = vi.fn()
		renderSelector(
			{
				...effortState(),
				capabilities: { kind: "budget", canDisable: true, budgetTokens: 4096 },
				effective: { kind: "on" },
				requested: { kind: "on" },
			},
			{ onOpenAdvanced },
		)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		expect(screen.queryAllByRole("radio")).toHaveLength(0)
		expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Off" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument()
		expect(screen.queryByRole("slider", { name: "Reasoning" })).not.toBeInTheDocument()
		expect(screen.getByText("Budget: 4,096 tokens")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Advanced" }))
		expect(onOpenAdvanced).toHaveBeenCalledTimes(1)
	})

	it("keeps an unavailable provider on Default and explains the capability", () => {
		renderSelector(
			{
				...effortState(),
				capabilities: { kind: "unavailable", canDisable: false },
				requested: { kind: "default" },
				effective: { kind: "default" },
				fallbackReason: "unavailable",
			},
			{ scopeKey: "task-1/unknown" },
		)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Off" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "On" })).not.toBeInTheDocument()
		expect(screen.queryByRole("slider", { name: "Reasoning" })).not.toBeInTheDocument()
		expect(screen.getByText("Reasoning is unavailable.")).toBeInTheDocument()
		expect(screen.getByText(/Requested Default but using Default/)).toBeInTheDocument()
	})

	it("shows pending current state and fallback details", () => {
		renderSelector({
			...effortState({
				requested: { kind: "effort", effort: "high" },
				effective: { kind: "effort", effort: "low" },
				fallbackReason: "unsupported",
			}),
			pending: true,
			current: {
				requested: { kind: "effort", effort: "medium" },
				effective: { kind: "effort", effort: "medium" },
				capabilities: { kind: "effort", efforts: ["low", "medium"], canDisable: true },
			},
		})

		expect(screen.getByTestId("reasoning-trigger")).toHaveTextContent("next step")
		fireEvent.click(screen.getByTestId("reasoning-trigger"))

		const fallback = screen.getByText(/Requested High but using Low/)
		expect(fallback).toHaveTextContent("Unsupported")
		expect(screen.getByText("Current: Medium")).toBeInTheDocument()
	})

	it("applies valid custom tokens and rejects invalid ones", () => {
		const onChange = vi.fn()
		const state = effortState({
			requested: { kind: "custom", value: "balanced" },
			effective: { kind: "custom", value: "balanced" },
			capabilities: { kind: "custom", canDisable: true },
		})
		renderSelector(state, { onChange })

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		const input = screen.getByLabelText("Custom reasoning token")
		expect(input).toHaveValue("balanced")
		fireEvent.change(input, { target: { value: "deliberate_v2" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(onChange).toHaveBeenCalledWith({ kind: "custom", value: "deliberate_v2" })

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		fireEvent.change(screen.getByLabelText("Custom reasoning token"), { target: { value: "bad token" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(onChange).toHaveBeenLastCalledWith({ kind: "off" })
		expect(screen.getByRole("alert")).toHaveTextContent("Invalid custom token")
	})

	it("does not emit an empty custom token", () => {
		const onChange = vi.fn()
		renderSelector(
			{
				...effortState(),
				requested: { kind: "custom", value: "balanced" },
				effective: { kind: "custom", value: "balanced" },
				capabilities: { kind: "custom", canDisable: true },
			},
			{ onChange },
		)

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		fireEvent.change(screen.getByLabelText("Custom reasoning token"), { target: { value: "" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(onChange).toHaveBeenCalledWith({ kind: "off" })
		expect(onChange).not.toHaveBeenCalledWith({ kind: "custom", value: "" })
	})

	it("preserves a custom token being edited across a same-scope state refresh", () => {
		const onChange = vi.fn()
		const state = {
			...effortState(),
			requested: { kind: "custom", value: "balanced" } as const,
			effective: { kind: "custom", value: "balanced" } as const,
			capabilities: { kind: "custom" as const, canDisable: true },
		}
		const { rerender } = renderSelector(state, { onChange })

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		const input = screen.getByLabelText("Custom reasoning token")
		fireEvent.change(input, { target: { value: "draft-token" } })

		rerender(
			<ReasoningSelector
				state={{ ...state, effective: { kind: "custom", value: "draft-token" } }}
				scopeKey="task-1/profile-a"
				onChange={onChange}
			/>,
		)

		expect(screen.getByLabelText("Custom reasoning token")).toHaveValue("draft-token")
	})

	it("reports loading, saving, and errors and closes when scope changes", async () => {
		const onChange = vi.fn()
		const { rerender } = renderSelector(effortState(), { onChange, saving: true, error: true })

		expect(screen.getByTestId("reasoning-trigger")).toHaveAttribute("aria-busy", "true")
		expect(screen.getByRole("status")).toHaveTextContent("Saving")
		expect(screen.getByRole("alert")).toHaveTextContent("Save failed")

		fireEvent.click(screen.getByTestId("reasoning-trigger"))
		expect(screen.getByRole("slider", { name: "Reasoning" })).toBeInTheDocument()

		rerender(
			<ReasoningSelector
				state={effortState({ taskId: "task-2" })}
				scopeKey="task-2/profile-b"
				onChange={onChange}
			/>,
		)

		await waitFor(() => expect(screen.queryByRole("slider", { name: "Reasoning" })).not.toBeInTheDocument())
	})

	it("disables the trigger while loading and exposes only the loading label", () => {
		renderSelector(undefined, { loading: true })

		expect(screen.getByTestId("reasoning-trigger")).toBeDisabled()
		expect(screen.getByTestId("reasoning-trigger")).toHaveAccessibleName("Reasoning: Loading")
	})

	it("supports keyboard open, selection, Escape, and focus restoration", async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		const focus = vi.fn()
		let activeElement: Element = document.body
		const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement")
		const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
		Object.defineProperty(document, "activeElement", {
			configurable: true,
			get: () => activeElement,
		})
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			get: function (this: HTMLElement) {
				return () => {
					focus.call(this)
					activeElement = focus.mock.contexts.at(-1) as Element
				}
			},
		})

		try {
			renderSelector(effortState(), { onChange })

			const trigger = screen.getByTestId("reasoning-trigger")
			trigger.focus()
			expect(trigger).toHaveFocus()
			await user.keyboard("{Enter}")

			expect(screen.getByRole("dialog", { name: "Reasoning" })).toBeInTheDocument()
			expect(screen.getByRole("slider", { name: "Reasoning" })).toHaveAttribute("aria-valuenow", "1")

			const slider = screen.getByRole("slider", { name: "Reasoning" })
			slider.focus()
			await user.keyboard("{End}")
			expect(onChange).toHaveBeenCalledWith({ kind: "effort", effort: "high" })
			await waitFor(() => {
				expect(screen.queryByRole("dialog", { name: "Reasoning" })).not.toBeInTheDocument()
				expect(focus).toHaveBeenCalledWith()
				expect(focus.mock.contexts.at(-1)).toBe(trigger)
				expect(trigger).toHaveFocus()
			})

			trigger.focus()
			await user.keyboard("{Enter}")
			await user.keyboard("{Escape}")
			await waitFor(() => {
				expect(screen.queryByRole("dialog", { name: "Reasoning" })).not.toBeInTheDocument()
				expect(focus.mock.contexts.at(-1)).toBe(trigger)
				expect(trigger).toHaveFocus()
			})
		} finally {
			if (activeElementDescriptor) {
				Object.defineProperty(document, "activeElement", activeElementDescriptor)
			} else {
				Reflect.deleteProperty(document, "activeElement")
			}
			if (focusDescriptor) {
				Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor)
			}
		}
	})
})
