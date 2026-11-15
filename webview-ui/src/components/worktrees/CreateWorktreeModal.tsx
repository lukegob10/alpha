import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import prettyBytes from "pretty-bytes"

import type { WorktreeDefaultsResponse, BranchInfo, WorktreeIncludeStatus } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Button, Input } from "@/components/ui"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select"
import { CornerDownRight, Folder, FolderSearch, Info } from "lucide-react"

interface CreateWorktreeModalProps {
	open: boolean
	onClose: () => void
	openAfterCreate?: boolean
	onSuccess?: () => void
}

export const CreateWorktreeModal = ({
	open,
	onClose,
	openAfterCreate = false,
	onSuccess,
}: CreateWorktreeModalProps) => {
	const { t } = useAppTranslation()

	// Form state
	const [branchEdit, setBranchEdit] = useState<string>()
	const [pathEdit, setPathEdit] = useState<string>()
	const [baseEdit, setBaseEdit] = useState<string>()

	// Data state
	const [defaults, setDefaults] = useState<WorktreeDefaultsResponse | null>(null)
	const [branches, setBranches] = useState<BranchInfo | null>(null)
	const [includeStatus, setIncludeStatus] = useState<WorktreeIncludeStatus | null>(null)
	const branchName = branchEdit ?? defaults?.suggestedBranch ?? ""
	const worktreePath = pathEdit ?? defaults?.suggestedPath ?? ""
	const baseBranch = baseEdit ?? (branches ? branches.currentBranch || "main" : "")

	// UI state
	const [isCreating, setIsCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const initializationRequest = useRef<string>()
	const browseRequest = useRef<string>()
	const pendingCreate = useRef<{ requestId: string; path: string; openAfterCreate: boolean }>()
	const [copyProgress, setCopyProgress] = useState<{
		bytesCopied: number
		itemName: string
	} | null>(null)

	// Handle messages from extension
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (!open || !event.data || typeof event.data !== "object") return
			const message = event.data
			switch (message.type) {
				case "worktreeDefaults": {
					if (initializationRequest.current && message.requestId === initializationRequest.current) {
						setDefaults(message as WorktreeDefaultsResponse)
					}
					break
				}
				case "branchList": {
					if (initializationRequest.current && message.requestId === initializationRequest.current) {
						setBranches(message as BranchInfo)
					}
					break
				}
				case "worktreeIncludeStatus": {
					if (initializationRequest.current && message.requestId === initializationRequest.current) {
						setIncludeStatus(message.worktreeIncludeStatus)
					}
					break
				}
				case "folderSelected": {
					if (browseRequest.current && message.requestId === browseRequest.current && message.path) {
						browseRequest.current = undefined
						setPathEdit(message.path)
					}
					break
				}
				case "worktreeCopyProgress": {
					if (!pendingCreate.current || message.requestId !== pendingCreate.current.requestId) break
					setCopyProgress({
						bytesCopied: message.copyProgressBytesCopied ?? 0,
						itemName: message.copyProgressItemName ?? "",
					})
					break
				}
				case "worktreeResult": {
					const pending = pendingCreate.current
					if (!pending || message.requestId !== pending.requestId || typeof message.success !== "boolean")
						break
					pendingCreate.current = undefined
					setIsCreating(false)
					setCopyProgress(null)
					if (message.success) {
						if (pending.openAfterCreate) {
							vscode.postMessage({
								type: "switchWorktree",
								worktreePath: pending.path,
								worktreeNewWindow: true,
							})
						}
						onSuccess?.()
						onClose()
					} else {
						setError(message.text || "Unknown error")
					}
					break
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [open, onSuccess, onClose])

	useEffect(() => {
		if (!open) {
			setBranchEdit(undefined)
			setPathEdit(undefined)
			setBaseEdit(undefined)
			setDefaults(null)
			setBranches(null)
			setIncludeStatus(null)
			setIsCreating(false)
			setCopyProgress(null)
			return
		}
		setError(null)
		const requestId = crypto.randomUUID()
		initializationRequest.current = requestId
		vscode.postMessage({ type: "getWorktreeDefaults", requestId })
		vscode.postMessage({ type: "getAvailableBranches", requestId })
		vscode.postMessage({ type: "getWorktreeIncludeStatus", requestId })
		return () => {
			initializationRequest.current = undefined
			browseRequest.current = undefined
			pendingCreate.current = undefined
		}
	}, [open])

	const handleCreate = useCallback(() => {
		if (!open || pendingCreate.current) return
		const requestId = crypto.randomUUID()
		pendingCreate.current = { requestId, path: worktreePath, openAfterCreate }
		setError(null)
		setIsCreating(true)

		vscode.postMessage({
			type: "createWorktree",
			requestId,
			worktreePath: worktreePath,
			worktreeBranch: branchName,
			worktreeBaseBranch: baseBranch,
			worktreeCreateNewBranch: true,
		})
	}, [open, openAfterCreate, worktreePath, branchName, baseBranch])

	const isValid = branchName.trim() && worktreePath.trim() && baseBranch.trim()

	// Convert branches to SearchableSelect options format
	const branchOptions = useMemo((): SearchableSelectOption[] => {
		if (!branches) return []

		const localOptions: SearchableSelectOption[] = branches.localBranches.map((branch) => ({
			value: branch,
			label: branch,
			icon: <span className="codicon codicon-git-branch mr-2 text-vscode-descriptionForeground" />,
		}))

		const remoteOptions: SearchableSelectOption[] = branches.remoteBranches.map((branch) => ({
			value: branch,
			label: branch,
			icon: <span className="codicon codicon-cloud mr-2 text-vscode-descriptionForeground" />,
		}))

		return [...localOptions, ...remoteOptions]
	}, [branches])

	return (
		<Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("worktrees:createWorktree")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					{/* No .worktreeinclude warning - shows when the current worktree doesn't have .worktreeinclude */}
					{includeStatus?.exists === false && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-warningBackground border border-vscode-inputValidation-warningBorder text-sm">
							<Info />
							<span className="text-vscode-foreground">
								<span className="font-medium">{t("worktrees:noIncludeFileWarning")}</span>
								{" — "}
								<span className="text-vscode-descriptionForeground">
									{t("worktrees:noIncludeFileHint")}
								</span>
							</span>
						</div>
					)}

					{/* Base branch selector */}
					<div className="flex flex-col gap-1">
						<label className="text-sm text-vscode-foreground">{t("worktrees:baseBranch")}</label>
						{!branches ? (
							<div className="flex items-center gap-2 h-8 px-2 text-sm text-vscode-descriptionForeground">
								<span className="codicon codicon-loading codicon-modifier-spin" />
								<span>{t("worktrees:loadingBranches")}</span>
							</div>
						) : (
							<SearchableSelect
								value={baseBranch}
								onValueChange={setBaseEdit}
								options={branchOptions}
								placeholder={t("worktrees:selectBranch")}
								searchPlaceholder={t("worktrees:searchBranch")}
								emptyMessage={t("worktrees:noBranchFound")}
							/>
						)}
					</div>

					{/* Branch name */}
					<div className="flex items-center gap-2">
						<CornerDownRight className="size-4 ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("worktrees:branchName")}</label>
						<Input
							value={branchName}
							onChange={(e) => setBranchEdit(e.target.value)}
							placeholder={defaults?.suggestedBranch || "worktree/feature-name"}
							className="rounded-full"
						/>
					</div>

					{/* Worktree path */}
					<div className="flex items-center gap-2 relative">
						<Folder className="size-4 ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("worktrees:worktreePath")}</label>
						<Input
							value={worktreePath}
							onChange={(e) => {
								browseRequest.current = undefined
								setPathEdit(e.target.value)
							}}
							placeholder={defaults?.suggestedPath || "/path/to/worktree"}
							className="rounded-full flex-1 pr-9"
						/>
						<FolderSearch
							className="size-4 shrink-0 absolute right-3 cursor-pointer hover:opacity-75 transition-opacity"
							onClick={() => {
								const requestId = crypto.randomUUID()
								browseRequest.current = requestId
								vscode.postMessage({ type: "browseForWorktreePath", requestId })
							}}
						/>
					</div>

					{/* Error message */}
					{error && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm">
							<span className="codicon codicon-error text-vscode-errorForeground flex-shrink-0" />
							<p className="text-vscode-errorForeground">{error}</p>
						</div>
					)}

					{/* Progress section - appears during file copying */}
					{copyProgress && (
						<div className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-vscode-editor-background border border-vscode-panel-border">
							<div className="flex items-center gap-2 text-sm">
								<span className="codicon codicon-loading codicon-modifier-spin text-vscode-button-background" />
								<span className="text-vscode-foreground font-medium">
									{t("worktrees:copyingFiles")}
								</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground truncate">
								{t("worktrees:copyingProgress", {
									item: copyProgress.itemName,
									copied: prettyBytes(copyProgress.bytesCopied),
								})}
							</div>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={onClose} disabled={isCreating}>
						{t("worktrees:cancel")}
					</Button>
					<Button variant="primary" onClick={handleCreate} disabled={!isValid || isCreating}>
						{isCreating ? (
							<>
								<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
								{t("worktrees:creating")}
							</>
						) : (
							t("worktrees:create")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
