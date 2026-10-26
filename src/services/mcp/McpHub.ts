import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import ReconnectingEventSource from "reconnecting-eventsource"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import { z } from "zod"

import type {
	ExtensionMessage,
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
} from "@alpha-code/types"

import { t } from "../../i18n"

import { AlphaProvider } from "../../core/webview/AlphaProvider"

import { GlobalFileNames } from "../../shared/globalFileNames"

import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual, getWorkspacePath } from "../../utils/path"
import { injectVariables } from "../../utils/config"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { sanitizeMcpName, toolNamesMatch } from "../../utils/mcp-name"
import { getProjectMcpConfigPath } from "../config-paths"
import { collectPaginatedCatalog, MAX_MCP_CATALOG_ITEMS, validateMcpPaginationCursor } from "./pagination"

// Discriminated union for connection states
export type ConnectedMcpConnection = {
	type: "connected"
	server: McpServer
	client: Client
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
}

export type DisconnectedMcpConnection = {
	type: "disconnected"
	server: McpServer
	client: null
	transport: null
}

export type McpConnection = ConnectedMcpConnection | DisconnectedMcpConnection

// Enum for disable reasons
export enum DisableReason {
	MCP_DISABLED = "mcpDisabled",
	SERVER_DISABLED = "serverDisabled",
}

// Base configuration schema for common settings
const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(60),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(), // paths to watch for changes and restart server
	disabledTools: z.array(z.string()).default([]),
})

// Custom error messages for better user feedback
const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"
const stdioFieldsErrorMessage =
	"For 'stdio' type servers, you must provide a 'command' field and can optionally include 'args' and 'env'"
const sseFieldsErrorMessage =
	"For 'sse' type servers, you must provide a 'url' field and can optionally include 'headers'"
const streamableHttpFieldsErrorMessage =
	"For 'streamable-http' type servers, you must provide a 'url' field and can optionally include 'headers'"
const mixedFieldsErrorMessage =
	"Cannot mix 'stdio' and ('sse' or 'streamable-http') fields. For 'stdio' use 'command', 'args', and 'env'. For 'sse'/'streamable-http' use 'url' and 'headers'"
const missingFieldsErrorMessage =
	"Server configuration must include either 'command' (for stdio) or 'url' (for sse/streamable-http) and a corresponding 'type' if 'url' is used."

/**
 * Dispatch an MCP request synchronously, forward cancellation to the SDK, and
 * still settle promptly when a transport ignores that signal. The handlers on
 * the request promise remain attached after cancellation so late settlement is
 * observed without changing the cancelled caller's result.
 */
function requestWithAbort<T>(dispatch: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted()
	const request = dispatch()

	if (!signal) {
		return request
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false
		const cleanup = () => signal.removeEventListener("abort", onAbort)
		const onAbort = () => {
			if (settled) return
			settled = true
			cleanup()
			reject(signal.reason)
		}
		const settle = (callback: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			callback()
		}

		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
		}

		request.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error)),
		)
	})
}

// Helper function to create a refined schema with better error messages
const createServerTypeSchema = () => {
	return z.union([
		// Stdio config (has command field)
		BaseConfigSchema.extend({
			type: z.enum(["stdio"]).optional(),
			command: z.string().min(1, "Command cannot be empty"),
			args: z.array(z.string()).optional(),
			cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
			env: z.record(z.string()).optional(),
			// Ensure no SSE fields are present
			url: z.undefined().optional(),
			headers: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "stdio" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
		// SSE config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["sse"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "sse" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
		// StreamableHTTP config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["streamable-http"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "streamable-http" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "streamable-http", {
				message: typeErrorMessage,
			}),
	])
}

// Server configuration schema with automatic type inference and validation
export const ServerConfigSchema = createServerTypeSchema()

// Settings schema
const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})

// Preserve unrelated settings and validate only the server changed by a locked mutation.
const McpSettingsFileSchema = McpSettingsSchema.extend({ mcpServers: z.record(z.unknown()) }).passthrough()

export interface McpHubOptions {
	getProvider?: () => AlphaProvider | undefined
	notifyProviders?: (message: ExtensionMessage) => Promise<void>
}

export class McpHub {
	private providerRef: WeakRef<AlphaProvider>
	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	private fileWatchers: Map<string, FSWatcher[]> = new Map()
	private projectMcpWatcher?: vscode.FileSystemWatcher
	private isDisposed: boolean = false
	connections: McpConnection[] = []
	isConnecting: boolean = false
	private refCount: number = 0 // Reference counter for active clients
	private configChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
	private isProgrammaticUpdate: boolean = false
	private flagResetTimer?: NodeJS.Timeout
	private pendingConfigUpdates = 0
	private sanitizedNameRegistry: Map<string, string> = new Map()
	private initializationPromise: Promise<void>
	private connectionControllers = new Map<ConnectedMcpConnection, AbortController>()
	private catalogRefreshControllers = new Map<
		ConnectedMcpConnection,
		{ controller: AbortController; full: boolean }
	>()
	private connectionAttempts = new Map<string, AbortController>()
	private latestCatalogRefresh = new WeakMap<ConnectedMcpConnection, Promise<void>>()
	private catalogErrors = new WeakMap<ConnectedMcpConnection, string>()
	private catalogChanges = new Map<ConnectedMcpConnection, { requested: boolean; promise: Promise<void> }>()
	private catalogRevisions = new WeakMap<ConnectedMcpConnection, number>()

