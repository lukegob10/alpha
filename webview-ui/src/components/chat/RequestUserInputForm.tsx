import { type FormEvent, useEffect, useId, useRef, useState } from "react"

import type { RequestUserInputAnswerMap, RequestUserInputData, RequestUserInputQuestion } from "@alpha-code/types"
import { Button } from "@/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@/lib/utils"

interface RequestUserInputFormProps {
	request: RequestUserInputData
	onSubmit: (answers: RequestUserInputAnswerMap) => boolean | void
	onCancel?: () => void
	onInteraction?: () => void
	isAnswered?: boolean
}

interface SelectedAnswer {
	option?: string
	isOther: boolean
	customText: string
}

const OTHER_VALUE = "__alpha_other__"
const RECOMMENDED_SUFFIX = " (Recommended)"

const answerValue = (answer?: SelectedAnswer) => (answer?.isOther ? answer.customText.trim() : (answer?.option ?? ""))

export const RequestUserInputForm = (props: RequestUserInputFormProps) => (
	// Replayed requests can have new object identities. Keep their draft until the questions themselves change.
	<RequestUserInputFormContent key={JSON.stringify(props.request.questions)} {...props} />
)

const RequestUserInputFormContent = ({
	request,
	onSubmit,
	onCancel,
	onInteraction,
	isAnswered = false,
}: RequestUserInputFormProps) => {
	const { t } = useAppTranslation()
	const formId = useId()
	const [selectedAnswers, setSelectedAnswers] = useState<Record<string, SelectedAnswer>>({})
	const [questionIndex, setQuestionIndex] = useState(0)
	const [isReview, setIsReview] = useState(false)
	const [hasReviewed, setHasReviewed] = useState(false)
	const [isSubmitted, setIsSubmitted] = useState(false)
	const [sendFailed, setSendFailed] = useState(false)
	const submissionLocked = useRef(false)
	const wasAnswered = useRef(isAnswered)
	const headingRef = useRef<HTMLHeadingElement>(null)
	const customAnswerRef = useRef<HTMLTextAreaElement>(null)
	const pendingFocus = useRef<"heading" | "custom" | undefined>(undefined)
	const hasCancelledAutoApproval = useRef(false)
	const question = request.questions[questionIndex]
	const selected = question ? selectedAnswers[question.id] : undefined
	const answeredCount = request.questions.filter((item) =>
		Boolean(answerValue(selectedAnswers[item.id]).trim()),
	).length
	const isComplete = request.questions.length > 0 && answeredCount === request.questions.length
	const currentIsComplete = Boolean(answerValue(selected).trim())
	const isReviewAction = questionIndex === request.questions.length - 1 || (hasReviewed && isComplete)
	const questionHeadingId = `${formId}-question`

	useEffect(() => {
		if (wasAnswered.current && !isAnswered) {
			// A rejected host acknowledgement reopens the same draft rather than leaving it locally locked.
			submissionLocked.current = false
			setIsSubmitted(false)
			pendingFocus.current = "heading"
		}
		wasAnswered.current = isAnswered
	}, [isAnswered])

	useEffect(() => {
		if (isAnswered || isSubmitted || !pendingFocus.current) return
		if (pendingFocus.current === "custom") customAnswerRef.current?.focus()
		else headingRef.current?.focus()
		pendingFocus.current = undefined
	}, [questionIndex, isReview, selected?.isOther, isAnswered, isSubmitted])

	const cancelAutoApproval = () => {
		if (hasCancelledAutoApproval.current) return
		hasCancelledAutoApproval.current = true
		onInteraction?.()
	}

	const updateAnswer = (item: RequestUserInputQuestion, update: Partial<SelectedAnswer>) => {
		cancelAutoApproval()
		setSendFailed(false)
		setSelectedAnswers((current) => {
			const previous = Object.hasOwn(current, item.id) ? current[item.id] : { isOther: false, customText: "" }
			return { ...current, [item.id]: { ...previous, ...update } }
		})
	}

	const showQuestion = (index: number) => {
		cancelAutoApproval()
		setSendFailed(false)
		pendingFocus.current = "heading"
		if (index === questionIndex && !isReview) {
			headingRef.current?.focus()
			pendingFocus.current = undefined
		}
		setQuestionIndex(index)
		setIsReview(false)
	}

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (isAnswered || submissionLocked.current) return
		if (!isReview) {
			if (!currentIsComplete) return
			cancelAutoApproval()
			if (isReviewAction) {
				if (!isComplete) return
				pendingFocus.current = "heading"
				setHasReviewed(true)
				setIsReview(true)
			} else {
				showQuestion(questionIndex + 1)
			}
			return
		}
		if (!isComplete) return

		const answers: RequestUserInputAnswerMap = {}
		for (const item of request.questions) {
			answers[item.id] = { answers: [answerValue(selectedAnswers[item.id])] }
		}
		cancelAutoApproval()
		// Claim synchronously so two input events before React commits cannot send the group twice.
		submissionLocked.current = true
		if (onSubmit(answers) === false) {
			submissionLocked.current = false
			setSendFailed(true)
			return
		}
		setSendFailed(false)
		setIsSubmitted(true)
	}

	if (isAnswered) {
		return (
			<details className="min-w-0 text-xs text-vscode-descriptionForeground">
				<summary className="cursor-pointer">
					<span role="status">{t("chat:requestUserInput.closed")}</span>
				</summary>
				<div className="mt-3 flex min-w-0 flex-col gap-4 border-l border-vscode-panel-border pl-3">
					{request.questions.map((item) => (
						<div key={item.id} className="flex min-w-0 flex-col gap-2">
							<span>{item.header}</span>
							<p className="m-0 break-words text-sm font-medium text-vscode-foreground">
								{item.question}
							</p>
							<ul className="m-0 flex list-none flex-col gap-2 p-0">
								{item.options.map((option) => (
									<li key={option.label} className="flex min-w-0 flex-col gap-0.5">
										<span className="break-words text-vscode-foreground">{option.label}</span>
										<span className="break-words leading-relaxed">{option.description}</span>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</details>
		)
	}

	if (isSubmitted || !question) {
		return (
			<p className="m-0 text-xs text-vscode-descriptionForeground" role="status">
				{t(!question ? "chat:requestUserInput.closed" : "chat:requestUserInput.pending")}
			</p>
		)
	}

	return (
		<form
			className="flex min-w-0 flex-col gap-4"
			onSubmit={handleSubmit}
			aria-label={t("chat:requestUserInput.title")}
			data-testid="request-user-input-form">
			<div className="flex flex-col gap-1.5">
				<span className="text-xs text-vscode-descriptionForeground" role="status">
					{t("chat:requestUserInput.progress", { answered: answeredCount, total: request.questions.length })}
				</span>
				<p className="m-0 text-xs leading-relaxed text-vscode-descriptionForeground">
					{t(isReview ? "chat:requestUserInput.reviewDescription" : "chat:requestUserInput.intro")}
				</p>
			</div>
			{isReview ? (
				<div className="flex min-w-0 flex-col gap-3">
					<h3 ref={headingRef} tabIndex={-1} className="m-0 text-sm font-semibold">
						{t("chat:requestUserInput.reviewTitle")}
					</h3>
					<ol className="m-0 flex list-none flex-col divide-y divide-vscode-panel-border p-0">
						{request.questions.map((item, index) => (
							<li key={item.id} className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0">
								<div className="flex items-center justify-between gap-2">
									<span className="text-xs text-vscode-descriptionForeground">{item.header}</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										aria-label={t("chat:requestUserInput.editQuestion", { header: item.header })}
										onClick={() => showQuestion(index)}>
										{t("chat:requestUserInput.edit")}
									</Button>
								</div>
								<p className="m-0 break-words text-sm">{item.question}</p>
								<p className="m-0 whitespace-pre-wrap break-words text-sm font-medium">
									{answerValue(selectedAnswers[item.id])}
								</p>
							</li>
						))}
					</ol>
				</div>
			) : (
				<>
					<nav className="flex min-w-0 gap-1" aria-label={t("chat:requestUserInput.questions")}>
						{request.questions.map((item, index) => (
							<button
								key={item.id}
								type="button"
								className={cn(
									"min-w-0 flex-1 cursor-pointer border-0 border-b-2 bg-transparent px-1 py-2 text-xs disabled:cursor-default disabled:opacity-50",
									index === questionIndex
										? "border-vscode-focusBorder text-vscode-foreground"
										: "border-transparent text-vscode-descriptionForeground hover:text-vscode-foreground",
								)}
								aria-current={index === questionIndex ? "step" : undefined}
								aria-label={t("chat:requestUserInput.stepLabel", {
									header: item.header,
									index: index + 1,
									total: request.questions.length,
								})}
								disabled={index > questionIndex && !answerValue(selectedAnswers[item.id]).trim()}
								onClick={() => showQuestion(index)}>
								<span className="mr-1 text-vscode-descriptionForeground" aria-hidden="true">
									{answerValue(selectedAnswers[item.id]) ? "✓" : index + 1}
								</span>
								<span className="break-words">{item.header}</span>
							</button>
						))}
					</nav>
					<div className="flex min-w-0 flex-col gap-3">
						<h3
							id={questionHeadingId}
							ref={headingRef}
							tabIndex={-1}
							className="m-0 break-words text-sm font-semibold leading-relaxed">
							{question.question}
						</h3>
						<fieldset
							className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
							aria-labelledby={questionHeadingId}>
							{question.options.map((option, index) => {
								const isRecommended = option.label.endsWith(RECOMMENDED_SUFFIX)
								const descriptionId = `${formId}-${question.id}-option-${index}`
								return (
									<label
										key={option.label}
										className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-vscode-list-hoverBackground focus-within:bg-vscode-list-hoverBackground">
										<input
											type="radio"
											name={`${formId}-${question.id}`}
											value={option.label}
											aria-label={option.label}
											aria-describedby={descriptionId}
											checked={!selected?.isOther && selected?.option === option.label}
											onChange={() =>
												updateAnswer(question, { option: option.label, isOther: false })
											}
											className="mt-0.5 shrink-0"
											style={{ accentColor: "var(--vscode-focusBorder)" }}
										/>
										<span className="flex min-w-0 flex-col gap-1">
											<span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium">
												<span className="break-words">
													{isRecommended
														? option.label.slice(0, -RECOMMENDED_SUFFIX.length)
														: option.label}
												</span>
												{isRecommended && (
													<span className="rounded bg-vscode-badge-background px-1.5 py-0.5 text-xs font-normal text-vscode-badge-foreground">
														{t("chat:requestUserInput.recommended")}
													</span>
												)}
											</span>
											<span
												id={descriptionId}
												className="break-words text-xs leading-relaxed text-vscode-descriptionForeground">
												{option.description}
											</span>
										</span>
									</label>
								)
							})}
							<label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-vscode-list-hoverBackground focus-within:bg-vscode-list-hoverBackground">
								<input
									type="radio"
									name={`${formId}-${question.id}`}
									value={OTHER_VALUE}
									aria-label={t("chat:requestUserInput.other")}
									aria-describedby={`${formId}-custom-description`}
									checked={selected?.isOther === true}
									onChange={() => {
										pendingFocus.current = "custom"
										updateAnswer(question, { isOther: true })
									}}
									className="mt-0.5 shrink-0"
									style={{ accentColor: "var(--vscode-focusBorder)" }}
								/>
								<span className="flex min-w-0 flex-col gap-1">
									<span className="text-sm font-medium">{t("chat:requestUserInput.other")}</span>
									<span
										id={`${formId}-custom-description`}
										className="text-xs leading-relaxed text-vscode-descriptionForeground">
										{t("chat:requestUserInput.otherDescription")}
									</span>
								</span>
							</label>
							{selected?.isOther && (
								<textarea
									ref={customAnswerRef}
									rows={3}
									className="ml-6 w-[calc(100%-1.5rem)] resize-y rounded-md border border-vscode-input-border bg-vscode-input-background px-2 py-2 text-sm text-vscode-input-foreground"
									aria-label={t("chat:requestUserInput.otherAnswer", {
										header: question.header,
										index: questionIndex + 1,
									})}
									placeholder={t("chat:requestUserInput.otherPlaceholder")}
									value={selected.customText}
									onChange={(event) =>
										updateAnswer(question, { customText: event.currentTarget.value })
									}
								/>
							)}
						</fieldset>
					</div>
				</>
			)}
			{sendFailed && (
				<p className="m-0 text-xs text-vscode-errorForeground" role="alert">
					{t("chat:requestUserInput.sendFailed")}
				</p>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-vscode-panel-border pt-3">
				{onCancel && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => {
							cancelAutoApproval()
							onCancel()
						}}>
						{t("chat:requestUserInput.cancel")}
					</Button>
				)}
				<div className="ml-auto flex flex-wrap justify-end gap-2">
					{(isReview || questionIndex > 0) && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => showQuestion(isReview ? request.questions.length - 1 : questionIndex - 1)}>
							{t("chat:requestUserInput.back")}
						</Button>
					)}
					<Button
						type="submit"
						variant="primary"
						size="sm"
						disabled={isReview ? !isComplete : !currentIsComplete || (isReviewAction && !isComplete)}>
						{t(
							isReview
								? "chat:requestUserInput.submit"
								: isReviewAction
									? "chat:requestUserInput.review"
									: "chat:requestUserInput.continue",
						)}
					</Button>
				</div>
			</div>
		</form>
	)
}
