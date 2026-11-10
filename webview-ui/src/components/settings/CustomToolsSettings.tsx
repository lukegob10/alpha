import { useState, useEffect, useCallback, useMemo, useRef, useId } from "react"
import { useEvent } from "react-use"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { Checkbox } from "@vscode/webview-ui-toolkit"
import { RefreshCw, Loader2 } from "lucide-react"

import type { ExtensionMessage, SerializedCustomToolDefinition } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { vscode } from "@/utils/vscode"

import { Button } from "@/components/ui"

import { SettingsHelp } from "./SettingsHelp"

interface ToolParameter {
	name: string
	type: string
	description?: string
	required: boolean
}

interface ProcessedTool {
	name: string
	description: string
	parameters: ToolParameter[]
	source?: string
}

interface CustomToolsSettingsProps {
	enabled: boolean
	committedEnabled: boolean
	isActive: boolean
	onChange: (enabled: boolean) => void
}

export const CustomToolsSettings = ({ enabled, committedEnabled, isActive, onChange }: CustomToolsSettingsProps) => {
	const { t } = useAppTranslation()
	const executableWarningId = useId()
	const [tools, setTools] = useState<SerializedCustomToolDefinition[]>([])
	const [isRefreshing, setIsRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState<string | null>(null)
	const canLoadTools = enabled && committedEnabled && isActive
	const latestEnabled = useRef(enabled)
	// The toolkit can emit change while React applies a new checked property.
	latestEnabled.current = enabled

	const onRefresh = useCallback(() => {
		if (!canLoadTools) return
		setIsRefreshing(true)
		setRefreshError(null)
		vscode.postMessage({ type: "refreshCustomTools" })
	}, [canLoadTools])

	useEffect(() => {
		// Importing tool modules can execute code. Buffered edits and hidden search
		// mounts must never load them before the host confirms the saved opt-in.
		if (canLoadTools) {
			onRefresh()
		} else {
			setTools([])
			setIsRefreshing(false)
			setRefreshError(null)
		}
	}, [canLoadTools, onRefresh])

	useEvent("message", (event: MessageEvent<ExtensionMessage>) => {
		const message = event.data

		if (canLoadTools && message.type === "customToolsResult") {
			setTools(message.tools || [])
			setIsRefreshing(false)
			setRefreshError(message.error ?? null)
		}
	})

	const processedTools = useMemo<ProcessedTool[]>(
		() =>
			tools.map((tool) => {
				const params = tool.parameters
				const properties = (params?.properties ?? {}) as Record<string, { type?: string; description?: string }>
				const required = (params?.required as string[] | undefined) ?? []

				return {
					name: tool.name,
					description: tool.description,
					source: tool.source,
					parameters: Object.entries(properties).map(([name, def]) => ({
						name,
						type: def.type ?? "any",
						description: def.description,
						required: required.includes(name),
					})),
				}
			}),
		[tools],
	)

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<VSCodeCheckbox
					checked={enabled}
					aria-describedby={executableWarningId}
					onChange={(event) => {
						const checked = (event.target as Checkbox).checked
						if (checked !== latestEnabled.current) onChange(checked)
					}}>
					<span className="font-medium">{t("settings:customTools.name")}</span>
				</VSCodeCheckbox>
				<span id={executableWarningId} className="text-vscode-descriptionForeground text-xs">
					{t("settings:customTools.executableWarning")}
				</span>
				<SettingsHelp label={t("settings:customTools.name")}>
					{t("settings:customTools.description")}
				</SettingsHelp>
			</div>

			{enabled && !committedEnabled && (
				<p className="text-vscode-descriptionForeground text-sm" role="status">
					{t("settings:customTools.saveToLoad")}
				</p>
			)}

			{enabled && committedEnabled && (
				<div className="ml-2 space-y-2">
					<div className="flex items-center justify-between gap-4">
						<h4 className="font-medium">{t("settings:customTools.toolsHeader")}</h4>
						<Button variant="outline" onClick={onRefresh} disabled={isRefreshing || !canLoadTools}>
							<div className="flex items-center gap-2">
								{isRefreshing ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<RefreshCw className="w-4 h-4" />
								)}
								{isRefreshing
									? t("settings:customTools.refreshing")
									: t("settings:customTools.refreshButton")}
							</div>
						</Button>
					</div>

					{refreshError && (
						<div
							role="alert"
							className="p-2 bg-vscode-inputValidation-errorBackground text-vscode-errorForeground rounded text-sm border border-vscode-inputValidation-errorBorder">
							{t("settings:customTools.refreshError")}: {refreshError}
						</div>
					)}

					{processedTools.length === 0 && !isRefreshing && !refreshError ? (
						<p className="text-vscode-descriptionForeground text-sm italic">
							{t("settings:customTools.noTools")}
						</p>
					) : (
						processedTools.map((tool) => (
							<div key={tool.name} className="flex items-center justify-between gap-2 py-1">
								<span className="min-w-0 truncate text-sm font-medium text-vscode-foreground">
									{tool.name}
								</span>
								<SettingsHelp label={tool.name}>
									<p className="m-0">{tool.description}</p>
									{tool.source && <code className="block break-all text-xs">{tool.source}</code>}
									{tool.parameters.length > 0 && (
										<div className="space-y-1">
											<p className="m-0 font-medium text-vscode-foreground">
												{t("settings:customTools.toolParameters")}
											</p>
											<dl className="m-0 space-y-1">
												{tool.parameters.map((param) => (
													<div key={param.name}>
														<dt className="flex flex-wrap items-center gap-x-2 text-xs">
															<code className="text-vscode-textLink-foreground">
																{param.name}
															</code>
															<span>({param.type})</span>
															{param.required && (
																<span>{t("settings:customTools.required")}</span>
															)}
														</dt>
														{param.description && (
															<dd className="m-0 text-xs">{param.description}</dd>
														)}
													</div>
												))}
											</dl>
										</div>
									)}
								</SettingsHelp>
							</div>
						))
					)}
				</div>
			)}
		</div>
	)
}
