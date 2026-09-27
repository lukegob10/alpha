import { type FormEvent, useMemo, useRef, useState } from "react"

import type { RequestUserInputAnswerMap, RequestUserInputData, RequestUserInputQuestion } from "@alpha-code/types"
import { Button } from "@/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface RequestUserInputFormProps {
	request: RequestUserInputData
	onSubmit: (answers: RequestUserInputAnswerMap) => void
	onCancel?: () => void
	onInteraction?: () => void
	isAnswered?: boolean
}

interface SelectedAnswer {
	value: string
	isOther: boolean
}

const OTHER_VALUE = "__alpha_other__"

export const RequestUserInputForm = ({
	request,
	onSubmit,
	onCancel,
	onInteraction,
	isAnswered = false,
}: RequestUserInputFormProps) => {
	const { t } = useAppTranslation()
	const [selectedAnswers, setSelectedAnswers] = useState<Record<string, SelectedAnswer>>({})
	const hasCancelledAutoApproval = useRef(false)
	const cancelAutoApproval = () => {
		if (hasCancelledAutoApproval.current) return
		hasCancelledAutoApproval.current = true
		onInteraction?.()
	}
	const isComplete = useMemo(
		() =>
			request.questions.length > 0 &&
			request.questions.every((question) => {
				const selected = selectedAnswers[question.id]
				return Boolean(selected && selected.value.trim())
			}),
		[request.questions, selectedAnswers],
	)

	const updateAnswer = (question: RequestUserInputQuestion, answer: SelectedAnswer) => {
		cancelAutoApproval()
		setSelectedAnswers((current) => ({ ...current, [question.id]: answer }))
	}

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!isComplete || isAnswered) return

		const answers: RequestUserInputAnswerMap = {}
		for (const question of request.questions) {
			const selected = selectedAnswers[question.id]
			if (!selected?.value.trim()) return
			answers[question.id] = { answers: [selected.value.trim()] }
		}
		cancelAutoApproval()
		onSubmit(answers)
	}

	return (
		<form className="flex flex-col gap-4" onSubmit={handleSubmit} aria-label={t("chat:requestUserInput.title")}>
			{request.questions.map((question, index) => {
				const selected = selectedAnswers[question.id]
				const groupName = `request-user-input-${question.id}`
				return (
					<fieldset
						key={question.id}
						className="min-w-0 rounded-md border border-vscode-panel-border p-3"
						disabled={isAnswered}>
						<legend className="px-1 font-semibold">
							<span className="mr-2 rounded bg-vscode-badge-background px-1.5 py-0.5 text-xs text-vscode-badge-foreground">
								{question.header}
							</span>
							<span>{question.question}</span>
						</legend>
						<div className="flex flex-col gap-2 pt-2">
							{question.options.map((option) => (
								<label
									key={option.label}
									className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-vscode-list-hoverBackground">
									<input
										type="radio"
										name={groupName}
										value={option.label}
										checked={selected?.isOther !== true && selected?.value === option.label}
										onChange={() => updateAnswer(question, { value: option.label, isOther: false })}
										style={{ accentColor: "var(--vscode-focusBorder)" }}
									/>
									<span className="flex min-w-0 flex-col">
										<span className="font-medium">{option.label}</span>
										<span className="text-xs text-vscode-descriptionForeground">
											{option.description}
										</span>
									</span>
								</label>
							))}
							<label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-vscode-list-hoverBackground">
								<input
									type="radio"
									name={groupName}
									value={OTHER_VALUE}
									checked={selected?.isOther === true}
									onChange={() => updateAnswer(question, { value: "", isOther: true })}
									style={{ accentColor: "var(--vscode-focusBorder)" }}
								/>
								<span className="font-medium">{t("chat:requestUserInput.other")}</span>
							</label>
							{selected?.isOther && (
								<input
									type="text"
									className="ml-6 w-[calc(100%-1.5rem)] rounded border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-vscode-input-foreground"
									aria-label={t("chat:requestUserInput.otherAnswer", {
										header: question.header,
										index: index + 1,
									})}
									placeholder={t("chat:requestUserInput.otherPlaceholder")}
									value={selected.value}
									onChange={(event) =>
										updateAnswer(question, { ...selected, value: event.currentTarget.value })
									}
								/>
							)}
						</div>
					</fieldset>
				)
			})}
			<div className="flex justify-end gap-2">
				{onCancel && (
					<Button type="button" variant="secondary" disabled={isAnswered} onClick={onCancel}>
						{t("chat:requestUserInput.cancel")}
					</Button>
				)}
				<Button type="submit" disabled={!isComplete || isAnswered}>
					{t("chat:requestUserInput.submit")}
				</Button>
			</div>
		</form>
	)
}
