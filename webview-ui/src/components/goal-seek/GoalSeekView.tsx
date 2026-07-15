import React, { useMemo, useState } from "react"
import { ArrowLeft, Plus, RotateCcw, Target, Trash2, XCircle } from "lucide-react"

import type { GoalSeekJob, GoalSeekScoreDirection, GoalSeekVerifier, GoalSeekVerifierResult } from "@alpha-code/types"
import { getRecommendedModes } from "@alpha/modes"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@/components/ui"

import { Tab, TabContent, TabHeader } from "../common/Tab"

type GoalSeekViewProps = {
	onDone: () => void
	targetJobId?: string
}

type VerifierKind = GoalSeekVerifier["type"]

const formatTime = (time?: number) => (time ? new Date(time).toLocaleString() : "Never")

const scoreLabel = (result?: GoalSeekVerifierResult) => {
	if (!result) {
		return "No score"
	}
	return `${result.score} (${result.improved ? "improved" : "not improved"})`
}

const GoalSeekView = ({ onDone, targetJobId }: GoalSeekViewProps) => {
	const { goalSeekJobs = [], goalSeekRuns = [], goalSeekAttempts = [], cwd, mode, customModes } = useExtensionState()
	const [selectedId, setSelectedId] = useState<string | undefined>(targetJobId ?? goalSeekJobs[0]?.id)
	const selectedJob = goalSeekJobs.find((job) => job.id === selectedId)
	const selectedRuns = goalSeekRuns.filter((run) => run.jobId === selectedId)
	const latestRun = selectedRuns[0]
	const attemptsForLatestRun = latestRun ? goalSeekAttempts.filter((attempt) => attempt.runId === latestRun.id) : []

	const [name, setName] = useState("")
	const [goal, setGoal] = useState("")
	const [verifierType, setVerifierType] = useState<VerifierKind>("promptAndCommand")
	const [verifierPrompt, setVerifierPrompt] = useState("")
	const [verifierCommand, setVerifierCommand] = useState("")
	const [direction, setDirection] = useState<GoalSeekScoreDirection>("maximize")
	const [targetScore, setTargetScore] = useState(100)
	const [maxAttempts, setMaxAttempts] = useState(10)
	const [maxFailedAttempts, setMaxFailedAttempts] = useState(3)
	const [candidateCount, setCandidateCount] = useState(10)
	const [jobMode, setJobMode] = useState<string>(mode)
	const modes = useMemo(() => getRecommendedModes(customModes, jobMode), [customModes, jobMode])

	const resetForm = () => {
		setSelectedId(undefined)
		setName("")
		setGoal("")
		setVerifierType("promptAndCommand")
		setVerifierPrompt("")
		setVerifierCommand("")
		setDirection("maximize")
		setTargetScore(100)
		setMaxAttempts(10)
		setMaxFailedAttempts(3)
		setCandidateCount(10)
		setJobMode(mode)
	}

	const editJob = (job: GoalSeekJob) => {
		setSelectedId(job.id)
		setName(job.name)
		setGoal(job.goal)
		setVerifierType(job.verifier.type)
		setVerifierPrompt("prompt" in job.verifier ? job.verifier.prompt : "")
		setVerifierCommand("command" in job.verifier ? job.verifier.command : "")
		setDirection(job.direction)
		setTargetScore(job.targetScore)
		setMaxAttempts(job.maxAttempts)
		setMaxFailedAttempts(job.maxFailedAttempts)
		setCandidateCount(job.candidateCount)
		setJobMode(job.mode ?? mode)
	}

	const buildVerifier = (): GoalSeekVerifier =>
		verifierType === "prompt"
			? { type: "prompt", prompt: verifierPrompt }
			: verifierType === "command"
				? { type: "command", command: verifierCommand }
				: { type: "promptAndCommand", prompt: verifierPrompt, command: verifierCommand }

	const save = () => {
		const payload = {
			name,
			goal,
			verifier: buildVerifier(),
			direction,
			targetScore,
			maxAttempts,
			maxFailedAttempts,
			candidateCount,
			mode: jobMode,
			workspace: cwd,
		}
		if (selectedJob) {
			vscode.postMessage({
				type: "updateGoalSeekJob",
				goalSeekJobId: selectedJob.id,
				goalSeekJobUpdate: payload,
			})
		} else {
			vscode.postMessage({ type: "createGoalSeekJob", goalSeekJob: payload })
		}
	}

	const activeRun = selectedRuns.find((run) => run.status === "running" || run.status === "queued")
	const canSave =
		name.trim() &&
		goal.trim() &&
		(verifierType === "command" || verifierPrompt.trim()) &&
		(verifierType === "prompt" || verifierCommand.trim())

	return (
		<Tab>
			<TabHeader className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Button variant="ghost" className="px-1.5 -ml-2" onClick={onDone} aria-label="Back to chat">
						<ArrowLeft />
					</Button>
					<Target className="size-4" />
					<h3 className="text-vscode-foreground m-0">Goal Seek</h3>
				</div>
				<Button variant="secondary" onClick={resetForm}>
					<Plus />
					New
				</Button>
			</TabHeader>
			<TabContent className="p-0">
				<div className="grid grid-cols-[minmax(240px,0.9fr)_minmax(360px,1.4fr)] min-h-full">
					<div className="border-r border-vscode-panel-border p-3 overflow-auto">
						{goalSeekJobs.length === 0 ? (
							<div className="text-vscode-descriptionForeground text-sm px-2 py-4">
								No goal-seek jobs yet.
							</div>
						) : (
							<div className="flex flex-col gap-2">
								{goalSeekJobs.map((job) => {
									const run = goalSeekRuns.find((candidate) => candidate.jobId === job.id)
									return (
										<button
											key={job.id}
											className={`text-left border rounded-sm p-3 bg-vscode-editor-background hover:bg-vscode-list-hoverBackground ${
												job.id === selectedId
													? "border-vscode-focusBorder"
													: "border-vscode-panel-border"
											}`}
											onClick={() => editJob(job)}>
											<div className="flex items-center justify-between gap-2">
												<div className="font-medium truncate">{job.name}</div>
												<span className="text-xs text-vscode-descriptionForeground">
													{job.direction}
												</span>
											</div>
											<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
												Target: {job.targetScore} | Attempts: {job.maxAttempts}
											</div>
											<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
												Last: {job.lastRunStatus ?? run?.status ?? "never"}
											</div>
										</button>
									)
								})}
							</div>
						)}
					</div>
					<div className="p-4 overflow-auto">
						<div className="flex flex-col gap-3 max-w-4xl">
							<label className="flex flex-col gap-1 text-sm">
								Name
								<Input value={name} onChange={(event) => setName(event.target.value)} />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								Goal
								<Textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} />
							</label>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1 text-sm">
									Verifier
									<Select
										value={verifierType}
										onValueChange={(value) => setVerifierType(value as VerifierKind)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="promptAndCommand">Prompt + Command</SelectItem>
											<SelectItem value="prompt">Prompt</SelectItem>
											<SelectItem value="command">Command</SelectItem>
										</SelectContent>
									</Select>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Direction
									<Select
										value={direction}
										onValueChange={(value) => setDirection(value as GoalSeekScoreDirection)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="maximize">Maximize</SelectItem>
											<SelectItem value="minimize">Minimize</SelectItem>
										</SelectContent>
									</Select>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Mode
									<Select value={jobMode} onValueChange={setJobMode}>
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
							</div>
							{verifierType !== "command" && (
								<label className="flex flex-col gap-1 text-sm">
									Verifier prompt
									<Textarea
										value={verifierPrompt}
										onChange={(event) => setVerifierPrompt(event.target.value)}
										rows={4}
									/>
								</label>
							)}
							{verifierType !== "prompt" && (
								<label className="flex flex-col gap-1 text-sm">
									Verifier command
									<Input
										value={verifierCommand}
										onChange={(event) => setVerifierCommand(event.target.value)}
									/>
								</label>
							)}
							<div className="grid grid-cols-4 gap-2">
								<label className="flex flex-col gap-1 text-sm">
									Target score
									<Input
										type="number"
										value={targetScore}
										onChange={(event) => setTargetScore(Number(event.target.value))}
									/>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Max attempts
									<Input
										type="number"
										min={1}
										value={maxAttempts}
										onChange={(event) => setMaxAttempts(Number(event.target.value))}
									/>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Failed limit
									<Input
										type="number"
										min={0}
										value={maxFailedAttempts}
										onChange={(event) => setMaxFailedAttempts(Number(event.target.value))}
									/>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									Candidates
									<Input
										type="number"
										min={1}
										value={candidateCount}
										onChange={(event) => setCandidateCount(Number(event.target.value))}
									/>
								</label>
							</div>
							<div className="text-xs text-vscode-descriptionForeground">
								Workspace: {cwd || "current workspace"}. Failed attempts are rolled back to the previous
								git checkpoint.
							</div>
							<div className="flex flex-wrap gap-2">
								<Button variant="primary" onClick={save} disabled={!canSave}>
									{selectedJob ? "Save" : "Create"}
								</Button>
								{selectedJob && (
									<>
										<Button
											onClick={() =>
												vscode.postMessage({
													type: "runGoalSeekJob",
													goalSeekJobId: selectedJob.id,
												})
											}>
											<RotateCcw />
											Run
										</Button>
										{activeRun && (
											<Button
												onClick={() =>
													vscode.postMessage({
														type: "cancelGoalSeekRun",
														goalSeekRunId: activeRun.id,
													})
												}>
												<XCircle />
												Cancel
											</Button>
										)}
										<Button
											variant="destructive"
											onClick={() => {
												vscode.postMessage({
													type: "deleteGoalSeekJob",
													goalSeekJobId: selectedJob.id,
												})
												resetForm()
											}}>
											<Trash2 />
											Delete
										</Button>
									</>
								)}
							</div>
							{latestRun && (
								<div className="border-t border-vscode-panel-border pt-3 mt-2">
									<div className="font-medium mb-2">Latest Run</div>
									<div className="grid grid-cols-4 gap-2 text-xs text-vscode-descriptionForeground mb-3">
										<div>Status: {latestRun.status}</div>
										<div>Best: {latestRun.bestScore ?? "none"}</div>
										<div>Failed: {latestRun.failedAttempts}</div>
										<div>Started: {formatTime(latestRun.startedAt)}</div>
									</div>
									<div className="flex flex-col gap-2">
										{attemptsForLatestRun.map((attempt) => {
											const selected = attempt.candidates.find(
												(candidate) => candidate.id === attempt.selectedCandidateId,
											)
											return (
												<div
													key={attempt.id}
													className="border border-vscode-panel-border rounded-sm p-2">
													<div className="flex justify-between gap-2 text-sm">
														<span>
															#{attempt.iteration} {attempt.status}
														</span>
														<span className="text-vscode-descriptionForeground">
															{scoreLabel(attempt.verifierResult)}
														</span>
													</div>
													<div className="text-xs text-vscode-descriptionForeground mt-1">
														{selected?.title ?? "Planning candidates"}
													</div>
													{selected && (
														<div className="text-xs text-vscode-descriptionForeground mt-1">
															Utility {selected.utilityScore} | Reward{" "}
															{selected.expectedRewardImpact} | Risk{" "}
															{selected.directoryRisk} | Complexity {selected.complexity}
														</div>
													)}
													<div className="text-xs text-vscode-descriptionForeground mt-1">
														{attempt.verifierResult?.reason ??
															attempt.error ??
															attempt.summary ??
															"No result yet."}
													</div>
												</div>
											)
										})}
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

export default GoalSeekView
