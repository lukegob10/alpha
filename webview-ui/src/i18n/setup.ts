import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// English is the complete locale surface; bundle only its namespaces.
const localeFiles = import.meta.glob<Record<string, unknown>>("./locales/en/*.json", {
	eager: true,
	import: "default",
})
const translations = Object.fromEntries(
	Object.entries(localeFiles).map(([path, resource]) => [path.slice(path.lastIndexOf("/") + 1, -5), resource]),
)

// Initialize i18next for React
// Resources are bundled eagerly so translations are available before React's first render.
i18next.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	supportedLngs: ["en"],
	resources: { en: translations },
	initAsync: false,
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export default i18next
