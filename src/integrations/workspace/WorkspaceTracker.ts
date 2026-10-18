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
	private updateTimer: NodeJS.Timeout | null = null
	private prevWorkSpacePath: string | undefined
	private resetTimer: NodeJS.Timeout | null = null
	private disposed = false
	private generation = 0
	private discoveryGeneration = 0

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
		const discoveryGeneration = ++this.discoveryGeneration
		const [files] = await listFiles(cwd, true, MAX_INITIAL_FILES)
		if (!this.isCurrentWorkspace(cwd, generation) || this.discoveryGeneration !== discoveryGeneration) {
			return
		}
		files.slice(0, MAX_INITIAL_FILES).forEach((file) => this.filePaths.add(this.normalizeFilePath(file, cwd)))
		this.workspaceDidUpdate()
	}

	private isCurrentWorkspace(cwd: string | undefined, generation: number): boolean {
		return !this.disposed && this.generation === generation && this.cwd === cwd
	}

	private registerListeners() {
		const watcher = vscode.workspace.createFileSystemWatcher("**")
		this.prevWorkSpacePath = this.cwd
		this.disposables.push(
			watcher.onDidCreate(async (uri) => {
				await this.addFilePath(uri.fsPath)
				this.workspaceDidUpdate()
			}),
		)

		// Renaming files triggers a delete and create event
		this.disposables.push(
			watcher.onDidDelete(async (uri) => {
				if (await this.removeFilePath(uri.fsPath)) {
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
		if (this.resetTimer) {
			clearTimeout(this.resetTimer)
		}
		if (this.updateTimer) {
			clearTimeout(this.updateTimer)
			this.updateTimer = null
		}
		this.resetTimer = setTimeout(async () => {
			this.resetTimer = null
			if (!this.isCurrentWorkspace(cwd, generation)) return
			if (this.prevWorkSpacePath !== cwd) {
				await this.providerRef.deref()?.postMessageToWebview({
					type: "workspaceUpdated",
					filePaths: [],
					openedTabs: this.getOpenedTabsInfo(cwd),
				})
				if (!this.isCurrentWorkspace(cwd, generation)) return
				this.filePaths.clear()
				this.prevWorkSpacePath = cwd
				this.initializeFilePaths()
			}
		}, 300) // Debounce for 300ms
	}

	private workspaceDidUpdate() {
		const cwd = this.cwd
		const generation = this.generation
		if (this.disposed || this.prevWorkSpacePath !== cwd) return
		if (this.updateTimer) {
			clearTimeout(this.updateTimer)
		}
		this.updateTimer = setTimeout(() => {
			this.updateTimer = null
			if (!cwd || !this.isCurrentWorkspace(cwd, generation)) {
				return
			}

			const relativeFilePaths = Array.from(this.filePaths).map((file) => toRelativePath(file, cwd))
			this.providerRef.deref()?.postMessageToWebview({
				type: "workspaceUpdated",
				filePaths: relativeFilePaths,
				openedTabs: this.getOpenedTabsInfo(cwd),
			})
		}, 300) // Debounce for 300ms
	}

	private normalizeFilePath(filePath: string, cwd = this.cwd): string {
		const resolvedPath = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath)
		return filePath.endsWith("/") ? resolvedPath + "/" : resolvedPath
	}

	private async addFilePath(filePath: string): Promise<void> {
		const cwd = this.cwd
		const generation = this.generation
		// Allow for some buffer to account for files being created/deleted during a task
		if (this.disposed || this.prevWorkSpacePath !== cwd || this.filePaths.size >= MAX_INITIAL_FILES * 2) {
			return
		}

		const normalizedPath = this.normalizeFilePath(filePath, cwd)
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(normalizedPath))
			if (!this.isCurrentWorkspace(cwd, generation)) return
			const isDirectory = (stat.type & vscode.FileType.Directory) !== 0
			const pathWithSlash = isDirectory && !normalizedPath.endsWith("/") ? normalizedPath + "/" : normalizedPath
			this.filePaths.add(pathWithSlash)
		} catch {
			if (!this.isCurrentWorkspace(cwd, generation)) return
			// If stat fails, assume it's a file (this can happen for newly created files)
			this.filePaths.add(normalizedPath)
		}
	}

	private async removeFilePath(filePath: string): Promise<boolean> {
		const normalizedPath = this.normalizeFilePath(filePath)
		return this.filePaths.delete(normalizedPath) || this.filePaths.delete(normalizedPath + "/")
	}

	public dispose() {
		if (this.disposed) return
		this.disposed = true
		this.generation++
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

export default WorkspaceTracker
