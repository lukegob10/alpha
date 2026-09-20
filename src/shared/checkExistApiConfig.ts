import { SECRET_STATE_KEYS, ProviderSettings, isFauxProvider, isProviderName } from "@alpha-code/types"

export function checkExistKey(config: ProviderSettings | undefined) {
	if (!config) {
		return false
	}

	// fake-ai is an internal deterministic harness seam and needs no settings.
	if (config.apiProvider && isFauxProvider(config.apiProvider)) {
		return true
	}

	if (!config.apiProvider || !isProviderName(config.apiProvider)) {
		return false
	}

	// Check all secret keys from the centralized SECRET_STATE_KEYS array.
	const providerSecretKeys = SECRET_STATE_KEYS
	const hasSecretKey = providerSecretKeys.some((key) => config[key as keyof ProviderSettings] !== undefined)

	// Check additional non-secret configuration properties
	const hasOtherConfig = [
		config.vertexJsonCredentials,
		config.vertexKeyFile,
		config.vertexProjectId,
		config.projectId,
		config.location,
		config.gatewayBaseUrl,
		config.pemCaBundlePath,
		config.helixCommand,
		config.vertexGatewayBaseUrl,
		config.vertexGatewayCaBundlePath,
		config.vertexGatewayHelixCommand,
		config.stellarBaseUrl,
		config.stellarPemCaBundlePath,
		config.stellarHelixCommand,
		config.vsCodeLmModelSelector,
		config.openAiBaseUrl,
		config.openAiApiKey,
		config.openAiModelId,
	].some((value) => value !== undefined)

	return hasSecretKey || hasOtherConfig
}
