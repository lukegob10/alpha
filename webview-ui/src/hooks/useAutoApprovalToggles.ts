import { useMemo } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"

/**
 * Custom hook that creates and returns the auto-approval toggles object
 * This encapsulates the logic for creating the toggles object from extension state
 */
export function useAutoApprovalToggles() {
	const {
		alwaysAllowReadOnly,
		alwaysAllowWrite,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowSubagents,
		alwaysAllowTickets = false,
		alwaysAllowFollowupQuestions,
	} = useExtensionState()

	const toggles = useMemo(
		() => ({
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowSubagents,
			alwaysAllowTickets,
			alwaysAllowFollowupQuestions,
		}),
		[
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowSubagents,
			alwaysAllowTickets,
			alwaysAllowFollowupQuestions,
		],
	)

	return toggles
}
