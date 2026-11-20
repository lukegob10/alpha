import * as vscode from "vscode"
import * as path from "path"

import { listFiles } from "../../services/glob/list-files"
import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { toRelativePath, getWorkspacePath } from "../../utils/path"

const MAX_INITIAL_FILES = 1_000

// Note: this is not a drop-in replacement for listFiles at the start of tasks, since that will be done for Desktops when there is no workspace selected
class WorkspaceTracker {
	private providerRef: WeakRef<AlphaProvider>
	private disposables: vscode.Disposable[] = []
	private filePaths: Set<string> = new Set()
	private readonly pendingCreates = new Map<string, symbol>()
	private updateTimer: NodeJS.Timeout | null = null
	private prevWorkSpacePath: string | undefined
	private resetTimer: NodeJS.Timeout | null = null
	private disposed = false
	private generation = 0
	private discovery?: { controller: AbortController; deletedPaths: Set<string> }

	get cwd() {
		return this.providerRef?.deref()?.cwd ?? getWorkspacePath()
	}
	constructor(provider: AlphaProvider) {
		this.providerRef = new WeakRef(provider)
		this.registerListeners()
	}

	async initializeFilePaths() {
		// should not auto get filepaths for desktop since it would immediately show permission popup before Alpha ever creates a file
		const cwd = this.cwd
		if (this.disposed || !cwd || this.prevWorkSpacePath !== cwd) {
			return
		}
		const generation = this.generation
		this.discovery?.controller.abort()
		const discovery = { controller: new AbortController(), deletedPaths: new Set<string>() }
		this.discovery = discovery
		const { signal } = discovery.controller
		try {
			const [files] = await listFiles(cwd, true, MAX_INITIAL_FILES, signal)
			if (signal.aborted || !this.isCurrentWorkspace(cwd, generation)) return
			for (const file of files.slice(0, MAX_INITIAL_FILES)) {
				const normalizedPath = path.resolve(cwd, file)
				if (!wasDeletedDuringDiscovery(normalizedPath, discovery.deletedPaths)) {
					this.filePaths.add(file.endsWith("/") ? normalizedPath + "/" : normalizedPath)
				}
			}
			this.workspaceDidUpdate()
		} catch (error) {
			if (!signal.aborted) throw error
		} finally {
			if (this.discovery === discovery) this.discovery = undefined
		}
	}

	private isCurrentWorkspace(cwd: string | undefined, generation: number): boolean {
		return !this.disposed && this.generation === generation && this.cwd === cwd
	}

