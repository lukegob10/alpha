import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import type { AsyncUserInputData } from "@alpha-code/types"

interface AsyncUserInputCardProps {
	request: AsyncUserInputData
	isAnswered?: boolean
	isPending?: boolean
	onSubmit: (response: string) => boolean
}

export const AsyncUserInputCard = ({
	request,
	isAnswered = false,
	isPending = false,
	onSubmit,
}: AsyncUserInputCardProps) => {
	const { t } = useTranslation()
	const cardId = useId()
	const helpId = `${cardId}-help`
	const [answers, setAnswers] = useState<Record<number, string>>({})
	const disabled = isAnswered || isPending
	const canSubmit = request.questions.every((_, index) => Boolean(answers[index]?.trim()))

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (disabled || !canSubmit) return

		const answerText = request.questions
			.map((question, index) => `${question.title}\nAnswer: ${answers[index]!.trim()}`)
			.join("\n\n")
		const response = `${t("chat:asyncUserInput.responsePrefix")}\n\n${answerText}`
		onSubmit(response)
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={handleSubmit}
			aria-label={t("chat:asyncUserInput.title")}
			aria-busy={isPending}
			aria-describedby={disabled ? undefined : helpId}
			data-testid="async-user-input-card">
			{request.questions.map((question, index) => (
				<fieldset key={`${index}:${question.title}`} className="flex flex-col gap-2">
					<legend className="mb-1 font-medium">{question.title}</legend>
					{question.options?.map((option) => (
						<label key={option} className="flex cursor-pointer items-start gap-2">
							<input
								type="radio"
								name={`${cardId}-question-${index}`}
								value={option}
								checked={answers[index] === option}
								disabled={disabled}
								onChange={() => setAnswers((current) => ({ ...current, [index]: option }))}
							/>
							<span>{option}</span>
						</label>
					))}
					<label className="flex flex-col gap-1 text-vscode-descriptionForeground">
						<span>{t("chat:asyncUserInput.freeText")}</span>
						<input
							className="w-full rounded-sm border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-vscode-input-foreground"
							aria-label={t("chat:asyncUserInput.answerFor", { question: question.title })}
							value={answers[index] ?? ""}
							disabled={disabled}
							onChange={(event) => setAnswers((current) => ({ ...current, [index]: event.target.value }))}
						/>
					</label>
				</fieldset>
			))}
			<div className="flex items-center justify-between gap-2">
				{disabled ? (
					<span className="text-sm text-vscode-descriptionForeground" role="status">
						{t(isAnswered ? "chat:asyncUserInput.sent" : "chat:asyncUserInput.pending")}
					</span>
				) : (
					<span id={helpId} className="text-xs text-vscode-descriptionForeground">
						{t("chat:asyncUserInput.replyHelp")}
					</span>
				)}
				<button
					className="rounded-sm bg-vscode-button-background px-3 py-1 text-vscode-button-foreground hover:bg-vscode-button-hoverBackground disabled:cursor-default disabled:opacity-50"
					type="submit"
					disabled={disabled || !canSubmit}>
					{t("chat:asyncUserInput.submit")}
				</button>
			</div>
		</form>
	)
}
