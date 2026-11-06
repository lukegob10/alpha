import * as vscode from "vscode"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { buildApiHandler } from "../../api"

import { SYSTEM_PROMPT_FRAGMENTS, renderSystemPromptFragments } from "../prompts/system"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { Package } from "../../shared/package"
import { TaskMemoryContext } from "../../services/memory/TaskMemoryContext"
import { captureProjectInstructionDiscoveryOptions } from "../../services/config-paths/project-instruction-settings"

import { AlphaProvider } from "./AlphaProvider"

export const generateSystemPrompt = async (provider: AlphaProvider, message: WebviewMessage) => {
	const {
		apiConfiguration,
		customModePrompts,
		customInstructions,
		mcpEnabled,
		experiments,
		language,
		enableSubfolderRules,
	} = await provider.getState()

	const diffStrategy = new MultiSearchReplaceDiffStrategy()

	const cwd = provider.cwd

	const mode = message.mode ?? defaultModeSlug
	const customModes = await provider.customModesManager.getCustomModes()

	const currentTask = provider.getCurrentTask()
	const alphaIgnoreInstructions = currentTask?.alphaIgnoreController?.getInstructions()
	const memoryContext = currentTask
		? await currentTask.getMemoryContext?.()
		: await new TaskMemoryContext({
				settings: provider.getMemorySettings?.(),
				rootPath: provider.getMemoryStore?.().rootPath ?? "",
				readSummary: async () => provider.getMemoryStore?.().readSummary(),
			}).getContext()

	// Resolve model metadata and ID for the preview without relying on an active Alpha instance.
	let modelInfo: { isStealthModel?: boolean } | undefined
	let modelId: string | undefined
	try {
		const tempApiHandler = buildApiHandler(apiConfiguration)
		const model = tempApiHandler.getModel()
		modelInfo = model.info
		modelId = model.instructionModelId ?? model.id
	} catch (error) {
		console.error("Error fetching model info for system prompt preview:", error)
	}

	const projectInstructionDiscovery = captureProjectInstructionDiscoveryOptions()
	const fragments = await SYSTEM_PROMPT_FRAGMENTS(
		provider.context,
		cwd,
		false, // supportsComputerUse — browser removed
		mcpEnabled ? provider.getMcpHub() : undefined,
		diffStrategy,
		mode,
		customModePrompts,
		customModes,
		customInstructions,
		experiments,
		language,
		alphaIgnoreInstructions,
		{
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
			enableSubfolderRules: enableSubfolderRules ?? false,
			projectInstructionDiscovery,
			memoryContext,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: modelInfo?.isStealthModel,
		},
		undefined, // todoList
		modelId,
		provider.getSkillsManager(),
	)

	for (const warning of fragments.warnings ?? []) void vscode.window.showWarningMessage(warning)
	return renderSystemPromptFragments(fragments)
}
