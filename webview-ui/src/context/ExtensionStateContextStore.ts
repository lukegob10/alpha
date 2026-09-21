import { createContext } from "react"

import type { ExtensionStateContextType } from "./ExtensionStateContext"

// Keep the context identity outside the refreshable provider/hook module. Its
// runtime dependencies can reload while memoized consumers retain the old hook.
export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)
