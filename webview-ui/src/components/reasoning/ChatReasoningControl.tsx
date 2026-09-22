import { useEffect, useRef, useState } from "react"
import type {
	CurrentTaskView,
	ExtensionMessage,
	TaskReasoningPreference,
	TaskReasoningProjection,
} from "@alpha-code/types"

import { useShellState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { ReasoningSelector } from "./ReasoningSelector"

function composerTaskId(
	currentView: CurrentTaskView | undefined,
	currentTaskId: string | undefined,
): string | undefined {
	return currentView?.type === "newTaskDraft" ? undefined : currentTaskId
}

export function ChatReasoningControl({ profileLoading = false }: { profileLoading?: boolean }) {
	const { currentTaskId, currentView, taskReasoning, currentApiConfigName, apiConfiguration } = useShellState()
	const taskId = composerTaskId(currentView, currentTaskId)
	const scope = JSON.stringify([taskId, currentApiConfigName, apiConfiguration])
	const scopeRef = useRef(scope)
	scopeRef.current = scope
	const latest = useRef<{ requestId: string; scope: string; taskId?: string }>()
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState(false)
	const [acknowledged, setAcknowledged] = useState<{
		scope: string
		source: typeof taskReasoning
		state: TaskReasoningProjection
	}>()
	useEffect(() => {
		latest.current = undefined
		setSaving(false)
		setError(false)
		setAcknowledged(undefined)
	}, [scope, profileLoading])
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type !== "taskReasoningUpdated") return
			const response = event.data.taskReasoningResponse
			const request = latest.current
			if (
				!request ||
				!response ||
				response.requestId !== request.requestId ||
				request.scope !== scopeRef.current ||
				request.taskId !== taskId ||
				response.taskId !== request.taskId
			)
				return
			latest.current = undefined
			setSaving(false)
			setError(Boolean(response.error))
			if (response.state && response.state.taskId === request.taskId) {
				setAcknowledged({ scope: request.scope, source: taskReasoning, state: response.state })
			}
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [taskId, taskReasoning])
	const choose = (preference: TaskReasoningPreference) => {
		const requestId = crypto.randomUUID()
		latest.current = { requestId, scope, taskId }
		setSaving(true)
		setError(false)
		vscode.postMessage({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: { requestId, taskId, preference },
		})
	}
	const state =
		acknowledged?.scope === scope && acknowledged.source === taskReasoning ? acknowledged.state : taskReasoning
	return (
		<ReasoningSelector
			state={state?.taskId === taskId ? state : undefined}
			scopeKey={scope}
			loading={profileLoading}
			saving={saving}
			error={error}
			onChange={choose}
			onOpenAdvanced={() =>
				window.postMessage({
					type: "action",
					action: "settingsButtonClicked",
					values: { section: "providers" },
				})
			}
		/>
	)
}
