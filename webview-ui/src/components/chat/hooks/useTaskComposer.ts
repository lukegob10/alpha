import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react"

export interface ComposerSubmission {
	requestId: string
	taskId: string
	text: string
	images: string[]
	clientSubmittedAt?: number
}

export interface TaskComposerDraft {
	inputValue: string
	selectedImages: string[]
	editingQueuedMessage: { taskId: string; id: string; priorText: string; priorImages: string[] } | null
	pendingQueueRequest: ComposerSubmission | null
	pendingSteerRequest: { requestId: string; taskId: string; messageId: string } | null
	pendingEditRequest: (ComposerSubmission & { messageId: string }) | null
	pendingResumeRequest: ComposerSubmission | null
	pendingAskRequests: (ComposerSubmission & { askMessageTs?: number })[]
	chatCommandError?: string
}

const EMPTY_DRAFT: TaskComposerDraft = {
	inputValue: "",
	selectedImages: [],
	editingQueuedMessage: null,
	pendingQueueRequest: null,
	pendingSteerRequest: null,
	pendingEditRequest: null,
	pendingResumeRequest: null,
	pendingAskRequests: [],
}
const draftKey = (taskId: string | undefined) => (taskId === undefined ? "new-chat-draft" : `task:${taskId}`)

/** Presentation state follows chat identity, independently of the selected runtime session. */
export function useTaskComposer(taskId: string | undefined) {
	const [drafts, setDrafts] = useState<Record<string, TaskComposerDraft>>({})
	const draftsRef = useRef(drafts)
	const selectedTaskRef = useRef(taskId)
	useLayoutEffect(() => {
		selectedTaskRef.current = taskId
	}, [taskId])
	const getTaskDraft = useCallback(
		(owner: string | undefined) => draftsRef.current[draftKey(owner)] ?? EMPTY_DRAFT,
		[],
	)
	const updateTaskDraft = useCallback(
		(owner: string | undefined, update: (draft: TaskComposerDraft) => TaskComposerDraft) => {
			const key = draftKey(owner)
			const nextDraft = update(draftsRef.current[key] ?? EMPTY_DRAFT)
			const next = { ...draftsRef.current, [key]: nextDraft }
			// Navigation through untouched chats should not accumulate draft records.
			if (
				!nextDraft.inputValue &&
				!nextDraft.selectedImages.length &&
				!nextDraft.editingQueuedMessage &&
				!nextDraft.pendingQueueRequest &&
				!nextDraft.pendingSteerRequest &&
				!nextDraft.pendingEditRequest &&
				!nextDraft.pendingResumeRequest &&
				!nextDraft.pendingAskRequests.length &&
				!nextDraft.chatCommandError
			)
				delete next[key]
			draftsRef.current = next
			setDrafts(next)
		},
		[],
	)
	const setField = useCallback(
		<K extends keyof TaskComposerDraft>(field: K, action: SetStateAction<TaskComposerDraft[K]>) => {
			updateTaskDraft(selectedTaskRef.current, (draft) => ({
				...draft,
				[field]: typeof action === "function" ? action(draft[field]) : action,
			}))
		},
		[updateTaskDraft],
	)
	const [setters] = useState(() => ({
		setInputValue: (action: SetStateAction<string>) => setField("inputValue", action),
		setSelectedImages: (action: SetStateAction<string[]>) => setField("selectedImages", action),
		setEditingQueuedMessage: (action: SetStateAction<TaskComposerDraft["editingQueuedMessage"]>) =>
			setField("editingQueuedMessage", action),
		setPendingQueueRequest: (action: SetStateAction<TaskComposerDraft["pendingQueueRequest"]>) =>
			setField("pendingQueueRequest", action),
		setPendingSteerRequest: (action: SetStateAction<TaskComposerDraft["pendingSteerRequest"]>) =>
			setField("pendingSteerRequest", action),
		setPendingEditRequest: (action: SetStateAction<TaskComposerDraft["pendingEditRequest"]>) =>
			setField("pendingEditRequest", action),
		setPendingResumeRequest: (action: SetStateAction<TaskComposerDraft["pendingResumeRequest"]>) =>
			setField("pendingResumeRequest", action),
		setPendingAskRequests: (action: SetStateAction<TaskComposerDraft["pendingAskRequests"]>) =>
			setField("pendingAskRequests", action),
		setChatCommandError: (action: SetStateAction<string | undefined>) => setField("chatCommandError", action),
	}))
	return { ...(drafts[draftKey(taskId)] ?? EMPTY_DRAFT), ...setters, getTaskDraft, updateTaskDraft }
}
