import React, { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowLeft, CalendarClock, Copy, Pause, Play, Plus, Shield, Terminal, Trash2 } from "lucide-react"

import type {
	ScheduledTask,
	ScheduledTaskAutoApproval,
	ScheduledTaskExecution,
	ScheduledTaskNotificationPreference,
	ScheduledTaskSchedule,
} from "@alpha-code/types"
import { getAllModes } from "@roo/modes"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@/components/ui"

import { Tab, TabContent, TabHeader } from "../common/Tab"

type ScheduledTasksViewProps = {
	onDone: () => void
	targetTaskId?: string
}

type ScheduleKind = ScheduledTaskSchedule["type"]
type ExecutionKind = ScheduledTaskExecution["type"]

const localDateTimeValue = (time: number) => {
	const date = new Date(time)
	const offset = date.getTimezoneOffset() * 60 * 1000
	return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

const fromLocalDateTimeValue = (value: string) => new Date(value).getTime()

const formatTime = (time?: number) => (time ? new Date(time).toLocaleString() : "Not scheduled")

const describeSchedule = (schedule: ScheduledTaskSchedule) => {
	switch (schedule.type) {
		case "once":
			return `Once at ${formatTime(schedule.startAt)}`
		case "hourly":
			return `Every ${schedule.intervalHours} hour(s)`
		case "daily":
			return `Every ${schedule.intervalDays} day(s)`
		case "weekly":
			return `Every ${schedule.intervalWeeks} week(s)`
		case "monthly":
			return `Every ${schedule.intervalMonths} month(s)`
		case "customInterval":
			return `Every ${Math.round(schedule.intervalMs / 60000)} minute(s)`
	}
}

const buildSchedule = (
	type: ScheduleKind,
	startAt: number,
	timezone: string,
	interval: number,
): ScheduledTaskSchedule => {
	switch (type) {
		case "once":
			return { type, startAt, timezone }
		case "hourly":
			return { type, startAt, timezone, intervalHours: interval }
		case "daily":
			return { type, startAt, timezone, intervalDays: interval }
		case "weekly":
			return { type, startAt, timezone, intervalWeeks: interval }
		case "monthly":
			return { type, startAt, timezone, intervalMonths: interval }
		case "customInterval":
			return { type, startAt, timezone, intervalMs: interval * 60 * 1000 }
	}
}

const getInterval = (schedule: ScheduledTaskSchedule) => {
	switch (schedule.type) {
		case "once":
			return 1
		case "hourly":
			return schedule.intervalHours
		case "daily":
			return schedule.intervalDays
		case "weekly":
			return schedule.intervalWeeks
		case "monthly":
			return schedule.intervalMonths
		case "customInterval":
			return Math.max(1, Math.round(schedule.intervalMs / 60000))
	}
}

const describeExecution = (execution?: ScheduledTaskExecution) => {
	switch (execution?.type) {
		case "command":
			return "Command"
		case "skill":
			return `Skill: ${execution.skillName}`
		case "plugin":
			return `Plugin: ${execution.pluginName}`
		default:
			return "Prompt"
	}
}

const defaultAutoApproval: ScheduledTaskAutoApproval = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	allowedCommands: [],
	deniedCommands: [],
}

const normalizeAutoApproval = (autoApproval?: ScheduledTaskAutoApproval): ScheduledTaskAutoApproval => ({
	...defaultAutoApproval,
	...autoApproval,
})

const autoApprovalLabel = (autoApproval?: ScheduledTaskAutoApproval) => {
	const approval = normalizeAutoApproval(autoApproval)
	if (!approval.autoApprovalEnabled) {
		return "Ask"
	}
	const enabled = [
		approval.alwaysAllowReadOnly ? "Read" : undefined,
		approval.alwaysAllowWrite ? "Write" : undefined,
		approval.alwaysAllowExecute ? "Execute" : undefined,
		approval.alwaysAllowMcp ? "MCP" : undefined,
	].filter(Boolean)
	return enabled.length ? enabled.join(", ") : "Ask"
}

