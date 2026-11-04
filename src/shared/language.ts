import { type Language, languagesSchema } from "@alpha-code/types"

export const LANGUAGES: Record<Language, string> = { en: "English" }

/** Alpha ships English only; normalize editor locales and retired saved choices at the boundary. */
export function formatLanguage(vscodeLocale: string | undefined): Language {
	return languagesSchema.parse(vscodeLocale)
}
