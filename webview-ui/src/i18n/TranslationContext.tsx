import React, { createContext, useContext, ReactNode, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import i18next from "./setup"
import { useShellState } from "@/context/ExtensionStateContext"
import { formatLanguage } from "@alpha/language"

// Create context for translations
export const TranslationContext = createContext<{
	t: (key: string, options?: Record<string, any>) => string
	i18n: typeof i18next
}>({
	// Detached consumers must still resolve the eagerly bundled locale resources.
	t: (key, options) => i18next.t(key, options),
	i18n: i18next,
})

// Translation provider component
export const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Initialize with default configuration
	const { t, i18n } = useTranslation()
	const { language } = useShellState()

	useEffect(() => {
		i18n.changeLanguage(formatLanguage(language))
	}, [i18n, language])

	// Memoize the translation function to prevent unnecessary re-renders
	const translate = useCallback(
		(key: string, options?: Record<string, any>) => {
			return t(key, options)
		},
		[t],
	)
	// The hook replaces t on languageChanged even when the i18n instance stays the same.
	const contextValue = useMemo(() => ({ t: translate, i18n }), [translate, i18n])

	return <TranslationContext.Provider value={contextValue}>{children}</TranslationContext.Provider>
}

// Custom hook for easy translations
export const useAppTranslation = () => useContext(TranslationContext)

export default TranslationProvider
