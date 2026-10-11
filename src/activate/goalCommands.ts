import * as vscode from "vscode"
import { DEFAULT_TASK_GOAL_MAX_CONTINUATIONS, taskGoalObjectiveSchema, type TaskGoal } from "@alpha-code/types"

import type { AlphaProvider } from "../core/webview/AlphaProvider"
import { t } from "../i18n"

type GoalAction = "create" | "view" | "pause" | "resume" | "clear"
interface GoalQuickPickItem extends vscode.QuickPickItem {
	action: GoalAction
}

function positiveBudget(value: string): number | undefined {
	if (!value.trim()) return undefined
	const parsed = Number(value)
	return /^\d+$/.test(value.trim()) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

async function promptBudget(current?: number): Promise<{ tokenBudget?: number } | undefined> {
	const value = await vscode.window.showInputBox({
		title: t("common:goals.title"),
		prompt: t("common:goals.budgetPrompt"),
		value: current?.toString() ?? "",
		validateInput: (text) =>
			text.trim() && positiveBudget(text) === undefined ? t("common:goals.invalidBudget") : undefined,
	})
	if (value === undefined) return undefined
	return { tokenBudget: positiveBudget(value) }
}

function goalSummary(goal: TaskGoal): string {
	return t("common:goals.summary", {
		status: t(`common:goals.status.${goal.status}`),
		tokens: goal.tokensUsed,
		remaining:
			goal.tokenBudget === undefined
				? t("common:goals.noBudget")
				: Math.max(0, goal.tokenBudget - goal.tokensUsed),
		seconds: Math.round(goal.timeUsedMs / 1000),
		continuations: goal.continuationCount,
		limit: goal.maxContinuations,
	})
}

/** Capture the originating task before native UI awaits; navigation must never retarget a goal change. */
export async function manageTaskGoal(provider: Pick<AlphaProvider, "getCurrentTask" | "getLiveTask">): Promise<void> {
	const task = provider.getCurrentTask()
	if (!task) {
		await vscode.window.showInformationMessage(t("common:goals.noTask"))
		return
	}
	const available = () => provider.getLiveTask(task.taskId) === task && !task.abort && !task.abandoned

	try {
		const goal = await task.getGoal()
		const items: GoalQuickPickItem[] = []
		if (!goal || goal.status === "complete") items.push({ action: "create", label: t("common:goals.create") })
		if (goal) {
			items.push({ action: "view", label: t("common:goals.view"), description: goalSummary(goal) })
			if (goal.status === "active" && !goal.recoveryDeferred) {
				items.push({ action: "pause", label: t("common:goals.pause") })
			} else if (goal.status !== "complete") {
				items.push({ action: "resume", label: t("common:goals.resume") })
			}
			items.push({ action: "clear", label: t("common:goals.clear") })
		}
		const selected = await vscode.window.showQuickPick(items, {
			title: t("common:goals.title"),
			placeHolder:
				goal?.objective ?? t("common:goals.createDescription", { limit: DEFAULT_TASK_GOAL_MAX_CONTINUATIONS }),
		})
		if (!selected) return
		if (selected.action === "view" && goal) {
			await vscode.window.showInformationMessage(goal.objective, {
				modal: true,
				detail: `${goalSummary(goal)}${goal.recoveryDeferred ? `\n${t("common:goals.recoveryDeferred")}` : ""}`,
			})
			return
		}
		if (!available()) {
			await vscode.window.showErrorMessage(t("common:goals.taskUnavailable"))
			return
		}
		if (selected.action === "create") {
			const objective = await vscode.window.showInputBox({
				title: t("common:goals.title"),
				prompt: t("common:goals.objectivePrompt"),
				validateInput: (text) =>
					taskGoalObjectiveSchema.safeParse(text).success ? undefined : t("common:goals.invalidObjective"),
			})
			if (objective === undefined) return
			const budget = await promptBudget()
			if (!budget) return
			if (!available()) throw new Error("Goal command task changed")
			await task.createGoal(
				{ objective: objective.trim(), ...budget },
				{
					source: "user",
					approved: true,
					expectedGoalId: goal?.goalId ?? null,
					expectedVersion: goal?.version,
				},
			)
		} else {
			// State can change while the picker is open. Never clear/resume a replacement goal.
			const latest = await task.getGoal()
			if (
				!available() ||
				!goal ||
				latest?.goalId !== goal.goalId ||
				latest.controlVersion !== goal.controlVersion
			) {
				throw new Error("Goal command is stale")
			}
			if (selected.action === "pause") await task.pauseGoal(goal.goalId, goal.controlVersion)
			else if (selected.action === "clear") await task.clearGoal(goal.goalId, goal.controlVersion)
			else if (selected.action === "resume") {
				const budget = await promptBudget(goal.tokenBudget)
				if (!budget) return
				const current = await task.getGoal()
				if (!available() || current?.goalId !== goal.goalId || current.controlVersion !== goal.controlVersion) {
					throw new Error("Goal command is stale")
				}
				await task.resumeGoal({ tokenBudget: budget.tokenBudget ?? null }, goal.goalId, goal.controlVersion)
			}
		}
	} catch {
		await vscode.window.showErrorMessage(t("common:goals.updateFailed"))
	}
}
