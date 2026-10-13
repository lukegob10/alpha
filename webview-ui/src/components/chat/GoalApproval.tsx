import { DEFAULT_TASK_GOAL_MAX_CONTINUATIONS, goalToolApprovalSchema } from "@alpha-code/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"

/** Always display the concrete objective before the existing approval buttons can authorize it. */
export function GoalApproval({ activity }: { activity: unknown }) {
	const { t } = useAppTranslation()
	const parsed = goalToolApprovalSchema.safeParse(activity)
	if (!parsed.success) return <div role="alert">{t("chat:goals.invalidApproval")}</div>
	const goal = parsed.data
	return (
		<div className="min-w-0 space-y-2 break-words" role="group" aria-label={t("chat:goals.approval")}>
			<div className="font-medium">
				{t(goal.operation === "create" ? "chat:goals.createApproval" : "chat:goals.pauseApproval")}
			</div>
			<div className="whitespace-pre-wrap">{goal.objective}</div>
			{goal.operation === "create" && (
				<div className="text-vscode-descriptionForeground">
					{goal.tokenBudget === undefined
						? t("chat:goals.noBudget")
						: t("chat:goals.budget", { tokens: goal.tokenBudget })}
					<div>{t("chat:goals.continuationLimit", { limit: DEFAULT_TASK_GOAL_MAX_CONTINUATIONS })}</div>
				</div>
			)}
		</div>
	)
}
