import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// Dynamically load locale files
const localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json/)

	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		translations[language][namespace] = (module as any).default || module
	}
})

// Initialize i18next for React
// Resources are bundled eagerly so translations are available before React's first render.
i18next.use(initReactI18next).init({
	lng: "en", // Default language (will be overridden)
	fallbackLng: "en",
	resources: translations,
	initAsync: false,
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export default i18next
