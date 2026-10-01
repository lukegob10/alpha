import { useTranslation } from "react-i18next"

import { safeJsonParse } from "@alpha/core"

const operationKeys: Record<string, string> = {
	create_task: "createTask",
	send_task_message: "sendMessage",
	steer_task: "steerTask",
	stop_task: "stopTask",
	followupTask: "followupTask",
}

export function isTaskOperationApproval(text: string | undefined): boolean {
	const value = safeJsonParse<Record<string, unknown>>(text)
	return typeof value?.tool === "string" && Object.hasOwn(operationKeys, value.tool)
}

/** Approval payloads remain plain text; displaying them never grants routing authority. */
export function ToolApprovalDetails({ text }: { text?: string }) {
	const { t } = useTranslation("chat")
	const value = safeJsonParse<Record<string, unknown>>(text)
	const operation = typeof value?.tool === "string" ? value.tool : undefined
	const operationKey = operation && operationKeys[operation]
	const fields = [
		["recipient", value?.taskId ?? value?.target],
		["objective", value?.objective],
		["message", value?.message],
		["workspace", value?.workspaceMode],
		["reason", value?.reason],
	] as const

	return (
		<div className="space-y-2 whitespace-pre-wrap break-words text-sm" role="note">
			<div className="font-medium">
				{t(`taskOperations.${operationKey || "unknown"}`)}
				{!operationKey && operation && <code className="ml-2 font-normal">{operation}</code>}
			</div>
			{operationKey ? (
				<dl className="space-y-2">
					{fields.map(([label, content]) =>
						typeof content === "string" && content ? (
							<div key={label}>
								<dt className="text-xs text-vscode-descriptionForeground">
									{t(`taskOperations.${label}`)}
								</dt>
								<dd>{content}</dd>
							</div>
						) : null,
					)}
				</dl>
			) : (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
			)}
		</div>
	)
}
