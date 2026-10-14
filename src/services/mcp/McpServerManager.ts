import * as vscode from "vscode"
import { McpHub } from "./McpHub"
import { AlphaProvider } from "../../core/webview/AlphaProvider"

/**
 * Singleton manager for MCP server instances.
 * Ensures only one set of MCP servers runs across all webviews.
 */
export class McpServerManager {
	private static instance: McpHub | null = null
	private static readonly GLOBAL_STATE_KEY = "mcpHubInstanceId"
	private static providers: Set<AlphaProvider> = new Set()
	private static initializationPromise: Promise<McpHub> | null = null
	private static cleanupPromise: Promise<void> | null = null

	/**
	 * Get the singleton McpHub instance.
	 * Creates a new instance if one doesn't exist.
	 * Thread-safe implementation using a promise-based lock.
	 */
	static async getInstance(context: vscode.ExtensionContext, provider: AlphaProvider): Promise<McpHub> {
		// A new client must not acquire the hub being retired by cleanup.
		if (this.cleanupPromise) await this.cleanupPromise
		// Register the provider
		this.providers.add(provider)

		if (this.instance?.disposed) {
			this.instance = null
		}

		// If we already have an instance, return it
		if (this.instance) {
			return this.instance
		}

		// If initialization is in progress, wait for it
		if (this.initializationPromise) {
			return this.initializationPromise
		}

		// Create a new initialization promise
		this.initializationPromise = (async () => {
			try {
				// Double-check instance in case it was created while we were waiting
				if (!this.instance) {
					const hub = new McpHub(provider)
					try {
						// Publish only after readiness and state storage succeed.
						await hub.waitUntilReady()
						await context.globalState.update(this.GLOBAL_STATE_KEY, Date.now().toString())
						this.instance = hub
					} catch (error) {
						await hub.dispose()
						throw error
					}
				}
				return this.instance
			} finally {
				// Clear the initialization promise after completion or error
				this.initializationPromise = null
			}
		})()

		return this.initializationPromise
	}

	/**
	 * Remove a provider from the tracked set.
	 * This is called when a webview is disposed.
	 */
	static async unregisterProvider(provider: AlphaProvider, hub?: McpHub): Promise<void> {
		const owned = this.providers.delete(provider)
		// Provider leases include acquisitions awaiting readiness. Client count
		// alone cannot decide whether the shared hub is unused yet.
		const release = owned && hub ? hub.unregisterClient(false) : Promise.resolve()
		if (this.providers.size === 0) {
			// Reserve cleanup before yielding so a new acquisition waits for retirement.
			await Promise.all([release, this.cleanup(provider.context)])
		} else {
			await release
		}
	}

	/**
	 * Notify all registered providers of server state changes.
	 */
	static notifyProviders(message: any): void {
		this.providers.forEach((provider) => {
			provider.postMessageToWebview(message).catch((error) => {
				console.error("Failed to notify provider:", error)
			})
		})
	}

	/**
	 * Clean up the singleton instance and all its resources.
	 */
	static async cleanup(context: vscode.ExtensionContext): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise
		this.cleanupPromise = (async () => {
			try {
				// Construction owns resources before instance publication. Join it even
				// when it fails; that path disposes its own unpublished hub.
				await this.initializationPromise?.catch(() => undefined)
				if (this.instance) {
					await this.instance.dispose()
					this.instance = null
					await context.globalState.update(this.GLOBAL_STATE_KEY, undefined)
				}
			} finally {
				this.providers.clear()
				this.cleanupPromise = null
			}
		})()
		return this.cleanupPromise
	}
}
