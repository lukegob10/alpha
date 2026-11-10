import React, { useId, useRef, useState } from "react"
import { VSCodeCheckbox, VSCodePanels, VSCodePanelTab, VSCodePanelView } from "@vscode/webview-ui-toolkit/react"

import type { ApprovalMode, McpServer } from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useTooManyTools } from "@src/hooks/useTooManyTools"
import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	ToggleSwitch,
} from "@src/components/ui"
import { Section } from "@src/components/settings/Section"
import { SectionHeader } from "@src/components/settings/SectionHeader"
import { SettingsHelp } from "@src/components/settings/SettingsHelp"

import McpToolRow from "./McpToolRow"
import McpResourceRow from "./McpResourceRow"
import { McpErrorRow } from "./McpErrorRow"

type McpViewProps = {
	mcpEnabled: boolean
	onMcpEnabledChange: (value: boolean) => void
	alwaysAllowMcp?: boolean
	onAlwaysAllowMcpChange?: (value: boolean) => void
	approvalMode?: ApprovalMode
	embedded?: boolean
}

const McpView = ({
	mcpEnabled,
	onMcpEnabledChange,
	alwaysAllowMcp,
	onAlwaysAllowMcpChange,
	approvalMode,
	embedded = false,
}: McpViewProps) => {
	const extensionState = useExtensionState()
	const { mcpServers: servers } = extensionState
	const grantsEnabled = alwaysAllowMcp ?? extensionState.alwaysAllowMcp
	const grantsOverridden = (approvalMode ?? extensionState.approvalMode) === "bypass"
	const latestGrantEdit = useRef({
		enabled: grantsEnabled === true,
		overridden: grantsOverridden,
		onAlwaysAllowMcpChange,
	})
	// The toolkit emits checked changes while React commits controlled props, before replacing the old listener.
	latestGrantEdit.current = { enabled: grantsEnabled === true, overridden: grantsOverridden, onAlwaysAllowMcpChange }

	const { t } = useAppTranslation()
	const { isOverThreshold, title, message } = useTooManyTools()
	const heading = (
		<span className="flex items-center gap-1">
			<span>{t("mcp:title")}</span>
			<SettingsHelp label={t("mcp:title")}>
				<p className="m-0">{t("mcp:managementDescription")}</p>
				{!mcpEnabled && <p className="mb-0 mt-2">{t("mcp:disabledDescription")}</p>}
			</SettingsHelp>
		</span>
	)

	return (
		<div>
			{!embedded && <SectionHeader>{heading}</SectionHeader>}

			<Section className="gap-2 p-3">
				{embedded && <h4 className="m-0 text-base font-semibold">{heading}</h4>}
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-1">
						<span className="text-sm">{t("mcp:enableToggle.title")}</span>
						<SettingsHelp label={t("mcp:enableToggle.title")}>
							{t("mcp:enableToggle.description")}
						</SettingsHelp>
					</div>
					<ToggleSwitch
						checked={mcpEnabled}
						onChange={() => onMcpEnabledChange(!mcpEnabled)}
						aria-label={t("mcp:enableToggle.title")}
					/>
				</div>

				{onAlwaysAllowMcpChange && (
					<div className="flex items-center gap-1">
						<VSCodeCheckbox
							checked={grantsOverridden || grantsEnabled === true}
							disabled={grantsOverridden}
							onChange={(event) => {
								const target = event.target
								const current = latestGrantEdit.current
								if (
									!current.overridden &&
									target &&
									"checked" in target &&
									typeof target.checked === "boolean" &&
									target.checked !== current.enabled
								) {
									current.onAlwaysAllowMcpChange?.(target.checked)
								}
							}}>
							{t("settings:autoApprove.mcp.label")}
						</VSCodeCheckbox>
						<SettingsHelp label={t("settings:autoApprove.mcp.label")}>
							{t(
								grantsOverridden
									? "settings:autoApprove.mcp.bypassDescription"
									: "settings:autoApprove.mcp.description",
							)}
						</SettingsHelp>
					</div>
				)}
				{/* Too Many Tools Warning */}
				{mcpEnabled && isOverThreshold && (
					<div style={{ marginBottom: 15 }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "6px",
								fontWeight: "500",
								color: "var(--vscode-editorWarning-foreground)",
								marginBottom: "5px",
							}}>
							<span className="codicon codicon-warning" />
							{title}
						</div>
						<div
							style={{
								fontSize: "12px",
								color: "var(--vscode-descriptionForeground)",
							}}>
							{message}
						</div>
					</div>
				)}

				{/* Server List */}
				{servers.length > 0 && (
					<div className="flex flex-col gap-2">
						{servers.map((server) => (
							<ServerRow
								key={`${server.name}-${server.source || "global"}`}
								server={server}
								mcpEnabled={mcpEnabled}
								alwaysAllowMcp={grantsEnabled}
							/>
						))}
					</div>
				)}

				{/* Edit Settings Buttons */}
				<div
					style={{
						marginTop: "10px",
						width: "100%",
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
						gap: "10px",
					}}>
					<Button
						variant="secondary"
						style={{ width: "100%" }}
						onClick={() => {
							vscode.postMessage({ type: "openMcpSettings" })
						}}>
						<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
						{t("mcp:editGlobalMCP")}
					</Button>
					<Button
						variant="secondary"
						style={{ width: "100%" }}
						onClick={() => {
							vscode.postMessage({ type: "openProjectMcpSettings" })
						}}>
						<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
						{t("mcp:editProjectMCP")}
					</Button>
					<Button
						variant="secondary"
						style={{ width: "100%" }}
						disabled={!mcpEnabled}
						onClick={() => {
							vscode.postMessage({ type: "refreshAllMcpServers" })
						}}>
						<span className="codicon codicon-refresh" style={{ marginRight: "6px" }}></span>
						{t("mcp:refreshMCP")}
					</Button>
				</div>
			</Section>
		</div>
	)
}

