import type { ProviderName, ModelInfo } from "@alpha-code/types"

export const filterProviders = (
	providers: Array<{ value: string; label: string }>,
	_organizationAllowList?: unknown,
): Array<{ value: string; label: string }> => {
	return providers
}

export const filterModels = (
	models: Record<string, ModelInfo> | null,
	_providerId?: ProviderName,
	_organizationAllowList?: unknown,
): Record<string, ModelInfo> | null => {
	return models
}