const ScheduledTasksView = ({ onDone, targetTaskId }: ScheduledTasksViewProps) => {
	const { scheduledTasks = [], scheduledTaskRuns = [], cwd, mode, customModes } = useExtensionState()
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
	const [selectedId, setSelectedId] = useState<string | undefined>(scheduledTasks[0]?.id)
	const selectedTask = scheduledTasks.find((task) => task.id === selectedId)
	const nowPlusHour = Date.now() + 60 * 60 * 1000
	const modes = useMemo(() => getAllModes(customModes), [customModes])

	const [name, setName] = useState("")
	const [prompt, setPrompt] = useState("")
	const [executionType, setExecutionType] = useState<ExecutionKind>("prompt")
	const [command, setCommand] = useState("")
	const [timeoutMinutes, setTimeoutMinutes] = useState(10)
	const [skillName, setSkillName] = useState("")
	const [pluginName, setPluginName] = useState("")
	const [executionArguments, setExecutionArguments] = useState("")
	const [taskMode, setTaskMode] = useState<string>(mode)
	const [autoApproval, setAutoApproval] = useState<ScheduledTaskAutoApproval>(defaultAutoApproval)
	const [scheduleType, setScheduleType] = useState<ScheduleKind>("daily")
	const [startAt, setStartAt] = useState(localDateTimeValue(nowPlusHour))
	const [interval, setIntervalValue] = useState(1)
	const [notificationPreference, setNotificationPreference] =
		useState<ScheduledTaskNotificationPreference>("on_failure")

	const runsForSelected = useMemo(
		() => scheduledTaskRuns.filter((run) => run.taskId === selectedId).slice(0, 20),
		[scheduledTaskRuns, selectedId],
	)

	const resetForm = () => {
		setName("")
		setPrompt("")
		setExecutionType("prompt")
		setCommand("")
		setTimeoutMinutes(10)
		setSkillName("")
		setPluginName("")
		setExecutionArguments("")
		setTaskMode(mode)
		setAutoApproval(defaultAutoApproval)
		setScheduleType("daily")
		setStartAt(localDateTimeValue(nowPlusHour))
		setIntervalValue(1)
		setNotificationPreference("on_failure")
		setSelectedId(undefined)
	}

	const editTask = useCallback(
		(task: ScheduledTask) => {
			setSelectedId(task.id)
			setName(task.name)
			setPrompt(task.prompt)
			const execution = task.execution ?? { type: "prompt" }
			setExecutionType(execution.type)
			setCommand(execution.type === "command" ? execution.command : "")
			setTimeoutMinutes(
				execution.type === "command" ? Math.max(1, Math.round((execution.timeoutMs ?? 600000) / 60000)) : 10,
			)
			setSkillName(execution.type === "skill" ? execution.skillName : "")
			setPluginName(execution.type === "plugin" ? execution.pluginName : "")
			setExecutionArguments(
				execution.type === "skill" || execution.type === "plugin" ? (execution.arguments ?? "") : "",
			)
			setTaskMode(task.mode ?? mode)
			setAutoApproval(normalizeAutoApproval(task.autoApproval))
			setScheduleType(task.schedule.type)
			setStartAt(localDateTimeValue(task.schedule.startAt))
			setIntervalValue(getInterval(task.schedule))
			setNotificationPreference(task.notificationPreference)
		},
		[mode],
	)

	useEffect(() => {
		if (!targetTaskId) {
			return
		}
		const task = scheduledTasks.find((candidate) => candidate.id === targetTaskId)
		if (task) {
			editTask(task)
		}
	}, [editTask, targetTaskId, scheduledTasks])

	const save = () => {
		const schedule = buildSchedule(scheduleType, fromLocalDateTimeValue(startAt), timezone, Math.max(1, interval))
		const execution: ScheduledTaskExecution =
			executionType === "command"
				? { type: "command", command, timeoutMs: Math.max(1, timeoutMinutes) * 60 * 1000 }
				: executionType === "skill"
					? { type: "skill", skillName, arguments: executionArguments || undefined }
					: executionType === "plugin"
						? { type: "plugin", pluginName, arguments: executionArguments || undefined }
						: { type: "prompt" }
		const payload = {
			name,
			prompt,
			execution,
			mode: taskMode,
			autoApproval:
				executionType === "command"
					? { ...autoApproval, autoApprovalEnabled: true, alwaysAllowExecute: true }
					: autoApproval,
			schedule,
			workspace: cwd,
			notificationPreference,
		}
		if (selectedTask) {
			vscode.postMessage({
				type: "updateScheduledTask",
				scheduledTaskId: selectedTask.id,
				scheduledTaskUpdate: payload,
			})
		} else {
			vscode.postMessage({ type: "createScheduledTask", scheduledTask: payload })
		}
	}

	return (
		<Tab>
			<TabHeader className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Button variant="ghost" className="px-1.5 -ml-2" onClick={onDone} aria-label="Back to chat">
						<ArrowLeft />
					</Button>
					<CalendarClock className="size-4" />
					<h3 className="text-vscode-foreground m-0">Scheduled Tasks</h3>
				</div>
				<Button variant="secondary" onClick={resetForm}>
					<Plus />
					New
				</Button>
			</TabHeader>
			<TabContent className="p-0">
				<div className="grid grid-cols-[minmax(220px,0.9fr)_minmax(320px,1.3fr)] min-h-full">
					<div className="border-r border-vscode-panel-border p-3 overflow-auto">
						{scheduledTasks.length === 0 ? (
							<div className="text-vscode-descriptionForeground text-sm px-2 py-4">
								No scheduled tasks yet.
							</div>
						) : (
							<div className="flex flex-col gap-2">
								{scheduledTasks.map((task) => (
									<button
										key={task.id}
										className={`text-left border rounded-sm p-3 bg-vscode-editor-background hover:bg-vscode-list-hoverBackground ${
											task.id === selectedId
												? "border-vscode-focusBorder"
												: "border-vscode-panel-border"
										}`}
										onClick={() => editTask(task)}>
										<div className="flex items-center justify-between gap-2">
											<div className="font-medium truncate">{task.name}</div>
											<span className="text-xs text-vscode-descriptionForeground">
												{task.enabled ? "Enabled" : "Paused"}
											</span>
										</div>
										<div className="text-xs text-vscode-descriptionForeground mt-1">
											Next: {formatTime(task.nextRunAt)}
										</div>
										<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
											{describeExecution(task.execution)} | {autoApprovalLabel(task.autoApproval)}
										</div>
										<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
											Last: {task.lastRunStatus ?? "never"}
											{task.lastRunSummary ? ` - ${task.lastRunSummary}` : ""}
										</div>
									</button>
								))}
							</div>
						)}
					</div>
					<div className="p-4 overflow-auto">
						<div className="flex flex-col gap-3 max-w-3xl">
							<label className="flex flex-col gap-1 text-sm">
								Name
								<Input value={name} onChange={(event) => setName(event.target.value)} />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								Prompt
								<Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} />
							</label>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1 text-sm">
									Execution
									<Select
										value={executionType}
										onValueChange={(value) => {
											const next = value as ExecutionKind
											setExecutionType(next)
											if (next === "command") {
												setAutoApproval((current) => ({
													...current,
													autoApprovalEnabled: true,
													alwaysAllowExecute: true,
												}))
											}
										}}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="prompt">Prompt</SelectItem>
											<SelectItem value="command">Command</SelectItem>
											<SelectItem value="skill">Skill</SelectItem>
											<SelectItem value="plugin">Plugin</SelectItem>
										</SelectContent>
									</Select>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Mode
									<Select value={taskMode} onValueChange={setTaskMode}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{modes.map((modeOption) => (
												<SelectItem key={modeOption.slug} value={modeOption.slug}>
													{modeOption.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</label>
								<div className="flex flex-col gap-1 text-sm">
									Auto-approval
									<Button
										variant={autoApproval.autoApprovalEnabled ? "secondary" : "outline"}
										onClick={() =>
											setAutoApproval((current) => ({
												...current,
												autoApprovalEnabled: !current.autoApprovalEnabled,
											}))
										}>
										{autoApproval.autoApprovalEnabled ? "Enabled" : "Ask"}
									</Button>
								</div>
							</div>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={autoApproval.alwaysAllowReadOnly}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowReadOnly: event.target.checked,
											}))
										}
									/>
									Read files
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={autoApproval.alwaysAllowWrite}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowWrite: event.target.checked,
											}))
										}
									/>
									Write files
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={executionType === "command" || autoApproval.alwaysAllowExecute}
										disabled={executionType === "command"}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowExecute: event.target.checked,
											}))
										}
									/>
									Execute commands
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={autoApproval.alwaysAllowMcp}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowMcp: event.target.checked,
											}))
										}
									/>
									MCP
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={autoApproval.alwaysAllowModeSwitch}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowModeSwitch: event.target.checked,
											}))
										}
									/>
									Mode switch
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={autoApproval.alwaysAllowSubtasks}
										onChange={(event) =>
											setAutoApproval((current) => ({
												...current,
												alwaysAllowSubtasks: event.target.checked,
											}))
										}
									/>
									Subtasks
								</label>
							</div>
							{executionType === "command" && (
								<div className="grid grid-cols-[1fr_140px] gap-2">
									<label className="flex flex-col gap-1 text-sm">
										Command
										<Input value={command} onChange={(event) => setCommand(event.target.value)} />
									</label>
									<label className="flex flex-col gap-1 text-sm">
										Timeout minutes
										<Input
											type="number"
											min={1}
											value={timeoutMinutes}
											onChange={(event) => setTimeoutMinutes(Number(event.target.value))}
										/>
									</label>
								</div>
							)}
							{executionType === "skill" && (
								<label className="flex flex-col gap-1 text-sm">
									Skill
									<Input value={skillName} onChange={(event) => setSkillName(event.target.value)} />
								</label>
							)}
							{executionType === "plugin" && (
								<label className="flex flex-col gap-1 text-sm">
									Plugin
									<Input value={pluginName} onChange={(event) => setPluginName(event.target.value)} />
								</label>
							)}
							{(executionType === "skill" || executionType === "plugin") && (
								<label className="flex flex-col gap-1 text-sm">
									Arguments
									<Textarea
										value={executionArguments}
										onChange={(event) => setExecutionArguments(event.target.value)}
										rows={3}
									/>
								</label>
							)}
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1 text-sm">
									Schedule
									<Select
										value={scheduleType}
										onValueChange={(value) => setScheduleType(value as ScheduleKind)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="once">Once</SelectItem>
											<SelectItem value="hourly">Hourly</SelectItem>
											<SelectItem value="daily">Daily</SelectItem>
											<SelectItem value="weekly">Weekly</SelectItem>
											<SelectItem value="monthly">Monthly</SelectItem>
											<SelectItem value="customInterval">Custom minutes</SelectItem>
										</SelectContent>
									</Select>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Start
									<Input
										type="datetime-local"
										value={startAt}
										onChange={(event) => setStartAt(event.target.value)}
									/>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Interval
									<Input
										type="number"
										min={1}
										disabled={scheduleType === "once"}
										value={interval}
										onChange={(event) => setIntervalValue(Number(event.target.value))}
									/>
								</label>
							</div>
							<label className="flex flex-col gap-1 text-sm">
								Notifications
								<Select
									value={notificationPreference}
									onValueChange={(value) =>
										setNotificationPreference(value as ScheduledTaskNotificationPreference)
									}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="on_failure">Failure only</SelectItem>
										<SelectItem value="on_completion">Completion</SelectItem>
										<SelectItem value="before_run">Before run</SelectItem>
										<SelectItem value="approval_required">Approval required</SelectItem>
										<SelectItem value="never">Never</SelectItem>
									</SelectContent>
								</Select>
							</label>
							<div className="text-xs text-vscode-descriptionForeground">
								Workspace: {cwd || "current workspace"} | Timezone: {timezone}
							</div>
							<div className="text-xs text-vscode-descriptionForeground">
								<Shield className="inline size-3 mr-1" />
								Auto-approval:{" "}
								{autoApprovalLabel(
									executionType === "command"
										? { ...autoApproval, autoApprovalEnabled: true, alwaysAllowExecute: true }
										: autoApproval,
								)}
								. Commits, pushes, and pull requests stay disabled for scheduled tasks.
								{executionType === "command" && (
									<>
										{" "}
										<Terminal className="inline size-3 mx-1" />
										Command runs in the configured workspace.
									</>
								)}
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="primary"
									onClick={save}
									disabled={
										!name.trim() ||
										!prompt.trim() ||
										(executionType === "command" && !command.trim()) ||
										(executionType === "skill" && !skillName.trim()) ||
										(executionType === "plugin" && !pluginName.trim())
									}>
									{selectedTask ? "Save" : "Create"}
								</Button>
								{selectedTask && (
									<>
										<Button
											onClick={() =>
												vscode.postMessage({
													type: selectedTask.enabled
														? "pauseScheduledTask"
														: "resumeScheduledTask",
													scheduledTaskId: selectedTask.id,
												})
											}>
											{selectedTask.enabled ? <Pause /> : <Play />}
											{selectedTask.enabled ? "Pause" : "Resume"}
										</Button>
										<Button
											onClick={() =>
												vscode.postMessage({
													type: "runScheduledTaskNow",
													scheduledTaskId: selectedTask.id,
												})
											}>
											<Play />
											Run Now
										</Button>
										<Button
											onClick={() =>
												vscode.postMessage({
													type: "duplicateScheduledTask",
													scheduledTaskId: selectedTask.id,
												})
											}>
											<Copy />
											Duplicate
										</Button>
										<Button
											variant="destructive"
											onClick={() => {
												vscode.postMessage({
													type: "deleteScheduledTask",
													scheduledTaskId: selectedTask.id,
												})
												resetForm()
											}}>
											<Trash2 />
											Delete
										</Button>
									</>
								)}
							</div>
							{selectedTask && (
								<div className="border-t border-vscode-panel-border pt-3 mt-2">
									<div className="font-medium mb-2">Run History</div>
									<div className="text-xs text-vscode-descriptionForeground mb-2">
										{describeSchedule(selectedTask.schedule)}
									</div>
									<div className="flex flex-col gap-2">
										{runsForSelected.length === 0 ? (
											<div className="text-sm text-vscode-descriptionForeground">
												No runs yet.
											</div>
										) : (
											runsForSelected.map((run) => (
												<div
													key={run.id}
													className="border border-vscode-panel-border rounded-sm p-2">
													<div className="flex justify-between gap-2 text-sm">
														<span>{run.status}</span>
														<span className="text-vscode-descriptionForeground">
															{formatTime(run.scheduledFor)}
														</span>
													</div>
													<div className="text-xs text-vscode-descriptionForeground mt-1">
														{run.summary ??
															run.error ??
															run.skipReason ??
															"No summary yet."}
													</div>
													{run.alphaTaskId && (
														<div className="text-xs text-vscode-descriptionForeground mt-1">
															Alpha task: {run.alphaTaskId}
														</div>
													)}
													{run.output && (
														<pre className="text-xs text-vscode-descriptionForeground mt-2 whitespace-pre-wrap max-h-32 overflow-auto">
															{run.output}
														</pre>
													)}
												</div>
											))
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
			</TabContent>
		</Tab>
	)
}

export default ScheduledTasksView
