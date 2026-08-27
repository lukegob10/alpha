import { SECRET_STATE_KEYS, GLOBAL_SECRET_KEYS, ProviderSettings } from "@alpha-code/types"

export function checkExistKey(config: ProviderSettings | undefined) {
	if (!config) {
		return false
	}

	// Special case for providers which don't need any configuration.
	if (config.apiProvider && ["fake-ai", "openai-codex", "qwen-code"].includes(config.apiProvider)) {
		return true
	}

	// Check all secret keys from the centralized SECRET_STATE_KEYS array.
	// Filter out keys that are not part of ProviderSettings (global secrets are stored separately)
	const providerSecretKeys = SECRET_STATE_KEYS.filter((key) => !GLOBAL_SECRET_KEYS.includes(key as any))
	const hasSecretKey = providerSecretKeys.some((key) => config[key as keyof ProviderSettings] !== undefined)

	// Check additional non-secret configuration properties
	const hasOtherConfig = [
		config.awsRegion,
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
		config.ollamaModelId,
		config.lmStudioModelId,
		config.vsCodeLmModelSelector,
	].some((value) => value !== undefined)

	return hasSecretKey || hasOtherConfig
}
