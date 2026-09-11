import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
	ArrowLeft,
	CalendarClock,
	ChevronDown,
	ChevronRight,
	Clock3,
	Copy,
	Ellipsis,
	Folder,
	History,
	Pause,
	Play,
	Plus,
	Shield,
	Trash2,
} from "lucide-react"

import type {
	ExtensionMessage,
	SkillMetadata,
	ScheduledTask,
	ScheduledTaskAutoApproval,
	ScheduledTaskExecution,
	ScheduledTaskNotificationPreference,
	ScheduledTaskSchedule,
} from "@alpha-code/types"
import { getAllModes } from "@alpha/modes"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"
import { getUserFacingModeOptions, normalizeUserFacingModeSlug } from "@/utils/modePresentation"
import {
	Button,
	Checkbox,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from "@/components/ui"

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

const approvalOptions = [
	["alwaysAllowReadOnly", "Read files"],
	["alwaysAllowWrite", "Write files"],
	["alwaysAllowExecute", "Execute commands"],
	["alwaysAllowMcp", "MCP"],
	["alwaysAllowModeSwitch", "Mode switch"],
	["alwaysAllowSubtasks", "Subtasks"],
] as const

const intervalUnitKeys = {
	hourly: "scheduledTasks:hours",
	daily: "scheduledTasks:days",
	weekly: "scheduledTasks:weeks",
	monthly: "scheduledTasks:months",
	customInterval: "scheduledTasks:minutes",
} as const

const ScheduledTasksView = ({ onDone, targetTaskId }: ScheduledTasksViewProps) => {
	const {
		scheduledTasks = [],
		scheduledTaskRuns = [],
		cwd,
		mode,
		customModes,
		listApiConfigMeta = [],
	} = useExtensionState()
	const { t, i18n } = useAppTranslation()
	const describeSchedule = (schedule: ScheduledTaskSchedule) => {
		if (schedule.type === "once") return formatTime(schedule.startAt)
		const units = { hourly: "hour", daily: "day", weekly: "week", monthly: "month", customInterval: "minute" }
		return t("scheduledTasks:everyInterval", {
			interval: new Intl.NumberFormat(i18n.resolvedLanguage, {
				style: "unit",
				unit: units[schedule.type],
				unitDisplay: "long",
			}).format(getInterval(schedule)),
		})
	}
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
	const [selectedId, setSelectedId] = useState<string | undefined>()
	const selectedTask = scheduledTasks.find((task) => task.id === selectedId)
	const nowPlusHour = Date.now() + 60 * 60 * 1000

	const [name, setName] = useState("")
	const [prompt, setPrompt] = useState("")
	const [executionType, setExecutionType] = useState<ExecutionKind>("prompt")
	const [command, setCommand] = useState("")
	const [timeoutMinutes, setTimeoutMinutes] = useState(10)
	const [skillName, setSkillName] = useState("")
	const [skillPath, setSkillPath] = useState<string | undefined>()
	const [apiConfig, setApiConfig] = useState<ScheduledTask["apiConfig"]>()
	const [workspace, setWorkspace] = useState(cwd)
	const [skills, setSkills] = useState<SkillMetadata[]>([])
	const [pluginName, setPluginName] = useState("")
	const [executionArguments, setExecutionArguments] = useState("")
	const [taskMode, setTaskMode] = useState<string>(() => normalizeUserFacingModeSlug(mode))
	const modes = useMemo(() => getUserFacingModeOptions(getAllModes(customModes), taskMode), [customModes, taskMode])
	const [autoApproval, setAutoApproval] = useState<ScheduledTaskAutoApproval>(defaultAutoApproval)
	const [scheduleType, setScheduleType] = useState<ScheduleKind>("daily")
	const [startAt, setStartAt] = useState(localDateTimeValue(nowPlusHour))
	const [interval, setIntervalValue] = useState(1)
	const [notificationPreference, setNotificationPreference] =
		useState<ScheduledTaskNotificationPreference>("on_failure")
	const handledTargetId = useRef<string>()
	const hydratedDefaultTask = useRef(false)
	const availableProfile = listApiConfigMeta.find(
		(profile) => profile.id === apiConfig?.id && profile.name === apiConfig.name,
	)
	const availableSkill = skills.find((skill) => skill.name === skillName && (!skillPath || skill.path === skillPath))

	useEffect(() => {
		setSkills([])
		if (executionType !== "skill") return
		const requestId = crypto.randomUUID()
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "scheduledTaskSkills" && event.data.scheduledTaskSkills?.requestId === requestId) {
				setSkills(event.data.scheduledTaskSkills.skills)
			}
		}
		window.addEventListener("message", handleMessage)
		vscode.postMessage({
			type: "requestScheduledTaskSkills",
			scheduledTaskSkillsRequest: { requestId, workspace, mode: taskMode },
		})
		return () => window.removeEventListener("message", handleMessage)
	}, [executionType, workspace, taskMode])

	const runsForSelected = useMemo(
		() => scheduledTaskRuns.filter((run) => run.taskId === selectedId).slice(0, 20),
		[scheduledTaskRuns, selectedId],
	)

	const resetForm = () => {
		handledTargetId.current = targetTaskId
		hydratedDefaultTask.current = true
		setName("")
		setPrompt("")
		setExecutionType("prompt")
		setCommand("")
		setTimeoutMinutes(10)
		setSkillName("")
		setSkillPath(undefined)
		setApiConfig(undefined)
		setWorkspace(cwd)
		setPluginName("")
		setExecutionArguments("")
		setTaskMode(normalizeUserFacingModeSlug(mode))
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
			setSkillPath(execution.type === "skill" ? execution.skillPath : undefined)
			setApiConfig(task.apiConfig)
			setWorkspace(task.workspace ?? cwd)
			setPluginName(execution.type === "plugin" ? execution.pluginName : "")
			setExecutionArguments(
				execution.type === "skill" || execution.type === "plugin" ? (execution.arguments ?? "") : "",
			)
			setTaskMode(task.mode ?? normalizeUserFacingModeSlug(mode))
			const approval = normalizeAutoApproval(task.autoApproval)
			setAutoApproval(
				execution.type === "command"
					? { ...approval, autoApprovalEnabled: true, alwaysAllowExecute: true }
					: approval,
			)
			setScheduleType(task.schedule.type)
			setStartAt(localDateTimeValue(task.schedule.startAt))
			setIntervalValue(getInterval(task.schedule))
			setNotificationPreference(task.notificationPreference)
		},
		[mode, cwd],
	)

	useEffect(() => {
		if (targetTaskId) {
			if (handledTargetId.current === targetTaskId) {
				return
			}

			const targetTask = scheduledTasks.find((task) => task.id === targetTaskId)
			if (targetTask) {
				editTask(targetTask)
				handledTargetId.current = targetTaskId
				hydratedDefaultTask.current = true
			}
			return
		}

		if (!hydratedDefaultTask.current && scheduledTasks[0]) {
			editTask(scheduledTasks[0])
			hydratedDefaultTask.current = true
		}
	}, [editTask, targetTaskId, scheduledTasks])

	const startAtTimestamp = fromLocalDateTimeValue(startAt)
	const canSave =
		Boolean(name.trim()) &&
		(executionType === "skill" || Boolean(prompt.trim())) &&
		(executionType === "command" || Boolean(availableProfile)) &&
		Number.isFinite(startAtTimestamp) &&
		(scheduleType === "once" || (Number.isInteger(interval) && interval > 0)) &&
		(executionType !== "command" ||
			(Boolean(command.trim()) && Number.isInteger(timeoutMinutes) && timeoutMinutes > 0)) &&
		(executionType !== "skill" || Boolean(availableSkill)) &&
		(executionType !== "plugin" || Boolean(pluginName.trim()))

	const save = () => {
		if (!canSave) {
			return
		}

		const schedule = buildSchedule(scheduleType, startAtTimestamp, timezone, interval)
		const execution: ScheduledTaskExecution =
			executionType === "command"
				? { type: "command", command, timeoutMs: Math.max(1, timeoutMinutes) * 60 * 1000 }
				: executionType === "skill"
					? {
							type: "skill",
							skillName,
							skillPath: availableSkill?.path,
							arguments: executionArguments || undefined,
						}
					: executionType === "plugin"
						? { type: "plugin", pluginName, arguments: executionArguments || undefined }
						: { type: "prompt" }
		const payload = {
			name,
			prompt,
			apiConfig,
			execution,
			mode: taskMode,
			autoApproval:
				executionType === "command"
					? { ...autoApproval, autoApprovalEnabled: true, alwaysAllowExecute: true }
					: autoApproval,
			schedule,
			workspace,
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
			<TabHeader className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						className="-ml-2 shrink-0"
						onClick={onDone}
						aria-label="Back to chat">
						<ArrowLeft />
					</Button>
					<CalendarClock className="size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
					<h3 className="m-0 truncate text-sm font-semibold">Scheduled Tasks</h3>
				</div>
				<Button variant="secondary" size="sm" onClick={resetForm}>
					<Plus />
					New
				</Button>
			</TabHeader>
			<TabContent className="p-0">
				<div className="grid min-h-full grid-cols-1 min-[800px]:grid-cols-[250px_minmax(0,1fr)]">
					<nav
						aria-label="Scheduled Tasks"
						className="min-w-0 border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 min-[800px]:border-b-0 min-[800px]:border-r">
						{scheduledTasks.length === 0 ? (
							<div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-vscode-descriptionForeground min-[800px]:py-10">
								<CalendarClock className="mb-1 size-6" aria-hidden="true" />
								<p className="m-0 text-sm font-medium text-vscode-foreground">
									No scheduled tasks yet.
								</p>
								<p className="m-0 max-w-64 text-xs leading-relaxed">{t("scheduledTasks:emptyHelp")}</p>
							</div>
						) : (
							<div className="flex gap-2 overflow-x-auto p-1 min-[800px]:flex-col">
								{scheduledTasks.map((task) => (
									<button
										key={task.id}
										type="button"
										aria-current={task.id === selectedId ? "true" : undefined}
										className={cn(
											"flex w-60 shrink-0 flex-col gap-2 rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder min-[800px]:w-full",
											task.id === selectedId
												? "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)]"
												: "border-transparent bg-transparent hover:bg-[var(--surface-raised)]",
										)}
										onClick={() => editTask(task)}>
										<div className="flex w-full items-start justify-between gap-2">
											<span
												className="line-clamp-2 break-words text-sm font-medium"
												title={task.name}>
												{task.name}
											</span>
											<span className="shrink-0 rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-vscode-descriptionForeground">
												{task.enabled ? "Enabled" : "Paused"}
											</span>
										</div>
										<span className="text-xs text-vscode-descriptionForeground">
											{describeSchedule(task.schedule)}
										</span>
										<span className="flex items-start gap-1.5 text-xs text-vscode-descriptionForeground">
											<Clock3 className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
											<span>
												{t("scheduledTasks:nextRun")}: {formatTime(task.nextRunAt)}
											</span>
										</span>
									</button>
								))}
							</div>
						)}
					</nav>
					<div className="@container min-w-0">
						<div className="mx-auto max-w-3xl px-4 py-5 @min-[480px]:px-7">
							<div className="mb-6 flex items-start justify-between gap-3">
								<div className="min-w-0">
									<h2 className="m-0 break-words text-lg font-semibold">
										{selectedTask?.name ?? t("scheduledTasks:newTask")}
									</h2>
									<div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-vscode-descriptionForeground">
										<Folder className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="truncate" title={workspace}>
											Workspace: {workspace || "current workspace"}
										</span>
									</div>
								</div>
								{selectedTask && (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="shrink-0"
												aria-label={t("scheduledTasks:moreActions")}>
												<Ellipsis />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onSelect={() =>
													vscode.postMessage({
														type: selectedTask.enabled
															? "pauseScheduledTask"
															: "resumeScheduledTask",
														scheduledTaskId: selectedTask.id,
													})
												}>
												{selectedTask.enabled ? <Pause /> : <Play />}
												{selectedTask.enabled ? "Pause" : "Resume"}
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() =>
													vscode.postMessage({
														type: "duplicateScheduledTask",
														scheduledTaskId: selectedTask.id,
													})
												}>
												<Copy />
												Duplicate
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												className="text-vscode-errorForeground"
												onSelect={() => {
													vscode.postMessage({
														type: "deleteScheduledTask",
														scheduledTaskId: selectedTask.id,
													})
													resetForm()
												}}>
												<Trash2 />
												Delete
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								)}
							</div>
							<form
								id="scheduled-task-form"
								onSubmit={(event) => {
									event.preventDefault()
									save()
								}}
								className="flex flex-col gap-6">
								<section aria-labelledby="task-details-heading" className="flex flex-col gap-4">
									<h3 id="task-details-heading" className="m-0 text-sm font-semibold">
										{t("scheduledTasks:taskDetails")}
									</h3>
									<div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2">
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Name
											<Input value={name} onChange={(event) => setName(event.target.value)} />
										</label>
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Execution
											<Select
												value={executionType}
												onValueChange={(value) => {
													const next = value as ExecutionKind
													setExecutionType(next)
													if (next !== "skill") {
														setSkillName("")
														setSkillPath(undefined)
														setExecutionArguments("")
													}
													if (next === "command") {
														setAutoApproval((current) => ({
															...current,
															autoApprovalEnabled: true,
															alwaysAllowExecute: true,
														}))
													}
												}}>
												<SelectTrigger className="w-full min-w-0" aria-label="Execution">
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
									</div>
									<div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2">
										{executionType !== "command" && (
											<label className="flex min-w-0 flex-col gap-2 text-sm">
												{t("scheduledTasks:profile")}
												<Select
													value={availableProfile?.id ?? ""}
													onValueChange={(id) => {
														const profile = listApiConfigMeta.find(
															(candidate) => candidate.id === id,
														)
														if (profile)
															setApiConfig({ id: profile.id, name: profile.name })
													}}>
													<SelectTrigger
														className="w-full min-w-0"
														aria-label={t("scheduledTasks:profile")}>
														<SelectValue placeholder={t("scheduledTasks:selectProfile")} />
													</SelectTrigger>
													<SelectContent>
														{listApiConfigMeta
															.filter((profile) => profile.id)
															.map((profile) => (
																<SelectItem key={profile.id} value={profile.id}>
																	{profile.name}
																	{profile.modelId ? ` · ${profile.modelId}` : ""}
																</SelectItem>
															))}
													</SelectContent>
												</Select>
												{apiConfig && !availableProfile && (
													<span role="status">
														{t("scheduledTasks:unavailableProfile", {
															name: apiConfig.name,
														})}
													</span>
												)}
											</label>
										)}

										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Mode
											<Select value={taskMode} onValueChange={setTaskMode}>
												<SelectTrigger className="w-full min-w-0" aria-label="Mode">
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
									</div>
									{executionType === "command" && (
										<div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-[minmax(0,1fr)_140px]">
											<label className="flex min-w-0 flex-col gap-2 text-sm">
												Command
												<Input
													value={command}
													onChange={(event) => setCommand(event.target.value)}
												/>
											</label>
											<label className="flex min-w-0 flex-col gap-2 text-sm">
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
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Skill
											<Select
												value={availableSkill?.name ?? ""}
												onValueChange={(name) => {
													setSkillName(name)
													setSkillPath(skills.find((skill) => skill.name === name)?.path)
												}}>
												<SelectTrigger className="w-full min-w-0" aria-label="Skill">
													<SelectValue placeholder={t("scheduledTasks:selectSkill")} />
												</SelectTrigger>
												<SelectContent>
													{skills.map((skill) => (
														<SelectItem key={skill.name} value={skill.name}>
															{skill.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<span className="text-xs text-vscode-descriptionForeground" role="status">
												{availableSkill?.description ?? t("scheduledTasks:skillUnavailable")}
											</span>
										</label>
									)}
									{executionType === "plugin" && (
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Plugin
											<Input
												value={pluginName}
												onChange={(event) => setPluginName(event.target.value)}
											/>
										</label>
									)}
									{(executionType === "skill" || executionType === "plugin") && (
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Arguments
											<Textarea
												value={executionArguments}
												onChange={(event) => setExecutionArguments(event.target.value)}
												rows={3}
											/>
										</label>
									)}

									<label className="flex min-w-0 flex-col gap-2 text-sm">
										{executionType === "skill" ? t("scheduledTasks:extraPrompt") : "Prompt"}
										<Textarea
											value={prompt}
											onChange={(event) => setPrompt(event.target.value)}
											rows={4}
											className="min-h-24 resize-y leading-relaxed"
											aria-describedby={
												executionType === "prompt" || executionType === "skill"
													? "scheduled-prompt-help"
													: undefined
											}
										/>
									</label>
									{(executionType === "prompt" || executionType === "skill") && (
										<p
											id="scheduled-prompt-help"
											className="-mt-2 mb-0 text-xs leading-relaxed text-vscode-descriptionForeground">
											{t(
												executionType === "skill"
													? "scheduledTasks:skillHelp"
													: "scheduledTasks:promptHelp",
											)}
										</p>
									)}
								</section>
								<section
									aria-labelledby="schedule-heading"
									className="flex flex-col gap-4 border-t border-[var(--border-subtle)] pt-5">
									<h3
										id="schedule-heading"
										className="m-0 flex items-center gap-2 text-sm font-semibold">
										<CalendarClock
											className="size-4 text-vscode-descriptionForeground"
											aria-hidden="true"
										/>
										Schedule
									</h3>
									<div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2">
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Schedule
											<Select
												value={scheduleType}
												onValueChange={(value) => setScheduleType(value as ScheduleKind)}>
												<SelectTrigger className="w-full min-w-0" aria-label="Schedule">
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

										{scheduleType !== "once" && (
											<label className="flex min-w-0 flex-col gap-2 text-sm">
												<span>{t("scheduledTasks:repeatEvery")}</span>
												<div className="flex items-center gap-2">
													<Input
														className="w-20"
														aria-label={t("scheduledTasks:repeatEvery")}
														type="number"
														min={1}
														value={interval}
														onChange={(event) =>
															setIntervalValue(Number(event.target.value))
														}
													/>
													<span className="text-vscode-descriptionForeground">
														{t(intervalUnitKeys[scheduleType])}
													</span>
												</div>
											</label>
										)}
									</div>
									<div className="grid grid-cols-1 gap-4 @min-[560px]:grid-cols-2">
										<div className="flex min-w-0 flex-col gap-2">
											<label className="flex min-w-0 flex-col gap-2 text-sm">
												Start
												<Input
													type="datetime-local"
													className="min-w-0 max-w-full [.vscode-dark_&]:[color-scheme:dark] [.vscode-high-contrast_&]:[color-scheme:dark]"
													value={startAt}
													onChange={(event) => setStartAt(event.target.value)}
													aria-describedby="scheduled-timezone"
												/>
											</label>
											<span
												id="scheduled-timezone"
												className="text-xs text-vscode-descriptionForeground">
												{timezone}
											</span>
										</div>
										<label className="flex min-w-0 flex-col gap-2 text-sm">
											Notifications
											<Select
												value={notificationPreference}
												onValueChange={(value) =>
													setNotificationPreference(
														value as ScheduledTaskNotificationPreference,
													)
												}>
												<SelectTrigger className="w-full min-w-0" aria-label="Notifications">
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
									</div>
								</section>
								<Collapsible className="border-t border-[var(--border-subtle)] pt-5">
									<CollapsibleTrigger
										type="button"
										className="group flex w-full items-center gap-2 rounded bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
										<Shield
											className="size-4 shrink-0 text-vscode-descriptionForeground"
											aria-hidden="true"
										/>
										<span className="text-sm font-semibold">Auto-approval</span>
										<span className="ml-auto text-xs text-vscode-descriptionForeground">
											{autoApproval.autoApprovalEnabled
												? t("scheduledTasks:approvalSummary", {
														count: approvalOptions.filter(([key]) => autoApproval[key])
															.length,
													})
												: "Ask"}
										</span>
										<ChevronDown
											className="size-4 shrink-0 text-vscode-descriptionForeground group-data-[state=open]:rotate-180"
											aria-hidden="true"
										/>
									</CollapsibleTrigger>
									<CollapsibleContent className="pt-4">
										<label className="mb-4 flex items-center gap-2 text-sm">
											<Checkbox
												checked={autoApproval.autoApprovalEnabled}
												disabled={executionType === "command"}
												onCheckedChange={(checked) =>
													setAutoApproval((current) => ({
														...current,
														autoApprovalEnabled: checked === true,
													}))
												}
											/>
											{t("scheduledTasks:enableAutoApproval")}
										</label>
										<div className="grid grid-cols-1 gap-x-4 gap-y-3 @min-[420px]:grid-cols-2">
											{approvalOptions.map(([key, label]) => (
												<label key={key} className="flex items-center gap-2 text-sm">
													<Checkbox
														checked={autoApproval[key]}
														disabled={
															!autoApproval.autoApprovalEnabled ||
															(executionType === "command" &&
																key === "alwaysAllowExecute")
														}
														onCheckedChange={(checked) =>
															setAutoApproval((current) => ({
																...current,
																[key]: checked === true,
															}))
														}
													/>
													{label}
												</label>
											))}
										</div>
										<p className="mb-0 mt-4 text-xs leading-relaxed text-vscode-descriptionForeground">
											Commits, pushes, and pull requests stay disabled for scheduled tasks.
										</p>
										{executionType === "command" && (
											<p className="mb-0 mt-2 text-xs text-vscode-descriptionForeground">
												Command runs in the configured workspace.
											</p>
										)}
									</CollapsibleContent>
								</Collapsible>
							</form>
							{selectedTask && (
								<section
									aria-labelledby="run-history-heading"
									className="mt-6 border-t border-[var(--border-subtle)] pt-5">
									<h3
										id="run-history-heading"
										className="mb-4 mt-0 flex items-center gap-2 text-sm font-semibold">
										<History
											className="size-4 text-vscode-descriptionForeground"
											aria-hidden="true"
										/>
										Run History
										<span className="ml-auto text-xs font-normal text-vscode-descriptionForeground">
											{runsForSelected.length}
										</span>
									</h3>
									{runsForSelected.length === 0 ? (
										<p className="m-0 text-xs text-vscode-descriptionForeground">No runs yet.</p>
									) : (
										<div className="divide-y divide-[var(--border-subtle)]">
											{runsForSelected.map((run) => (
												<details key={run.id} className="group py-3 first:pt-0">
													<summary className="flex cursor-pointer list-none items-start gap-2 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder [&::-webkit-details-marker]:hidden">
														<ChevronRight
															className="mt-0.5 size-3.5 shrink-0 text-vscode-descriptionForeground group-open:rotate-90"
															aria-hidden="true"
														/>
														<div className="min-w-0 flex-1">
															<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
																<span className="font-medium capitalize">
																	{run.status.replaceAll("_", " ")}
																</span>
																<span className="text-vscode-descriptionForeground">
																	{formatTime(run.scheduledFor)}
																</span>
															</div>
															<p className="mb-0 mt-1 truncate text-xs text-vscode-descriptionForeground">
																{run.summary ??
																	run.error ??
																	run.skipReason ??
																	"No summary yet."}
															</p>
														</div>
													</summary>
													<div className="ml-5 mt-3 flex flex-col gap-2 text-xs text-vscode-descriptionForeground">
														<span>
															{describeExecution(run.execution)}
															{run.resolvedApiConfig &&
																" · " + run.resolvedApiConfig.name}
														</span>
														<p className="m-0 whitespace-pre-wrap break-words">
															{run.summary ?? run.error ?? run.skipReason}
														</p>
														{run.alphaTaskId && (
															<span className="break-all">
																Alpha task: {run.alphaTaskId}
															</span>
														)}
														{run.output && (
															<pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
																{run.output}
															</pre>
														)}
													</div>
												</details>
											))}
										</div>
									)}
								</section>
							)}
						</div>
						<div className="sticky bottom-0 z-10 border-t border-[var(--border-subtle)] bg-vscode-editor-background">
							<div className="mx-auto flex max-w-3xl items-center justify-end gap-2 px-4 py-3 @min-[480px]:px-7">
								{selectedTask && (
									<Button
										variant="secondary"
										onClick={() =>
											vscode.postMessage({
												type: "runScheduledTaskNow",
												scheduledTaskId: selectedTask.id,
											})
										}>
										<Play />
										Run Now
									</Button>
								)}
								<Button type="submit" form="scheduled-task-form" variant="primary" disabled={!canSave}>
									{selectedTask ? "Save" : "Create"}
								</Button>
							</div>
						</div>
					</div>
				</div>
			</TabContent>
		</Tab>
	)
}

export default ScheduledTasksView