const ServerRow = ({
	server,
	mcpEnabled,
	alwaysAllowMcp,
}: {
	server: McpServer
	mcpEnabled: boolean
	alwaysAllowMcp?: boolean
}) => {
	const { t } = useAppTranslation()
	const panelId = useId()
	const [isExpanded, setIsExpanded] = useState(false)
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const [timeoutValue, setTimeoutValue] = useState(() => {
		const configTimeout = JSON.parse(server.config)?.timeout
		return configTimeout ?? 60 // Default 1 minute (60 seconds)
	})

	const timeoutOptions = [
		{ value: 15, label: t("mcp:networkTimeout.options.15seconds") },
		{ value: 30, label: t("mcp:networkTimeout.options.30seconds") },
		{ value: 60, label: t("mcp:networkTimeout.options.1minute") },
		{ value: 300, label: t("mcp:networkTimeout.options.5minutes") },
		{ value: 600, label: t("mcp:networkTimeout.options.10minutes") },
		{ value: 900, label: t("mcp:networkTimeout.options.15minutes") },
		{ value: 1800, label: t("mcp:networkTimeout.options.30minutes") },
		{ value: 3600, label: t("mcp:networkTimeout.options.60minutes") },
	]

	const getStatusColor = () => {
		// Disabled servers should always show grey regardless of connection status
		if (!mcpEnabled || server.disabled) {
			return "var(--vscode-descriptionForeground)"
		}

		switch (server.status) {
			case "connected":
				return "var(--vscode-testing-iconPassed)"
			case "connecting":
				return "var(--vscode-charts-yellow)"
			case "disconnected":
				return "var(--vscode-testing-iconFailed)"
		}
	}

	const handleRestart = () => {
		vscode.postMessage({
			type: "restartMcpServer",
			text: server.name,
			source: server.source || "global",
		})
	}

	const handleTimeoutChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const seconds = parseInt(event.target.value)
		setTimeoutValue(seconds)
		vscode.postMessage({
			type: "updateMcpTimeout",
			serverName: server.name,
			source: server.source || "global",
			timeout: seconds,
		})
	}

	const handleDelete = () => {
		vscode.postMessage({
			type: "deleteMcpServer",
			serverName: server.name,
			source: server.source || "global",
		})
		setShowDeleteConfirm(false)
	}

	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "8px",
					background: "var(--vscode-textCodeBlock-background)",
					borderRadius: "4px",
					opacity: server.disabled ? 0.6 : 1,
				}}>
				<button
					type="button"
					aria-label={t("mcp:serverActions.showDetails", { serverName: server.name })}
					aria-expanded={isExpanded}
					aria-controls={`${panelId}-details`}
					onClick={() => setIsExpanded((expanded) => !expanded)}
					className="min-w-0 flex flex-1 items-center text-left bg-transparent border-0 p-0 text-vscode-foreground cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
					<span
						className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}
						style={{ marginRight: "8px" }}
					/>
					<span style={{ flex: 1 }}>
						{server.name}
						{server.source && (
							<span
								style={{
									marginLeft: "8px",
									padding: "1px 6px",
									fontSize: "11px",
									borderRadius: "4px",
									background: "var(--vscode-badge-background)",
									color: "var(--vscode-badge-foreground)",
								}}>
								{server.source}
							</span>
						)}
					</span>
				</button>
				<div
					style={{ display: "flex", alignItems: "center", marginRight: "8px" }}
					onClick={(e) => e.stopPropagation()}>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("mcp:serverActions.delete", { serverName: server.name })}
						onClick={() => setShowDeleteConfirm(true)}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-trash" style={{ fontSize: "14px" }}></span>
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("mcp:serverActions.restart", { serverName: server.name })}
						onClick={handleRestart}
						disabled={!mcpEnabled || server.disabled || server.status === "connecting"}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-refresh" style={{ fontSize: "14px" }}></span>
					</Button>
				</div>
				<div
					style={{
						width: "8px",
						height: "8px",
						borderRadius: "50%",
						background: getStatusColor(),
						marginLeft: "8px",
					}}
				/>
				<div style={{ marginLeft: "8px" }}>
					<ToggleSwitch
						checked={!server.disabled}
						onChange={() => {
							vscode.postMessage({
								type: "toggleMcpServer",
								serverName: server.name,
								source: server.source || "global",
								disabled: !server.disabled,
							})
						}}
						size="medium"
						aria-label={t("mcp:serverActions.toggleEnabled", { serverName: server.name })}
					/>
				</div>
			</div>

			{isExpanded && (
				<div
					id={`${panelId}-details`}
					style={{
						background: "var(--vscode-textCodeBlock-background)",
						padding: "0 10px 10px 10px",
						fontSize: "13px",
						borderRadius: "0 0 4px 4px",
					}}>
					<VSCodePanels style={{ marginBottom: "10px" }}>
						<VSCodePanelTab id={`${panelId}-tools`} aria-controls={`${panelId}-tools-view`}>
							{t("mcp:tabs.tools")} ({server.tools?.length || 0})
						</VSCodePanelTab>
						<VSCodePanelTab id={`${panelId}-resources`} aria-controls={`${panelId}-resources-view`}>
							{t("mcp:tabs.resources")} (
							{[...(server.resourceTemplates || []), ...(server.resources || [])].length || 0})
						</VSCodePanelTab>
						{server.instructions && (
							<VSCodePanelTab
								id={`${panelId}-instructions`}
								aria-controls={`${panelId}-instructions-view`}>
								{t("mcp:instructions")}
							</VSCodePanelTab>
						)}
						<VSCodePanelTab id={`${panelId}-logs`} aria-controls={`${panelId}-logs-view`}>
							{t("mcp:tabs.logs")} ({server.errorHistory?.length || 0})
						</VSCodePanelTab>

						<VSCodePanelView id={`${panelId}-tools-view`} aria-labelledby={`${panelId}-tools`}>
							{server.tools && server.tools.length > 0 ? (
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "8px",
										width: "100%",
									}}>
									{server.tools.map((tool) => (
										<McpToolRow
											key={`${tool.name}-${server.name}-${server.source || "global"}`}
											tool={tool}
											serverName={server.name}
											serverSource={server.source || "global"}
											alwaysAllowMcp={alwaysAllowMcp}
										/>
									))}
								</div>
							) : (
								<div style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
									{t("mcp:emptyState.noTools")}
								</div>
							)}
						</VSCodePanelView>

						<VSCodePanelView id={`${panelId}-resources-view`} aria-labelledby={`${panelId}-resources`}>
							{(server.resources && server.resources.length > 0) ||
							(server.resourceTemplates && server.resourceTemplates.length > 0) ? (
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "8px",
										width: "100%",
									}}>
									{[...(server.resourceTemplates || []), ...(server.resources || [])].map((item) => (
										<McpResourceRow
											key={"uriTemplate" in item ? item.uriTemplate : item.uri}
											item={item}
										/>
									))}
								</div>
							) : (
								<div style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
									{t("mcp:emptyState.noResources")}
								</div>
							)}
						</VSCodePanelView>

						{server.instructions && (
							<VSCodePanelView
								id={`${panelId}-instructions-view`}
								aria-labelledby={`${panelId}-instructions`}>
								<div style={{ padding: "10px 0", fontSize: "12px" }}>
									<div className="opacity-80 whitespace-pre-wrap break-words">
										{server.instructions}
									</div>
								</div>
							</VSCodePanelView>
						)}

						<VSCodePanelView id={`${panelId}-logs-view`} aria-labelledby={`${panelId}-logs`}>
							{server.errorHistory && server.errorHistory.length > 0 ? (
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "8px",
										width: "100%",
									}}>
									{[...server.errorHistory]
										.sort((a, b) => b.timestamp - a.timestamp)
										.map((error, index) => (
											<McpErrorRow key={`${error.timestamp}-${index}`} error={error} />
										))}
								</div>
							) : (
								<div style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
									{t("mcp:emptyState.noLogs")}
								</div>
							)}
						</VSCodePanelView>
					</VSCodePanels>

					<details>
						<summary className="cursor-pointer text-sm">{t("mcp:advancedSettings")}</summary>
						{/* Network Timeout */}
						<div style={{ padding: "10px 7px" }}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "10px",
									marginBottom: "8px",
								}}>
								<span>{t("mcp:networkTimeout.label")}</span>
								<select
									value={timeoutValue}
									aria-label={t("mcp:networkTimeout.label")}
									onChange={handleTimeoutChange}
									style={{
										flex: 1,
										padding: "4px",
										background: "var(--vscode-dropdown-background)",
										color: "var(--vscode-dropdown-foreground)",
										border: "1px solid var(--vscode-dropdown-border)",
										borderRadius: "2px",
										outline: "none",
										cursor: "pointer",
									}}>
									{timeoutOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</div>
							<span
								style={{
									fontSize: "12px",
									color: "var(--vscode-descriptionForeground)",
									display: "block",
								}}>
								{t("mcp:networkTimeout.description")}
							</span>
						</div>
					</details>
				</div>
			)}
			{mcpEnabled && !server.disabled && server.status !== "connected" && (
				<div
					style={{
						fontSize: "13px",
						background: "var(--vscode-textCodeBlock-background)",
						borderRadius: "0 0 4px 4px",
						width: "100%",
					}}>
					<div
						style={{
							color: "var(--vscode-testing-iconFailed)",
							marginBottom: "8px",
							padding: "0 10px",
							overflowWrap: "break-word",
							wordBreak: "break-word",
						}}>
						{server.error &&
							server.error.split("\n").map((item, index) => (
								<React.Fragment key={index}>
									{index > 0 && <br />}
									{item}
								</React.Fragment>
							))}
					</div>
					<Button
						variant="secondary"
						onClick={handleRestart}
						disabled={server.status === "connecting"}
						style={{ width: "calc(100% - 20px)", margin: "0 10px 10px 10px" }}>
						{server.status === "connecting"
							? t("mcp:serverStatus.retrying")
							: t("mcp:serverStatus.retryConnection")}
					</Button>
				</div>
			)}

			{/* Delete Confirmation Dialog */}
			<Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("mcp:deleteDialog.title")}</DialogTitle>
						<DialogDescription>
							{t("mcp:deleteDialog.description", { serverName: server.name })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>
							{t("mcp:deleteDialog.cancel")}
						</Button>
						<Button variant="primary" onClick={handleDelete}>
							{t("mcp:deleteDialog.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export default McpView
