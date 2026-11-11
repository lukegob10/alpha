import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import type { McpTool } from "@alpha-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { StandardTooltip, ToggleSwitch } from "@/components/ui"
import { SettingsHelp } from "@src/components/settings/SettingsHelp"

type McpToolRowProps = {
	tool: McpTool
	serverName?: string
	serverSource?: "global" | "project"
	alwaysAllowMcp?: boolean
	isInChatContext?: boolean
}

const McpToolRow = ({ tool, serverName, serverSource, alwaysAllowMcp, isInChatContext = false }: McpToolRowProps) => {
	const { t } = useAppTranslation()
	const isToolEnabled = tool.enabledForPrompt ?? true
	const inputSchema = tool.inputSchema
	const properties =
		inputSchema &&
		"properties" in inputSchema &&
		typeof inputSchema.properties === "object" &&
		inputSchema.properties !== null
			? inputSchema.properties
			: {}
	const requiredParameters =
		inputSchema && "required" in inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : []
	const parameters = isToolEnabled
		? Object.entries(properties).map(([name, schema]: [string, unknown]) => ({
				name,
				required: requiredParameters.includes(name),
				description:
					typeof schema === "object" &&
					schema !== null &&
					"description" in schema &&
					typeof schema.description === "string"
						? schema.description
						: t("mcp:tool.noDescription"),
			}))
		: []

	const handleAlwaysAllowChange = () => {
		if (!serverName) return
		vscode.postMessage({
			type: "toggleToolAlwaysAllow",
			serverName,
			source: serverSource || "global",
			toolName: tool.name,
			alwaysAllow: !tool.alwaysAllow,
		})
	}

	const handleEnabledForPromptChange = () => {
		if (!serverName) return
		vscode.postMessage({
			type: "toggleToolEnabledForPrompt",
			serverName,
			source: serverSource || "global",
			toolName: tool.name,
			isEnabled: !isToolEnabled,
		})
	}

	return (
		<div key={tool.name} className="py-2 border-b border-vscode-panel-border last:border-b-0">
			<div
				data-testid="tool-row-container"
				className="flex items-center gap-2"
				onClick={(e) => e.stopPropagation()}>
				{/* Tool name section */}
				<div className="flex items-center min-w-0 flex-1">
					<span
						className={`codicon codicon-symbol-method mr-2 flex-shrink-0 ${
							isToolEnabled
								? "text-vscode-symbolIcon-methodForeground"
								: "text-vscode-descriptionForeground opacity-60"
						}`}></span>
					<StandardTooltip content={tool.name}>
						<span
							className={`font-medium truncate ${
								isToolEnabled
									? "text-vscode-foreground"
									: "text-vscode-descriptionForeground opacity-60"
							}`}>
							{tool.name}
						</span>
					</StandardTooltip>
					{(tool.description || parameters.length > 0) && (
						<SettingsHelp label={tool.name}>
							{tool.description && <p className="m-0">{tool.description}</p>}
							{parameters.length > 0 && (
								<div className="mt-2">
									<div className="mb-1 text-xs font-medium">{t("mcp:tool.parameters")}</div>
									<dl className="m-0 space-y-2">
										{parameters.map((parameter) => (
											<div key={parameter.name}>
												<dt>
													<code>
														{parameter.name}
														{parameter.required && (
															<span className="text-vscode-errorForeground">*</span>
														)}
													</code>
												</dt>
												<dd className="m-0 text-vscode-descriptionForeground">
													{parameter.description}
												</dd>
											</div>
										))}
									</dl>
								</div>
							)}
						</SettingsHelp>
					)}
				</div>

				{/* Controls section */}
				{serverName && (
					<div className="flex items-center gap-2 flex-shrink-0">
						{/* Always Allow checkbox - only show when tool is enabled */}
						{alwaysAllowMcp && isToolEnabled && (
							<VSCodeCheckbox
								checked={tool.alwaysAllow}
								onChange={handleAlwaysAllowChange}
								data-tool={tool.name}
								className="text-xs">
								<span className="text-vscode-descriptionForeground whitespace-nowrap">
									{t("mcp:tool.alwaysAllow")}
								</span>
							</VSCodeCheckbox>
						)}

						{/* Enabled toggle switch - only show in settings context */}
						{!isInChatContext && (
							<StandardTooltip content={t("mcp:tool.enableDescription")}>
								<ToggleSwitch
									checked={isToolEnabled}
									onChange={handleEnabledForPromptChange}
									size="medium"
									aria-label={t("mcp:tool.enable")}
									data-testid={`tool-prompt-toggle-${tool.name}`}
								/>
							</StandardTooltip>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

export default McpToolRow
