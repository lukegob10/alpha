import type { Task, Trial } from "@alpha-code/evals"

export type TaskStatusCategory = "failed" | "in_progress" | "passed" | "not_scored" | "not_started"
export type TaskWithTrial = Task & { trial?: Pick<Trial, "status" | "finishedAt"> | null }

export function getTaskStatusCategory(task: TaskWithTrial, hasStreamingEvidence = false): TaskStatusCategory {
	if (task.passed === false) return "failed"
	if (task.passed === true) return "passed"
	if (task.trial?.finishedAt) return "not_scored"
	if (task.startedAt || hasStreamingEvidence) return "in_progress"
	return "not_started"
}
