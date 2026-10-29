import { createContext } from "react"

import type { ExtensionState } from "@alpha-code/types"

import type { ExtensionStateContextType } from "./ExtensionStateContext"

// Keep the context identity outside the refreshable provider/hook module. Its
// runtime dependencies can reload while memoized consumers retain the old hook.
export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

// Composer and finished-row chrome subscribe here so stream/transcript ticks do
// not re-render the input or mounted command/error widgets.
export const ShellStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

/** Reuse only an unchanged projection, after its merge and cache bookkeeping finish. */
export function retainUnchangedExtensionState(previous: ExtensionState, next: ExtensionState): ExtensionState {
	if (previous === next) return previous

	const previousKeys = Object.keys(previous) as (keyof ExtensionState)[]
	if (previousKeys.length !== Object.keys(next).length) return next

	return previousKeys.every((key) => Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
		? previous
		: next
}