	private registerListeners() {
		const watcher = vscode.workspace.createFileSystemWatcher("**")
		this.prevWorkSpacePath = this.cwd
		this.disposables.push(
			watcher.onDidCreate((uri) => {
				return this.addFilePath(uri.fsPath)
					.then((added) => {
						if (added) this.workspaceDidUpdate()
					})
					.catch((error) => console.error("Failed to track a new workspace path", error))
			}),
		)

		// Renaming files triggers a delete and create event
		this.disposables.push(
			watcher.onDidDelete((uri) => {
				if (this.removeFilePath(uri.fsPath)) {
					this.workspaceDidUpdate()
				}
			}),
		)

		this.disposables.push(watcher)

		// Listen for tab changes and call workspaceDidUpdate directly
		this.disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(() => {
				// Reset if workspace path has changed
				if (this.prevWorkSpacePath !== this.cwd) {
					this.workspaceDidReset()
				} else {
					// Otherwise just update
					this.workspaceDidUpdate()
				}
			}),
		)
	}

	private getOpenedTabsInfo(cwd = this.cwd) {
		return vscode.window.tabGroups.all.reduce(
			(acc, group) => {
				const groupTabs = group.tabs
					.filter((tab) => tab.input instanceof vscode.TabInputText)
					.map((tab) => ({
						label: tab.label,
						isActive: tab.isActive,
						path: toRelativePath((tab.input as vscode.TabInputText).uri.fsPath, cwd || ""),
					}))

				groupTabs.forEach((tab) => (tab.isActive ? acc.unshift(tab) : acc.push(tab)))
				return acc
			},
			[] as Array<{ label: string; isActive: boolean; path: string }>,
		)
	}

	private workspaceDidReset() {
		if (this.disposed) return
		const cwd = this.cwd
		const generation = ++this.generation
		this.discovery?.controller.abort()
		this.pendingCreates.clear()
		if (this.resetTimer) {
			clearTimeout(this.resetTimer)
		}
		if (this.updateTimer) {
			clearTimeout(this.updateTimer)
			this.updateTimer = null
		}
		this.resetTimer = setTimeout(() => {
			this.resetTimer = null
			void this.resetWorkspace(cwd, generation).catch((error) =>
				console.error("Failed to initialize workspace file suggestions", error),
			)
		}, 300) // Debounce for 300ms
	}

	private async resetWorkspace(cwd: string | undefined, generation: number): Promise<void> {
		if (!this.isCurrentWorkspace(cwd, generation) || this.prevWorkSpacePath === cwd) return
		this.filePaths.clear()
		this.prevWorkSpacePath = cwd
		await this.providerRef.deref()?.postMessageToWebview({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: this.getOpenedTabsInfo(cwd),
		})
		if (this.isCurrentWorkspace(cwd, generation)) await this.initializeFilePaths()
	}

	private workspaceDidUpdate() {
		const cwd = this.cwd
		const generation = this.generation
		if (this.disposed || this.prevWorkSpacePath !== cwd) return
		if (this.updateTimer) {
			this.updateTimer.refresh()
			return
		}
		this.updateTimer = setTimeout(() => {
			this.updateTimer = null
			if (!cwd || !this.isCurrentWorkspace(cwd, generation)) {
				return
			}

			const relativeFilePaths = Array.from(this.filePaths).map((file) => toRelativePath(file, cwd))
			const provider = this.providerRef.deref()
			if (!provider) return
			void provider
				.postMessageToWebview({
					type: "workspaceUpdated",
					filePaths: relativeFilePaths,
					openedTabs: this.getOpenedTabsInfo(cwd),
				})
				.catch((error) => console.error("Failed to publish workspace file suggestions", error))
		}, 300) // Debounce for 300ms
	}

	private async addFilePath(filePath: string): Promise<boolean> {
		const cwd = this.cwd
		const generation = this.generation
		// Allow for some buffer to account for files being created/deleted during a task
		if (
			this.disposed ||
			this.prevWorkSpacePath !== cwd ||
			this.filePaths.size + this.pendingCreates.size >= MAX_INITIAL_FILES * 2
		)
			return false

		const normalizedPath = path.resolve(cwd ?? "", filePath)
		const creation = Symbol()
		this.pendingCreates.set(normalizedPath, creation)
		try {
			const stat = await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(normalizedPath))).catch(
				(error: unknown) =>
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "FileNotFound" || error.code === "ENOENT")
						? null
						: undefined,
			)
			if (stat === null) return false
			if (!this.isCurrentWorkspace(cwd, generation) || this.pendingCreates.get(normalizedPath) !== creation)
				return false
			const isDirectory = stat && (stat.type & vscode.FileType.Directory) !== 0
			this.filePaths.add(isDirectory && !normalizedPath.endsWith("/") ? normalizedPath + "/" : normalizedPath)
			return true
		} finally {
			if (this.pendingCreates.get(normalizedPath) === creation) this.pendingCreates.delete(normalizedPath)
		}
	}

	private removeFilePath(filePath: string): boolean {
		const cwd = this.cwd
		if (this.disposed || this.prevWorkSpacePath !== cwd) return false
		const normalizedPath = path.resolve(cwd ?? "", filePath)
		// A folder event may be the only notice that its children were removed.
		// Keep this deletion through discovery even if a watcher then adds a new entry.
		this.discovery?.deletedPaths.add(normalizedPath)
		this.pendingCreates.delete(normalizedPath)
		const removedFile = this.filePaths.delete(normalizedPath)
		let removed = this.filePaths.delete(normalizedPath + "/") || removedFile
		const descendantPrefix = path.join(normalizedPath, path.sep)
		for (const pending of this.pendingCreates.keys()) {
			if (pending.startsWith(descendantPrefix)) this.pendingCreates.delete(pending)
		}
		for (const tracked of this.filePaths) {
			if (tracked.startsWith(descendantPrefix)) {
				this.filePaths.delete(tracked)
				removed = true
			}
		}
		return removed
	}

	public dispose() {
		if (this.disposed) return
		this.disposed = true
		this.generation++
		this.discovery?.controller.abort()
		this.pendingCreates.clear()
		if (this.updateTimer) {
			clearTimeout(this.updateTimer)
			this.updateTimer = null
		}
		if (this.resetTimer) {
			clearTimeout(this.resetTimer)
			this.resetTimer = null
		}
		this.disposables.forEach((d) => d.dispose())
		this.disposables = [] // Clear the array
	}
}

function wasDeletedDuringDiscovery(filePath: string, deletedPaths: ReadonlySet<string>): boolean {
	if (deletedPaths.size === 0) return false
	for (;;) {
		if (deletedPaths.has(filePath)) return true
		const parent = path.dirname(filePath)
		if (parent === filePath) return false
		filePath = parent
	}
}

export default WorkspaceTracker
