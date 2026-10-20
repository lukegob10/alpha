import { PROVIDER_SETTINGS_KEYS } from "@alpha-code/types"

import { t } from "../../i18n"
import { ProviderProfileUnavailableError } from "../config/ProviderSettingsManager"

const knownFieldNames = new Set<string>([...PROVIDER_SETTINGS_KEYS, "id", "configuration"])

/** Availability diagnostics carry field names, never values or arbitrary serialized errors. */
export function getProviderProfileUnavailableMessage(error: ProviderProfileUnavailableError): string {
	if (error.code === "unsupported") return t("common:errors.unsupported_provider_profile")
	const fields = [
		...new Set(error.invalidFields.map((field) => (knownFieldNames.has(field) ? field : "configuration"))),
	].slice(0, 10)
	return t("common:errors.invalid_provider_profile", { fields: fields.length ? `: ${fields.join(", ")}` : "" })
}
