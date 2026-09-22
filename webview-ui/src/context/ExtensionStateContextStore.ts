import { createContext } from "react"

import type { ExtensionStateContextType } from "./ExtensionStateContext"

// Keep the context identity outside the refreshable provider/hook module. Its
// runtime dependencies can reload while memoized consumers retain the old hook.
export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

// Composer and finished-row chrome subscribe here so stream/transcript ticks do
// not re-render the input or mounted command/error widgets.
export const ShellStateContext = createContext<ExtensionStateContextType | undefined>(undefined)
