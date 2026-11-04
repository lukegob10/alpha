import { z } from "zod"

/**
 * Command
 */

export const commandIds = [
	"sidebarNewChat",
	"sidebarSettings",
	"sidebarScheduledTasks",
	"activationCompleted",

	"plusButtonClicked",
	"historyButtonClicked",
	"scheduledTasksButtonClicked",
	"popoutButtonClicked",
	"settingsButtonClicked",

	"openInNewTab",
	"diagramZoomOut",
	"diagramZoomIn",
	"diffReviewActions",

	"newTask",

	"setCustomStoragePath",
	"importSettings",
	"exportDiagnostics",
	"recoverTaskHistory",

	"focusInput",
	"acceptInput",
	"sendAndSteer",
	"decreaseReasoningEffort",
	"increaseReasoningEffort",
	"previousTask",
	"nextTask",
	"nextTaskNeedingInput",
	"focusPanel",
	"toggleAutoApprove",
	"manageGoal",
] as const

export type CommandId = (typeof commandIds)[number]

/**
 * Language
 */

export const languages = ["en"] as const

// Read older saved locale choices without rejecting the rest of an imported settings file.
export const languagesSchema = z.enum(languages).catch("en")

export type Language = z.infer<typeof languagesSchema>

export const isLanguage = (value: string): value is Language => languages.includes(value as Language)