	constructor(
		provider: AlphaProvider,
		private readonly options: McpHubOptions = {},
	) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile().catch((error) => {
			console.error("Failed to watch global MCP settings:", error)
		})
		this.watchProjectMcpFile().catch(console.error)
		this.setupWorkspaceFoldersWatcher()
		this.initializationPromise = Promise.all([
			this.initializeGlobalMcpServers(),
			this.initializeProjectMcpServers(),
		]).then(() => {})
	}

	public get disposed(): boolean {
		return this.isDisposed
	}

	private getProvider(): AlphaProvider | undefined {
		return this.options.getProvider ? this.options.getProvider() : this.providerRef.deref()
	}

	/**
	 * Waits until all MCP servers have finished their initial connection attempts.
	 * Each server individually handles its own timeout, so this will not block indefinitely.
	 */
	async waitUntilReady(): Promise<void> {
		await this.initializationPromise
	}

	/** A revision is executable only after discovery has settled successfully for this exact connection. */
	getServerCatalogRevision(server: McpServer): number | undefined {
		const connection = this.connections.find((entry) => entry.server === server)
		if (
			this.isDisposed ||
			connection?.type !== "connected" ||
			server.disabled ||
			server.status !== "connected" ||
			this.catalogChanges.has(connection) ||
			this.catalogRefreshControllers.has(connection) ||
			this.catalogErrors.has(connection)
		)
			return undefined
		return this.catalogRevisions.get(connection) ?? 0
	}

	/** Join existing discovery without letting one task's cancellation abort a refresh shared by other views. */
	async awaitCatalogReady(signal?: AbortSignal): Promise<void> {
		await requestWithAbort(async () => {
			while (true) {
				if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
				signal?.throwIfAborted()
				const connections = this.connections.filter(
					(connection): connection is ConnectedMcpConnection =>
						connection.type === "connected" &&
						!connection.server.disabled &&
						connection.server.status === "connected",
				)
				const revisions = connections.map((connection) => this.catalogRevisions.get(connection) ?? 0)
				await Promise.all(
					connections.map(async (connection) => {
						try {
							await this.catalogChanges.get(connection)?.promise
							const refresh = this.latestCatalogRefresh.get(connection)
							if (refresh) await this.waitForCurrentCatalog(connection, refresh)
						} catch (error) {
							// Reported discovery failures revoke this server's bindings while unrelated tools remain available.
							if (
								this.connections.includes(connection) &&
								connection.server.status === "connected" &&
								!this.catalogErrors.has(connection)
							)
								throw error
						}
					}),
				)
				signal?.throwIfAborted()
				const current = this.connections.filter(
					(connection) =>
						connection.type === "connected" &&
						!connection.server.disabled &&
						connection.server.status === "connected",
				)
				if (
					current.length === connections.length &&
					connections.every(
						(connection, index) =>
							current.includes(connection) &&
							(this.getServerCatalogRevision(connection.server) === revisions[index] ||
								(this.catalogErrors.has(connection) &&
									!this.catalogChanges.has(connection) &&
									!this.catalogRefreshControllers.has(connection) &&
									(this.catalogRevisions.get(connection) ?? 0) === revisions[index])),
					)
				)
					return
			}
		}, signal)
	}
	/**
	 * Registers a client (e.g., AlphaProvider) using this hub.
	 * Increments the reference count.
	 */
	public registerClient(): void {
		this.refCount++
	}

	/**
	 * Unregisters a client. Decrements the reference count.
	 * By default, disposes the hub when its last client disconnects. The shared
	 * manager also accounts for pending acquisitions before deciding to dispose.
	 */
	public async unregisterClient(disposeWhenUnused = true): Promise<void> {
		this.refCount--

		if (disposeWhenUnused && this.refCount <= 0) {
			await this.dispose()
		}
	}

	/**
	 * Validates and normalizes server configuration
	 * @param config The server configuration to validate
	 * @param serverName Optional server name for error messages
	 * @returns The validated configuration
	 * @throws Error if the configuration is invalid
	 */
	private validateServerConfig(config: any, serverName?: string): z.infer<typeof ServerConfigSchema> {
		// Detect configuration issues before validation
		const hasStdioFields = config.command !== undefined
		const hasUrlFields = config.url !== undefined // Covers sse and streamable-http

		// Check for mixed fields (stdio vs url-based)
		if (hasStdioFields && hasUrlFields) {
			throw new Error(mixedFieldsErrorMessage)
		}

		// Infer type for stdio if not provided
		if (!config.type && hasStdioFields) {
			config.type = "stdio"
		}

		// For url-based configs, type must be provided by the user
		if (hasUrlFields && !config.type) {
			throw new Error("Configuration with 'url' must explicitly specify 'type' as 'sse' or 'streamable-http'.")
		}

		// Validate type if provided
		if (config.type && !["stdio", "sse", "streamable-http"].includes(config.type)) {
			throw new Error(typeErrorMessage)
		}

		// Check for type/field mismatch
		if (config.type === "stdio" && !hasStdioFields) {
			throw new Error(stdioFieldsErrorMessage)
		}
		if (config.type === "sse" && !hasUrlFields) {
			throw new Error(sseFieldsErrorMessage)
		}
		if (config.type === "streamable-http" && !hasUrlFields) {
			throw new Error(streamableHttpFieldsErrorMessage)
		}

		// If neither command nor url is present (type alone is not enough)
		if (!hasStdioFields && !hasUrlFields) {
			throw new Error(missingFieldsErrorMessage)
		}

		// Validate the config against the schema
		try {
			return ServerConfigSchema.parse(config)
		} catch (validationError) {
			if (validationError instanceof z.ZodError) {
				// Extract and format validation errors
				const errorMessages = validationError.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("; ")
				throw new Error(
					serverName
						? `Invalid configuration for server "${serverName}": ${errorMessages}`
						: `Invalid server configuration: ${errorMessages}`,
				)
			}
			throw validationError
		}
	}

	/**
	 * Formats and displays error messages to the user
	 * @param message The error message prefix
	 * @param error The error object
	 */
	private showErrorMessage(message: string, error: unknown): void {
		console.error(`${message}:`, error)
	}

	public setupWorkspaceFoldersWatcher(): void {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				await this.updateProjectMcpServers()
				await this.watchProjectMcpFile()
			}),
		)
	}

	/**
	 * Debounced wrapper for handling config file changes
	 */
	private debounceConfigChange(filePath: string, source: "global" | "project"): void {
		// Skip processing if this is a programmatic update to prevent unnecessary server restarts
		if (this.isDisposed || this.isProgrammaticUpdate) {
			return
		}

		const key = `${source}-${filePath}`

		// Clear existing timer if any
		const existingTimer = this.configChangeDebounceTimers.get(key)
		if (existingTimer) {
			clearTimeout(existingTimer)
		}

		// Set new timer
		const timer = setTimeout(async () => {
			this.configChangeDebounceTimers.delete(key)
			await this.handleConfigFileChange(filePath, source)
		}, 500) // 500ms debounce

		this.configChangeDebounceTimers.set(key, timer)
	}

	private async handleConfigFileChange(filePath: string, source: "global" | "project"): Promise<void> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			const result = McpSettingsSchema.safeParse(config)

			if (!result.success) {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
				return
			}

			await this.updateServerConnections(result.data.mcpServers || {}, source)
		} catch (error) {
			// Check if the error is because the file doesn't exist
			if (error.code === "ENOENT" && source === "project") {
				// File was deleted, clean up project MCP servers
				await this.cleanupProjectMcpServers()
				await this.notifyWebviewOfServerChanges()
				vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
			} else {
				this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
			}
		}
	}

	private async watchProjectMcpFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (this.isDisposed || process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing project MCP watcher if it exists
		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			return
		}

		const workspaceFolder = this.getProvider()?.cwd ?? getWorkspacePath()
		const projectMcpPattern = new vscode.RelativePattern(workspaceFolder, ".alpha/mcp.json")

		// Create a file system watcher for the project MCP file pattern
		this.projectMcpWatcher = vscode.workspace.createFileSystemWatcher(projectMcpPattern)

		// Watch for file changes
		const changeDisposable = this.projectMcpWatcher.onDidChange((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file creation
		const createDisposable = this.projectMcpWatcher.onDidCreate((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file deletion
		const deleteDisposable = this.projectMcpWatcher.onDidDelete(async () => {
			// Clean up all project MCP servers when the file is deleted
			await this.cleanupProjectMcpServers()
			await this.notifyWebviewOfServerChanges()
			vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
		})

		this.disposables.push(
			vscode.Disposable.from(changeDisposable, createDisposable, deleteDisposable, this.projectMcpWatcher),
		)
	}

	private async updateProjectMcpServers(): Promise<void> {
		try {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) return

			const content = await fs.readFile(projectMcpPath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			// Validate configuration structure
			const result = McpSettingsSchema.safeParse(config)
			if (result.success) {
				await this.updateServerConnections(result.data.mcpServers || {}, "project")
			} else {
				// Format validation errors for better user feedback
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error("Invalid project MCP settings format:", errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
			}
		} catch (error) {
			this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
		}
	}

	private async cleanupProjectMcpServers(): Promise<void> {
		// Disconnect and remove all project MCP servers
		const projectConnections = this.connections.filter((conn) => conn.server.source === "project")

		for (const conn of projectConnections) {
			await this.deleteConnection(conn.server.name, "project")
		}

		// Clear project servers from the connections list
		await this.updateServerConnections({}, "project", false)
	}

	getServers(): McpServer[] {
		// Only return enabled servers, deduplicating by name with project servers taking priority
		const enabledConnections = this.connections.filter((conn) => !conn.server.disabled)

		// Deduplicate by server name: project servers take priority over global servers
		const serversByName = new Map<string, McpServer>()
		for (const conn of enabledConnections) {
			const existing = serversByName.get(conn.server.name)
			if (!existing) {
				serversByName.set(conn.server.name, conn.server)
			} else if (conn.server.source === "project" && existing.source !== "project") {
				// Project server overrides global server with the same name
				serversByName.set(conn.server.name, conn.server)
			}
			// If existing is project and current is global, keep existing (project wins)
		}

		return Array.from(serversByName.values())
	}

	getAllServers(): McpServer[] {
		// Return all servers regardless of state
		return this.connections.map((conn) => conn.server)
	}

	async getMcpServersPath(): Promise<string> {
		const provider = this.getProvider()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.getProvider()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(
			await provider.ensureSettingsDirectoryExists(),
			GlobalFileNames.mcpSettings,
		)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {

  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	private async watchMcpSettingsFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (this.isDisposed || process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing settings watcher if it exists
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		const settingsPath = await this.getMcpSettingsFilePath()
		// The path lookup may finish after the final provider has released the hub.
		if (this.isDisposed) return
		const settingsPattern = new vscode.RelativePattern(path.dirname(settingsPath), path.basename(settingsPath))

		// Create a file system watcher for the global MCP settings file
		this.settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPattern)

		// Watch for file changes
		const changeDisposable = this.settingsWatcher.onDidChange((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		// Watch for file creation
		const createDisposable = this.settingsWatcher.onDidCreate((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		this.disposables.push(vscode.Disposable.from(changeDisposable, createDisposable, this.settingsWatcher))
	}

	private async initializeMcpServers(source: "global" | "project"): Promise<void> {
		try {
			const configPath =
				source === "global" ? await this.getMcpSettingsFilePath() : await this.getProjectMcpPath()

			if (!configPath) {
				return
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)
			const result = McpSettingsSchema.safeParse(config)

			if (result.success) {
				// Pass all servers including disabled ones - they'll be handled in updateServerConnections
				await this.updateServerConnections(result.data.mcpServers || {}, source, false)
			} else {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error(`Invalid ${source} MCP settings format:`, errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))

				if (source === "global") {
					// Still try to connect with the raw config, but show warnings
					try {
						await this.updateServerConnections(config.mcpServers || {}, source, false)
					} catch (error) {
						this.showErrorMessage(`Failed to initialize ${source} MCP servers with raw config`, error)
					}
				}
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, error)
				vscode.window.showErrorMessage(errorMessage)
			} else {
				this.showErrorMessage(`Failed to initialize ${source} MCP servers`, error)
			}
		}
	}

	private async initializeGlobalMcpServers(): Promise<void> {
		await this.initializeMcpServers("global")
	}

	// Get project-level MCP configuration path
	private async getProjectMcpPath(): Promise<string | null> {
		const workspacePath = this.getProvider()?.cwd ?? getWorkspacePath()
		const projectMcpPath = await getProjectMcpConfigPath(workspacePath)

		try {
			await fs.access(projectMcpPath)
			return projectMcpPath
		} catch {
			return null
		}
	}

	// Initialize project-level MCP servers
	private async initializeProjectMcpServers(): Promise<void> {
		await this.initializeMcpServers("project")
	}

	/**
	 * Creates a placeholder connection for disabled servers or when MCP is globally disabled
	 * @param name The server name
	 * @param config The server configuration
	 * @param source The source of the server (global or project)
	 * @param reason The reason for creating a placeholder (mcpDisabled or serverDisabled)
	 * @returns A placeholder DisconnectedMcpConnection object
	 */
	private createPlaceholderConnection(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project",
		reason: DisableReason,
	): DisconnectedMcpConnection {
		return {
			type: "disconnected",
			server: {
				name,
				config: JSON.stringify(config),
				status: "disconnected",
				disabled: reason === DisableReason.SERVER_DISABLED ? true : config.disabled,
				source,
				projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
				errorHistory: [],
			},
			client: null,
			transport: null,
		}
	}

	/**
	 * Checks if MCP is globally enabled
	 * @returns Promise<boolean> indicating if MCP is enabled
	 */
	private async isMcpEnabled(): Promise<boolean> {
		const provider = this.getProvider()
		if (!provider) {
			return true // Default to enabled if provider is not available
		}
		const state = await provider.getState()
		return state.mcpEnabled ?? true
	}

	private beginConnectionAttempt(name: string, source: "global" | "project"): AbortController {
		if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
		const key = `${source}:${name}`
		this.connectionAttempts.get(key)?.abort()
		const controller = new AbortController()
		this.connectionAttempts.set(key, controller)
		return controller
	}

	private async connectToServer(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
		attempt?: AbortController,
	): Promise<void> {
		if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
		const key = `${source}:${name}`
		const controller = attempt ?? this.beginConnectionAttempt(name, source)
		try {
			controller.signal.throwIfAborted()
			if (this.connectionAttempts.get(key) !== controller)
				throw new DOMException("MCP connection attempt was superseded", "AbortError")
			await this.disconnectConnections(name, source)
			controller.signal.throwIfAborted()
			await this.connectServerAttempt(name, config, source, controller.signal)
		} finally {
			if (this.connectionAttempts.get(key) === controller) this.connectionAttempts.delete(key)
		}
	}

	private async connectServerAttempt(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project",
		signal: AbortSignal,
	): Promise<void> {
		// Register the sanitized name for O(1) lookup
		const sanitizedName = sanitizeMcpName(name)
		this.sanitizedNameRegistry.set(sanitizedName, name)

		// Check if MCP is globally enabled
		const mcpEnabled = await requestWithAbort(() => this.isMcpEnabled(), signal)
		signal.throwIfAborted()
		if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
		if (!mcpEnabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.MCP_DISABLED)
			this.connections.push(connection)
			return
		}

		// Skip connecting to disabled servers
		if (config.disabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.SERVER_DISABLED)
			this.connections.push(connection)
			return
		}

		// Set up file watchers for enabled servers
		this.setupFileWatcher(name, config, source)

		let connectingConnection: ConnectedMcpConnection | undefined
		let provisionalClient: Client | undefined
		let provisionalTransport: ConnectedMcpConnection["transport"] | undefined
		try {
			const client = new Client(
				{
					name: "Alpha",
					version: this.getProvider()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)
			provisionalClient = client

			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

			// Inject variables to the config (environment, magic variables,...)
			const configInjected = (await requestWithAbort(
				() =>
					injectVariables(config, {
						env: process.env,
						workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
					}),
				signal,
			)) as typeof config
			signal.throwIfAborted()

			if (configInjected.type === "stdio") {
				// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
				// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
				// commands as PowerShell scripts rather than executables.
				// Note: This adds a small overhead as commands go through an additional shell layer.
				const isWindows = process.platform === "win32"

				// Check if command is already cmd.exe to avoid double-wrapping
				const isAlreadyWrapped =
					configInjected.command.toLowerCase() === "cmd.exe" || configInjected.command.toLowerCase() === "cmd"

				const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : configInjected.command
				const args =
					isWindows && !isAlreadyWrapped
						? ["/c", configInjected.command, ...(configInjected.args || [])]
						: configInjected.args

				transport = new StdioClientTransport({
					command,
					args,
					cwd: configInjected.cwd,
					env: {
						...getDefaultEnvironment(),
						...(configInjected.env || {}),
					},
					stderr: "pipe",
				})
				provisionalTransport = transport

				// Set up stdio specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						await this.notifyWebviewOfServerChanges()
					}
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						await this.notifyWebviewOfServerChanges()
					}
				}

				// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
				// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
				const startingTransport = transport
				const started = startingTransport.start()
				void started
					.then(
						() => (signal.aborted ? startingTransport.close() : undefined),
						() => undefined,
					)
					.catch((error) => console.error(`Failed to close cancelled MCP transport for ${name}:`, error))
				await requestWithAbort(() => started, signal)
				signal.throwIfAborted()
				const stderrStream = transport.stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						// Check if output contains INFO level log
						const isInfoLog = /INFO/i.test(output)

						if (isInfoLog) {
							// Log normal informational messages
							console.log(`Server "${name}" info:`, output)
						} else {
							// Treat as error log
							console.error(`Server "${name}" stderr:`, output)
							const connection = this.findConnection(name, source)
							if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
								this.appendErrorMessage(connection, output)
								if (connection.server.status === "disconnected") {
									await this.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					console.error(`No stderr stream for ${name}`)
				}
			} else if (configInjected.type === "streamable-http") {
				// Streamable HTTP connection
				transport = new StreamableHTTPClientTransport(new URL(configInjected.url), {
					requestInit: {
						headers: configInjected.headers,
					},
				})
				provisionalTransport = transport

				// Set up Streamable HTTP specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}" (streamable-http):`, error)
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						await this.notifyWebviewOfServerChanges()
					}
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						await this.notifyWebviewOfServerChanges()
					}
				}
			} else if (configInjected.type === "sse") {
				// SSE connection
				const sseOptions = {
					requestInit: {
						headers: configInjected.headers,
					},
				}
				// Configure ReconnectingEventSource options
				const reconnectingEventSourceOptions = {
					max_retry_time: 5000, // Maximum retry time in milliseconds
					withCredentials: configInjected.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
					fetch: (url: string | URL, init: RequestInit) => {
						const headers = new Headers({ ...(init?.headers || {}), ...(configInjected.headers || {}) })
						return fetch(url, {
							...init,
							headers,
						})
					},
				}
				global.EventSource = ReconnectingEventSource
				transport = new SSEClientTransport(new URL(configInjected.url), {
					...sseOptions,
					eventSourceInit: reconnectingEventSourceOptions,
				})
				provisionalTransport = transport

				// Set up SSE specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						await this.notifyWebviewOfServerChanges()
					}
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection?.type === "connected" && connection.client === client && !this.isDisposed) {
						connection.server.status = "disconnected"
						this.cancelConnectionRequests(connection)
						await this.notifyWebviewOfServerChanges()
					}
				}
			} else {
				// Should not happen if validateServerConfig is correct
				throw new Error(`Unsupported MCP server type: ${(configInjected as any).type}`)
			}

			// Only override transport.start for stdio transports that have already been started
			if (configInjected.type === "stdio") {
				transport.start = async () => {}
			}

			// Create a connected connection
			signal.throwIfAborted()
			if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
			const connection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name,
					config: JSON.stringify(configInjected),
					status: "connecting",
					disabled: configInjected.disabled,
					source,
					projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
					errorHistory: [],
				},
				client,
				transport,
			}
			this.connections.push(connection)
			connectingConnection = connection
			const lifecycleController = new AbortController()
			this.connectionControllers.set(connection, lifecycleController)
			const connectionSignal = AbortSignal.any([signal, lifecycleController.signal])
			// The SDK owns transport callbacks after connect; forward lifecycle events through the client.
			client.onclose = transport.onclose
			client.onerror = (error) => {
				// Protocol diagnostics include late responses to cancelled requests and are nonfatal.
				if (!this.isDisposed && this.connections.includes(connection)) {
					console.error(`MCP protocol error for ${name}:`, error)
				}
			}
			const onTransportError = transport.onerror
			client.setNotificationHandler?.(ToolListChangedNotificationSchema, () =>
				this.queueCatalogRefresh(connection),
			)
			client.setNotificationHandler?.(ResourceListChangedNotificationSchema, () =>
				this.queueCatalogRefresh(connection),
			)

			// Connect (this will automatically start the transport)
			await requestWithAbort(() => {
				const connecting = client.connect(transport, { signal: connectionSignal })
				const onProtocolTransportError = transport.onerror
				transport.onerror = async (error) => {
					onProtocolTransportError?.(error)
					await onTransportError?.(error)
				}
				return connecting
			}, connectionSignal)
			this.assertConnectionCurrent(connection, connectionSignal)
			await this.waitForCurrentCatalog(connection, this.refreshServerCatalog(connection))
			this.assertConnectionCurrent(connection, connectionSignal)
			connection.server.instructions = client.getInstructions()
			connection.server.error = ""
			connection.server.status = "connected"
		} catch (error) {
			// Update status with error
			const connection = connectingConnection
			if (connection && this.connections.includes(connection) && !this.isDisposed) {
				const alreadyDisconnected = connection.server.status === "disconnected"
				connection.server.status = "disconnected"
				const message = error instanceof Error ? error.message : String(error)
				if ((!alreadyDisconnected || !connection.server.error) && connection.server.error !== message) {
					this.appendErrorMessage(connection, message)
				}
				this.cancelConnectionRequests(connection)
			}
			if (this.connectionAttempts.get(`${source}:${name}`)?.signal === signal) {
				this.removeFileWatchersForServer(name, source)
			}
			await Promise.allSettled([provisionalClient?.close(), provisionalTransport?.close()])
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string, level: "error" | "warn" | "info" = "error") {
		const MAX_ERROR_LENGTH = 1000
		const truncatedError =
			error.length > MAX_ERROR_LENGTH
				? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)`
				: error

		// Add to error history
		if (!connection.server.errorHistory) {
			connection.server.errorHistory = []
		}

		connection.server.errorHistory.push({
			message: truncatedError,
			timestamp: Date.now(),
			level,
		})

		// Keep only the last 100 errors
		if (connection.server.errorHistory.length > 100) {
			connection.server.errorHistory = connection.server.errorHistory.slice(-100)
		}

		// Update current error display
		connection.server.error = truncatedError
	}

	/**
	 * Helper method to find a connection by server name and source
	 * @param serverName The name of the server to find
	 * @param source Optional source to filter by (global or project)
	 * @returns The matching connection or undefined if not found
	 */
	private findConnection(serverName: string, source?: "global" | "project"): McpConnection | undefined {
		// If source is specified, only find servers with that source
		if (source !== undefined) {
			return this.connections.find((conn) => conn.server.name === serverName && conn.server.source === source)
		}

		// If no source is specified, first look for project servers, then global servers
		// This ensures that when servers have the same name, project servers are prioritized
		const projectConn = this.connections.find(
			(conn) => conn.server.name === serverName && conn.server.source === "project",
		)
		if (projectConn) return projectConn

		// If no project server is found, look for global servers
		return this.connections.find(
			(conn) => conn.server.name === serverName && (conn.server.source === "global" || !conn.server.source),
		)
	}

	/**
	 * Find a connection by sanitized server name.
	 * This is used when parsing MCP tool responses where the server name has been
	 * sanitized (e.g., hyphens replaced with underscores) for API compliance.
	 * Uses fuzzy matching to handle cases where models convert hyphens to underscores.
	 * @param sanitizedServerName The sanitized server name from the API tool call
	 * @returns The original server name if found, or null if no match
	 */
	public findServerNameBySanitizedName(sanitizedServerName: string): string | null {
		// First, check for an exact match
		const exactMatch = this.connections.find((conn) => conn.server.name === sanitizedServerName)
		if (exactMatch) {
			return exactMatch.server.name
		}

		// Check the registry for sanitized name mapping
		const registryMatch = this.sanitizedNameRegistry.get(sanitizedServerName)
		if (registryMatch) {
			return registryMatch
		}

		// Use fuzzy matching: treat hyphens and underscores as equivalent
		const fuzzyMatch = this.connections.find((conn) => toolNamesMatch(conn.server.name, sanitizedServerName))
		if (fuzzyMatch) {
			return fuzzyMatch.server.name
		}

		return null
	}

	private assertConnectionCurrent(connection: ConnectedMcpConnection, signal?: AbortSignal): void {
		signal?.throwIfAborted()
		if (
			this.isDisposed ||
			!this.connections.includes(connection) ||
			connection.server.disabled ||
			connection.server.status === "disconnected"
		) {
			throw new DOMException("MCP connection is no longer available", "AbortError")
		}
	}

	private getConnectionSignal(connection: ConnectedMcpConnection, signal?: AbortSignal): AbortSignal {
		this.assertConnectionCurrent(connection, signal)
		let controller = this.connectionControllers.get(connection)
		if (!controller) {
			controller = new AbortController()
			this.connectionControllers.set(connection, controller)
		}
		return signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
	}

	private cancelConnectionRequests(connection: ConnectedMcpConnection): void {
		this.connectionControllers.get(connection)?.abort()
		this.connectionControllers.delete(connection)
		this.catalogRefreshControllers.get(connection)?.controller.abort()
		this.catalogRefreshControllers.delete(connection)
		this.catalogChanges.delete(connection)
	}

	private async waitForCurrentCatalog(connection: ConnectedMcpConnection, refresh: Promise<void>): Promise<void> {
		while (true) {
			let failure: unknown
			let failed = false
			try {
				await refresh
			} catch (error) {
				failure = error
				failed = true
			}
			this.assertConnectionCurrent(connection, this.connectionControllers.get(connection)?.signal)
			const queued = this.catalogChanges.get(connection)
			if (queued) await queued.promise
			this.assertConnectionCurrent(connection, this.connectionControllers.get(connection)?.signal)
			const latest = this.latestCatalogRefresh.get(connection)
			if (!latest || latest === refresh) {
				if (failed) throw failure
				return
			}
			refresh = latest
		}
	}

	/** Coalesce notifications into one owned refresh and at most one requested follow-up. */
	private queueCatalogRefresh(connection: ConnectedMcpConnection): Promise<void> {
		if (this.isDisposed || !this.connections.includes(connection) || connection.server.status === "disconnected") {
			return Promise.resolve()
		}
		// Codex CLI 970111f6 (2026-10-26): invalidate bindings before a later response can resume inference.
		this.catalogRevisions.set(connection, (this.catalogRevisions.get(connection) ?? 0) + 1)
		this.catalogRefreshControllers.get(connection)?.controller.abort()
		const queued = this.catalogChanges.get(connection)
		if (queued) {
			queued.requested = true
			return queued.promise
		}
		const entry = { requested: true, promise: Promise.resolve() }
		this.catalogChanges.set(connection, entry)
		entry.promise = (async () => {
			// A microtask boundary coalesces a burst without retaining timers after disposal.
			await Promise.resolve()
			try {
				while (entry.requested && this.catalogChanges.get(connection) === entry) {
					entry.requested = false
					try {
						await this.refreshServerCatalog(connection)
					} catch (error) {
						if (this.catalogChanges.get(connection) !== entry || entry.requested) continue
						console.error(`Failed to refresh MCP catalog for ${connection.server.name}:`, error)
					}
					if (!this.isDisposed && this.connections.includes(connection)) {
						await this.notifyWebviewOfServerChanges()
					}
				}
			} finally {
				if (this.catalogChanges.get(connection) === entry) this.catalogChanges.delete(connection)
			}
		})()
		return entry.promise
	}

	/** Publish a catalog only after every required page and identity check succeeds. */
	private refreshServerCatalog(connection: ConnectedMcpConnection, toolsOnly = false): Promise<void> {
		const lifecycleSignal = this.getConnectionSignal(connection)
		const previous = this.catalogRefreshControllers.get(connection)
		// Grant changes cannot supersede a required full discovery with a tools-only catalog.
		toolsOnly =
			toolsOnly &&
			connection.server.status !== "connecting" &&
			!previous?.full &&
			!this.catalogChanges.has(connection) &&
			!this.catalogErrors.has(connection)
		previous?.controller.abort()
		const controller = new AbortController()
		this.catalogRefreshControllers.set(connection, { controller, full: !toolsOnly })
		const signal = AbortSignal.any([lifecycleSignal, controller.signal])
		const refresh = (async () => {
			try {
				const tools = await this.fetchToolsList(
					connection.server.name,
					connection.server.source,
					signal,
					connection,
				)
				const resources = toolsOnly ? undefined : await this.fetchResourcesList(connection, signal)
				const resourceTemplates = toolsOnly
					? undefined
					: await this.fetchResourceTemplatesList(connection, signal)
				this.assertConnectionCurrent(connection, signal)
				connection.server.tools = tools
				if (!toolsOnly) {
					connection.server.resources = resources
					connection.server.resourceTemplates = resourceTemplates
				}
				if (connection.server.error === this.catalogErrors.get(connection)) connection.server.error = ""
				this.catalogErrors.delete(connection)
			} catch (error) {
				if (!signal.aborted && !this.isDisposed && this.connections.includes(connection)) {
					this.appendErrorMessage(connection, error instanceof Error ? error.message : String(error))
					if (connection.server.error !== undefined)
						this.catalogErrors.set(connection, connection.server.error)
				}
				throw error
			} finally {
				if (this.catalogRefreshControllers.get(connection)?.controller === controller) {
					this.catalogRefreshControllers.delete(connection)
				}
			}
		})()
		this.latestCatalogRefresh.set(connection, refresh)
		return refresh
	}

	private async fetchToolsList(
		serverName: string,
		source?: "global" | "project",
		signal?: AbortSignal,
		connection = this.findConnection(serverName, source),
	): Promise<McpTool[]> {
		if (!connection || connection.type !== "connected")
			throw new Error(`No connection found for server: ${serverName}`)
		return this.fetchConnectionTools(connection, this.getConnectionSignal(connection, signal))
	}

	private async fetchConnectionTools(connection: ConnectedMcpConnection, signal: AbortSignal): Promise<McpTool[]> {
		this.assertConnectionCurrent(connection, signal)
		const capabilities = connection.client.getServerCapabilities?.()
		if (capabilities && !capabilities.tools) return []
		let hasTools = false
		let grants: Pick<z.infer<typeof BaseConfigSchema>, "alwaysAllow" | "disabledTools"> = {
			alwaysAllow: [],
			disabledTools: [],
		}
		const listedTools = await collectPaginatedCatalog(
			"tools/list",
			async (params, pageSignal) => {
				this.assertConnectionCurrent(connection, pageSignal)
				const response = await connection.client.request(
					params ? { method: "tools/list", params } : { method: "tools/list" },
					ListToolsResultSchema,
					{ signal: pageSignal },
				)
				hasTools ||= response.tools.length > 0
				if (response.nextCursor === undefined && hasTools) {
					// Keep local policy projection inside the same overall catalog deadline.
					grants = await this.readToolGrants(connection, pageSignal)
				}
				return { items: response.tools, nextCursor: response.nextCursor }
			},
			{ signal },
		)
		this.assertConnectionCurrent(connection, signal)
		const hasWildcard = grants.alwaysAllow.includes("*")
		return listedTools.map((tool) => ({
			...tool,
			alwaysAllow: hasWildcard || grants.alwaysAllow.includes(tool.name),
			enabledForPrompt: !grants.disabledTools.includes(tool.name),
		}))
	}

	private async readToolGrants(
		connection: ConnectedMcpConnection,
		signal: AbortSignal,
	): Promise<Pick<z.infer<typeof BaseConfigSchema>, "alwaysAllow" | "disabledTools">> {
		const serverName = connection.server.name
		try {
			const configPath =
				connection.server.source === "project"
					? await this.getProjectMcpPath()
					: await this.getMcpSettingsFilePath()
			signal.throwIfAborted()
			if (!configPath) throw new Error("MCP configuration path is unavailable")
			const content = await requestWithAbort(() => fs.readFile(configPath, "utf-8"), signal)
			const serverConfigData = JSON.parse(content)
			const serverConfig = serverConfigData.mcpServers?.[serverName]
			if (!serverConfig) throw new Error("MCP server configuration is unavailable")
			this.assertConnectionCurrent(connection, signal)
			return BaseConfigSchema.parse(serverConfig)
		} catch (error) {
			signal.throwIfAborted()
			throw new Error(`Failed to read tool configuration for ${serverName}`, { cause: error })
		}
	}

	private async fetchResourcesList(connection: ConnectedMcpConnection, signal: AbortSignal): Promise<McpResource[]> {
		this.assertConnectionCurrent(connection, signal)
		const capabilities = connection.client.getServerCapabilities?.()
		if (capabilities && !capabilities.resources) return []
		return collectPaginatedCatalog(
			"resources/list",
			async (params, pageSignal) => {
				this.assertConnectionCurrent(connection, pageSignal)
				const response = await connection.client.request(
					params ? { method: "resources/list", params } : { method: "resources/list" },
					ListResourcesResultSchema,
					{ signal: pageSignal },
				)
				return { items: response.resources, nextCursor: response.nextCursor }
			},
			{ signal },
		)
	}

	private async fetchResourceTemplatesList(
		connection: ConnectedMcpConnection,
		signal: AbortSignal,
	): Promise<McpResourceTemplate[]> {
		this.assertConnectionCurrent(connection, signal)
		const capabilities = connection.client.getServerCapabilities?.()
		if (capabilities && !capabilities.resources) return []
		return collectPaginatedCatalog(
			"resources/templates/list",
			async (params, pageSignal) => {
				this.assertConnectionCurrent(connection, pageSignal)
				const response = await connection.client.request(
					params ? { method: "resources/templates/list", params } : { method: "resources/templates/list" },
					ListResourceTemplatesResultSchema,
					{ signal: pageSignal },
				)
				return { items: response.resourceTemplates, nextCursor: response.nextCursor }
			},
			{ signal },
		)
	}

	async deleteConnection(name: string, source?: "global" | "project"): Promise<void> {
		for (const candidateSource of source ? [source] : ["global", "project"]) {
			const key = `${candidateSource}:${name}`
			this.connectionAttempts.get(key)?.abort()
			this.connectionAttempts.delete(key)
		}
		await this.disconnectConnections(name, source)
	}

	private async disconnectConnections(name: string, source?: "global" | "project"): Promise<void> {
		// Clean up file watchers for this server
		this.removeFileWatchersForServer(name, source)

		// If source is provided, only delete connections from that source
		const connections = source
			? this.connections.filter((conn) => conn.server.name === name && conn.server.source === source)
			: this.connections.filter((conn) => conn.server.name === name)

		// Detach before awaiting transport teardown so late callbacks cannot target a replacement.
		const removed = new Set(connections)
		this.connections = this.connections.filter((connection) => !removed.has(connection))
		for (const connection of connections) {
			if (connection.type === "connected") this.cancelConnectionRequests(connection)
		}

		for (const connection of connections) {
			try {
				if (connection.type === "connected") {
					await connection.transport.close()
					await connection.client.close()
				}
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
		}

		// Remove from sanitized name registry if no more connections with this name exist
		const remainingConnections = this.connections.filter((conn) => conn.server.name === name)
		if (remainingConnections.length === 0) {
			const sanitizedName = sanitizeMcpName(name)
			this.sanitizedNameRegistry.delete(sanitizedName)
		}
	}

	async updateServerConnections(
		newServers: Record<string, any>,
		source: "global" | "project" = "global",
		manageConnectingState: boolean = true,
	): Promise<void> {
		if (manageConnectingState) {
			this.isConnecting = true
		}
		// Filter connections by source
		const currentConnections = this.connections.filter(
			(conn) => conn.server.source === source || (!conn.server.source && source === "global"),
		)
		const currentNames = new Set(currentConnections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name, source)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			// Only consider connections that match the current source
			const currentConnection = this.findConnection(name, source)

			// Validate and transform the config
			let validatedConfig: z.infer<typeof ServerConfigSchema>
			try {
				validatedConfig = this.validateServerConfig(config, name)
			} catch (error) {
				this.showErrorMessage(`Invalid configuration for MCP server "${name}"`, error)
				continue
			}

			if (!currentConnection) {
				// New server
				try {
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to connect to new MCP server ${name}`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					await this.deleteConnection(name, source)
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to reconnect MCP server ${name}`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		if (manageConnectingState) {
			this.isConnecting = false
		}
	}

	private setupFileWatcher(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
	) {
		const watcherKey = `${source}:${name}`
		// Initialize an empty array for this server if it doesn't exist
		if (!this.fileWatchers.has(watcherKey)) {
			this.fileWatchers.set(watcherKey, [])
		}

		const watchers = this.fileWatchers.get(watcherKey) || []

		// Only stdio type has args
		if (config.type === "stdio") {
			// Setup watchers for custom watchPaths if defined
			if (config.watchPaths && config.watchPaths.length > 0) {
				const watchPathsWatcher = chokidar.watch(config.watchPaths, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true,
				})

				watchPathsWatcher.on("change", async (changedPath) => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${changedPath}:`, error)
					}
				})

				watchers.push(watchPathsWatcher)
			}

			// Also setup the fallback build/index.js watcher if applicable
			const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
			if (filePath) {
				// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor
				const indexJsWatcher = chokidar.watch(filePath, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true, // This helps with atomic writes
				})

				indexJsWatcher.on("change", async () => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${filePath}:`, error)
					}
				})

				watchers.push(indexJsWatcher)
			}

			// Update the fileWatchers map with all watchers for this server
			if (watchers.length > 0) {
				this.fileWatchers.set(watcherKey, watchers)
			}
		}
	}

	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.fileWatchers.clear()
	}

	private removeFileWatchersForServer(serverName: string, source?: "global" | "project") {
		const keys = source ? [`${source}:${serverName}`] : [`global:${serverName}`, `project:${serverName}`]
		for (const key of keys) {
			const watchers = this.fileWatchers.get(key)
			if (watchers) {
				watchers.forEach((watcher) => watcher.close())
				this.fileWatchers.delete(key)
			}
		}
	}

	async restartConnection(serverName: string, source?: "global" | "project"): Promise<void> {
		this.isConnecting = true
		const connection = this.findConnection(serverName, source)
		if (!connection) {
			this.isConnecting = this.connectionAttempts.size > 0
			return
		}
		const serverSource = connection.server.source ?? "global"
		const key = `${serverSource}:${serverName}`
		const controller = this.beginConnectionAttempt(serverName, serverSource)
		const signal = controller.signal
		const assertCurrent = () => {
			signal.throwIfAborted()
			if (
				this.isDisposed ||
				this.findConnection(serverName, serverSource) !== connection ||
				connection.server.disabled
			)
				throw new DOMException("MCP restart is no longer current", "AbortError")
		}
		try {
			if (!(await requestWithAbort(() => this.isMcpEnabled(), signal))) return
			assertCurrent()
			vscode.window.showInformationMessage(t("mcp:info.server_restarting", { serverName }))
			connection.server.status = "connecting"
			connection.server.error = ""
			await requestWithAbort(() => this.notifyWebviewOfServerChanges(), signal)
			assertCurrent()
			await delay(500, { signal })
			assertCurrent()
			const config = await requestWithAbort(() => this.readServerConfigFromFile(serverName, serverSource), signal)
			assertCurrent()
			// Retain this attempt's ownership through teardown and startup, rather than admitting a stale restart anew.
			await this.connectToServer(serverName, config, serverSource, controller)
			if (this.findConnection(serverName, serverSource)?.server.status === "connected")
				vscode.window.showInformationMessage(t("mcp:info.server_connected", { serverName }))
		} catch (error) {
			if (!signal.aborted) this.showErrorMessage(`Failed to restart ${serverName} MCP server connection`, error)
		} finally {
			if (this.connectionAttempts.get(key) === controller) this.connectionAttempts.delete(key)
			this.isConnecting = this.connectionAttempts.size > 0
		}
		if (!this.isDisposed) await this.notifyWebviewOfServerChanges()
	}

	public async refreshAllConnections(): Promise<void> {
		if (this.isConnecting) {
			return
		}

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Clear all existing connections
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Still initialize servers to track them, but they won't connect
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await this.notifyWebviewOfServerChanges()
			return
		}

		this.isConnecting = true

		try {
			const globalPath = await this.getMcpSettingsFilePath()
			let globalServers: Record<string, any> = {}
			try {
				const globalContent = await fs.readFile(globalPath, "utf-8")
				const globalConfig = JSON.parse(globalContent)
				globalServers = globalConfig.mcpServers || {}
				const globalServerNames = Object.keys(globalServers)
			} catch (error) {
				console.log("Error reading global MCP config:", error)
			}

			const projectPath = await this.getProjectMcpPath()
			let projectServers: Record<string, any> = {}
			if (projectPath) {
				try {
					const projectContent = await fs.readFile(projectPath, "utf-8")
					const projectConfig = JSON.parse(projectContent)
					projectServers = projectConfig.mcpServers || {}
					const projectServerNames = Object.keys(projectServers)
				} catch (error) {
					console.log("Error reading project MCP config:", error)
				}
			}

			// Clear all existing connections first
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize all servers from scratch
			// This ensures proper initialization including fetching tools, resources, etc.
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await delay(100)

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage("Failed to refresh MCP servers", error)
		} finally {
			this.isConnecting = false
		}
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		// Get global server order from settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const globalServerOrder = Object.keys(config.mcpServers || {})

		// Get project server order if available
		const projectMcpPath = await this.getProjectMcpPath()
		let projectServerOrder: string[] = []
		if (projectMcpPath) {
			try {
				const projectContent = await fs.readFile(projectMcpPath, "utf-8")
				const projectConfig = JSON.parse(projectContent)
				projectServerOrder = Object.keys(projectConfig.mcpServers || {})
			} catch (error) {
				// Silently continue with empty project server order
			}
		}

		// Sort connections: first project servers in their defined order, then global servers in their defined order
		// This ensures that when servers have the same name, project servers are prioritized
		const sortedConnections = [...this.connections].sort((a, b) => {
			const aIsGlobal = a.server.source === "global" || !a.server.source
			const bIsGlobal = b.server.source === "global" || !b.server.source

			// If both are global or both are project, sort by their respective order
			if (aIsGlobal && bIsGlobal) {
				const indexA = globalServerOrder.indexOf(a.server.name)
				const indexB = globalServerOrder.indexOf(b.server.name)
				return indexA - indexB
			} else if (!aIsGlobal && !bIsGlobal) {
				const indexA = projectServerOrder.indexOf(a.server.name)
				const indexB = projectServerOrder.indexOf(b.server.name)
				return indexA - indexB
			}

			// Project servers come before global servers (reversed from original)
			return aIsGlobal ? 1 : -1
		})

		const message = {
			type: "mcpServers" as const,
			mcpServers: sortedConnections.map((connection) => connection.server),
		}
		if (this.options.notifyProviders) {
			await this.options.notifyProviders(message)
			return
		}
		const targetProvider = this.getProvider()

		if (targetProvider) {
			try {
				await targetProvider.postMessageToWebview(message)
			} catch (error) {
				console.error("[McpHub] Error calling targetProvider.postMessageToWebview:", error)
			}
		} else {
			console.error(
				"[McpHub] No target provider available (neither from getInstance nor providerRef) - cannot send mcpServers message to webview",
			)
		}
	}

	public async toggleServerDisabled(
		serverName: string,
		disabled: boolean,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { disabled }, serverSource)

			// Update the connection object
			if (connection) {
				try {
					connection.server.disabled = disabled

					// If disabling a connected server, disconnect it
					if (disabled && connection.type === "connected") {
						// Clean up file watchers when disabling
						this.removeFileWatchersForServer(serverName, serverSource)
						await this.deleteConnection(serverName, serverSource)
						// Re-add as a disabled connection
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (!disabled && connection.server.status === "disconnected") {
						// If enabling a disabled server, connect it
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.deleteConnection(serverName, serverSource)
						// When re-enabling, file watchers will be set up in connectToServer
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (connection.type === "connected" && connection.server.status === "connected") {
						await this.refreshServerCatalog(connection)
					}
				} catch (error) {
					console.error(`Failed to refresh capabilities for ${serverName}:`, error)
					throw error
				}
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} state`, error)
			throw error
		}
	}

	/**
	 * Helper method to read a server's configuration from the appropriate settings file
	 * @param serverName The name of the server to read
	 * @param source Whether to read from the global or project config
	 * @returns The validated server configuration
	 */
	private async readServerConfigFromFile(
		serverName: string,
		source: "global" | "project" = "global",
	): Promise<z.infer<typeof ServerConfigSchema>> {
		// Determine which config file to read
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			console.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			throw new Error("No mcpServers section in config")
		}

		if (!config.mcpServers[serverName]) {
			throw new Error(`Server ${serverName} not found in config`)
		}

		// Validate and return the server config
		return this.validateServerConfig(config.mcpServers[serverName], serverName)
	}

	/**
	 * Helper method to update a server's configuration in the appropriate settings file
	 * @param serverName The name of the server to update
	 * @param configUpdate The configuration updates to apply
	 * @param source Whether to update the global or project config
	 */
	private async updateServerConfig(
		serverName: string,
		configUpdate: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>),
		source: "global" | "project" = "global",
	): Promise<Record<string, unknown>> {
		// Determine which config file to update
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		let committedConfig: Record<string, unknown> | undefined
		await this.updateMcpSettings(configPath, (settings) => {
			const current = settings.mcpServers[serverName]
			if (!current || typeof current !== "object" || Array.isArray(current))
				throw new Error(`Server ${serverName} not found in config`)
			const updated =
				typeof configUpdate === "function"
					? configUpdate(current as Record<string, unknown>)
					: { ...current, ...configUpdate }
			BaseConfigSchema.parse(updated)
			settings.mcpServers[serverName] = updated
			committedConfig = updated
		})
		if (!committedConfig) throw new Error(`Server ${serverName} configuration was not updated`)
		return committedConfig
	}

	private async updateMcpSettings(
		configPath: string,
		update: (settings: z.infer<typeof McpSettingsFileSchema>) => void,
	): Promise<void> {
		this.pendingConfigUpdates++
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
			this.flagResetTimer = undefined
		}
		this.isProgrammaticUpdate = true
		try {
			await safeWriteJson(configPath, undefined, {
				prettyPrint: true,
				prepareData: async () => {
					if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
					// Read and merge under the destination's existing write lease so another view cannot restore revoked grants.
					const settings = McpSettingsFileSchema.parse(JSON.parse(await fs.readFile(configPath, "utf-8")))
					if (this.isDisposed) throw new DOMException("MCP hub is disposed", "AbortError")
					update(settings)
					return settings
				},
			})
		} finally {
			this.pendingConfigUpdates--
			if (this.isDisposed) this.isProgrammaticUpdate = false
			else if (this.pendingConfigUpdates === 0) {
				this.flagResetTimer = setTimeout(() => {
					this.isProgrammaticUpdate = false
					this.flagResetTimer = undefined
				}, 600)
			}
		}
	}

	public async updateServerTimeout(
		serverName: string,
		timeout: number,
		source?: "global" | "project",
	): Promise<void> {
		try {
			timeout = BaseConfigSchema.shape.timeout.parse(timeout)
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			// Update the server config in the appropriate file
			const committed = await this.updateServerConfig(
				serverName,
				{ timeout },
				connection.server.source || "global",
			)
			const current = this.findConnection(serverName, connection.server.source)
			if (current) {
				const liveConfig = current.server.config ? JSON.parse(current.server.config) : committed
				current.server.config = JSON.stringify({ ...liveConfig, timeout })
				current.server.timeout = timeout
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
			throw error
		}
	}

	public async deleteServer(serverName: string, source?: "global" | "project"): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			// Determine config file based on server source
			const isProjectServer = serverSource === "project"
			let configPath: string

			if (isProjectServer) {
				// Get project MCP config path
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				// Get global MCP settings path
				configPath = await this.getMcpSettingsFilePath()
			}

			let removed = false
			await this.updateMcpSettings(configPath, (settings) => {
				removed = Object.hasOwn(settings.mcpServers, serverName)
				delete settings.mcpServers[serverName]
			})
			// Only retire this source; an earlier whole-file snapshot could replace another view's update.
			await this.deleteConnection(serverName, serverSource)
			await this.notifyWebviewOfServerChanges()
			if (removed) {
				vscode.window.showInformationMessage(t("mcp:info.server_deleted", { serverName }))
			} else {
				vscode.window.showWarningMessage(t("mcp:info.server_not_found", { serverName }))
			}
		} catch (error) {
			this.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
			throw error
		}
	}

	async listResources(serverName: string, cursor?: string, source?: "global" | "project", signal?: AbortSignal) {
		validateMcpPaginationCursor("resources/list", cursor)
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected" || connection.server.disabled) {
			throw new Error(`No enabled connection found for server: ${serverName}`)
		}
		const requestSignal = this.getConnectionSignal(connection, signal)
		const request =
			cursor !== undefined
				? { method: "resources/list" as const, params: { cursor } }
				: { method: "resources/list" as const }
		const response = await requestWithAbort(
			() => connection.client.request(request, ListResourcesResultSchema, { signal: requestSignal }),
			requestSignal,
		)
		this.assertConnectionCurrent(connection, requestSignal)
		validateMcpPaginationCursor("resources/list", response.nextCursor)
		if (response.resources.length > MAX_MCP_CATALOG_ITEMS)
			throw new Error("resources/list exceeded the catalog item limit")
		return response
	}

	async listResourceTemplates(
		serverName: string,
		cursor?: string,
		source?: "global" | "project",
		signal?: AbortSignal,
	) {
		validateMcpPaginationCursor("resources/templates/list", cursor)
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected" || connection.server.disabled) {
			throw new Error(`No enabled connection found for server: ${serverName}`)
		}
		const requestSignal = this.getConnectionSignal(connection, signal)
		const request =
			cursor !== undefined
				? { method: "resources/templates/list" as const, params: { cursor } }
				: { method: "resources/templates/list" as const }
		const response = await requestWithAbort(
			() => connection.client.request(request, ListResourceTemplatesResultSchema, { signal: requestSignal }),
			requestSignal,
		)
		this.assertConnectionCurrent(connection, requestSignal)
		validateMcpPaginationCursor("resources/templates/list", response.nextCursor)
		if (response.resourceTemplates.length > MAX_MCP_CATALOG_ITEMS)
			throw new Error("resources/templates/list exceeded the catalog item limit")
		return response
	}

	async readResource(
		serverName: string,
		uri: string,
		source?: "global" | "project",
		signal?: AbortSignal,
	): Promise<McpResourceResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		const requestSignal = this.getConnectionSignal(connection, signal)
		const request = {
			method: "resources/read" as const,
			params: {
				uri,
			},
		}
		const response = await requestWithAbort(
			() => connection.client.request(request, ReadResourceResultSchema, { signal: requestSignal }),
			requestSignal,
		)
		this.assertConnectionCurrent(connection, requestSignal)
		return response
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
		source?: "global" | "project",
		signal?: AbortSignal,
	): Promise<McpToolCallResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(
				`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout: number
		try {
			const parsedConfig = ServerConfigSchema.parse(JSON.parse(connection.server.config))
			timeout = (parsedConfig.timeout ?? 60) * 1000
		} catch (error) {
			console.error("Failed to parse server config for timeout:", error)
			// Default to 60 seconds if parsing fails
			timeout = 60 * 1000
		}
		const requestSignal = this.getConnectionSignal(connection, signal)

		const response = await requestWithAbort(
			() =>
				connection.client.request(
					{
						method: "tools/call",
						params: {
							name: toolName,
							arguments: toolArguments,
						},
					},
					CallToolResultSchema,
					{ timeout, signal: requestSignal },
				),
			requestSignal,
		)
		this.assertConnectionCurrent(connection, requestSignal)
		return response
	}

	/**
	 * Helper method to update a specific tool list (alwaysAllow or disabledTools)
	 * in the appropriate settings file.
	 * @param serverName The name of the server to update
	 * @param source Whether to update the global or project config
	 * @param toolName The name of the tool to add or remove
	 * @param listName The name of the list to modify ("alwaysAllow" or "disabledTools")
	 * @param addTool Whether to add (true) or remove (false) the tool from the list
	 */
	private async updateServerToolList(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		listName: "alwaysAllow" | "disabledTools",
		addTool: boolean,
	): Promise<void> {
		// Find the connection with matching name and source
		const connection = this.findConnection(serverName, source)

		if (!connection) {
			throw new Error(`Server ${serverName} with source ${source} not found`)
		}

		const committed = await this.updateServerConfig(
			serverName,
			(current) => {
				const targetList = BaseConfigSchema.parse(current)[listName]
				return {
					...current,
					[listName]: addTool
						? [...new Set([...targetList, toolName])]
						: targetList.filter((name) => name !== toolName),
				}
			},
			source,
		)
		const grants = BaseConfigSchema.parse(committed)
		const current = this.findConnection(serverName, source)

		if (current?.type === "connected" && current.server.status !== "disconnected" && !current.server.disabled) {
			this.assertConnectionCurrent(current)
			// Apply persisted host policy immediately, even if subsequent remote discovery fails.
			const hasWildcard = grants.alwaysAllow.includes("*")
			current.server.tools = current.server.tools?.map((tool) => ({
				...tool,
				alwaysAllow: hasWildcard || grants.alwaysAllow.includes(tool.name),
				enabledForPrompt: !grants.disabledTools.includes(tool.name),
			}))
			await this.waitForCurrentCatalog(current, this.refreshServerCatalog(current, true))
			await this.notifyWebviewOfServerChanges()
		}
	}

	async toggleToolAlwaysAllow(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		shouldAllow: boolean,
	): Promise<void> {
		try {
			await this.updateServerToolList(serverName, source, toolName, "alwaysAllow", shouldAllow)
		} catch (error) {
			this.showErrorMessage(
				`Failed to toggle always allow for tool "${toolName}" on server "${serverName}" with source "${source}"`,
				error,
			)
			throw error
		}
	}

	async toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		isEnabled: boolean,
	): Promise<void> {
		try {
			// When isEnabled is true, we want to remove the tool from the disabledTools list.
			// When isEnabled is false, we want to add the tool to the disabledTools list.
			const addToolToDisabledList = !isEnabled
			await this.updateServerToolList(serverName, source, toolName, "disabledTools", addToolToDisabledList)
		} catch (error) {
			this.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	/**
	 * Handles enabling/disabling MCP globally
	 * @param enabled Whether MCP should be enabled or disabled
	 * @returns Promise<void>
	 */
	async handleMcpEnabledChange(enabled: boolean): Promise<void> {
		if (!enabled) {
			// If MCP is being disabled, disconnect all servers with error handling
			const existingConnections = [...this.connections]
			const disconnectionErrors: Array<{ serverName: string; error: string }> = []

			for (const conn of existingConnections) {
				try {
					await this.deleteConnection(conn.server.name, conn.server.source)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					disconnectionErrors.push({
						serverName: conn.server.name,
						error: errorMessage,
					})
					console.error(`Failed to disconnect MCP server ${conn.server.name}: ${errorMessage}`)
				}
			}

			// If there were errors, notify the user
			if (disconnectionErrors.length > 0) {
				const errorSummary = disconnectionErrors.map((e) => `${e.serverName}: ${e.error}`).join("\n")
				vscode.window.showWarningMessage(
					t("mcp:errors.disconnect_servers_partial", {
						count: disconnectionErrors.length,
						errors: errorSummary,
					}),
				)
			}

			// Re-initialize servers to track them in disconnected state
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after disabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_disable"))
			}
		} else {
			// If MCP is being enabled, reconnect all servers
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after enabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_enable"))
			}
		}
	}

	async dispose(): Promise<void> {
		// Prevent multiple disposals
		if (this.isDisposed) {
			return
		}

		this.isDisposed = true
		for (const attempt of this.connectionAttempts.values()) attempt.abort()
		this.connectionAttempts.clear()
		for (const connection of this.connectionControllers.keys()) {
			this.cancelConnectionRequests(connection)
		}

		// Clear all debounce timers
		for (const timer of this.configChangeDebounceTimers.values()) {
			clearTimeout(timer)
		}

		this.configChangeDebounceTimers.clear()

		// Clear flag reset timer and reset programmatic update flag
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
			this.flagResetTimer = undefined
		}

		this.isProgrammaticUpdate = false
		this.removeAllFileWatchers()

		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name, connection.server.source)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}

		this.connections = []

		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		this.disposables.forEach((d) => d.dispose())
	}
}
