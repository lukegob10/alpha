import { useMemo, useState } from "react"

import type { CustomModePrompts, PromptComponent } from "@alpha-code/types"
import {
	codeModeSlug,
	getCustomInstructions,
	getDescription,
	getRoleDefinition,
	getWhenToUse,
	modes,
} from "@alpha/modes"

import { Button, Input, Textarea } from "@/components/ui"
import { Section } from "@/components/settings/Section"
import { SectionHeader } from "@/components/settings/SectionHeader"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { getUserFacingModeName, getUserFacingModeOptions, type UserFacingModeSlug } from "@/utils/modePresentation"

type EditablePromptField = "roleDefinition" | "description" | "whenToUse" | "customInstructions"

interface ModesViewProps {
	customModePrompts?: CustomModePrompts
	customInstructions?: string
	setCustomModePrompts: (value: CustomModePrompts) => void
	setCustomInstructions: (value: string | undefined) => void
}

const DEFAULT_PROMPT_VALUE: Record<EditablePromptField, (mode: UserFacingModeSlug) => string> = {
	roleDefinition: getRoleDefinition,
	description: getDescription,
	whenToUse: getWhenToUse,
	customInstructions: getCustomInstructions,
}

const ModesView = ({
	customModePrompts = {},
	customInstructions,
	setCustomModePrompts,
	setCustomInstructions,
}: ModesViewProps) => {
	const { t } = useAppTranslation()
	const [selectedMode, setSelectedMode] = useState<UserFacingModeSlug>(codeModeSlug)
	const userFacingModes = useMemo(() => getUserFacingModeOptions(modes), [])
	const selectedModeName = getUserFacingModeName(selectedMode)

	const getPromptValue = (field: EditablePromptField): string =>
		customModePrompts[selectedMode]?.[field] ?? DEFAULT_PROMPT_VALUE[field](selectedMode)

	const updatePromptField = (field: EditablePromptField, value: string | undefined) => {
		if (customModePrompts[selectedMode]?.[field] === value) return

		const nextPrompts: CustomModePrompts = { ...customModePrompts }
		const nextModePrompt: PromptComponent = { ...(nextPrompts[selectedMode] ?? {}) }

		if (value === undefined) {
			delete nextModePrompt[field]
		} else {
			nextModePrompt[field] = value
		}

		if (Object.keys(nextModePrompt).length === 0) {
			delete nextPrompts[selectedMode]
		} else {
			nextPrompts[selectedMode] = nextModePrompt
		}

		setCustomModePrompts(nextPrompts)
	}

	const resetButton = (field: EditablePromptField, label: string) => (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			aria-label={label}
			data-testid={`${selectedMode}-${field}-reset`}
			onClick={() => updatePromptField(field, undefined)}>
			<span className="codicon codicon-discard" />
		</Button>
	)

	return (
		<div>
			<SectionHeader description="Configure the two focused workflows used in chat.">
				{t("settings:sections.modes")}
			</SectionHeader>

			<Section>
				<div>
					<div className="mb-1 font-medium">Mode setup</div>
					<p className="m-0 text-sm text-vscode-descriptionForeground">
						Use Shift + Tab in the chat input to switch between Plan and Code. Choosing a setup here does
						not change the active task.
					</p>
				</div>

				<div className="grid grid-cols-2 gap-2" role="group" aria-label="Mode setup">
					{userFacingModes.map((mode) => {
						const modeSlug = mode.slug as UserFacingModeSlug
						const isSelected = modeSlug === selectedMode

						return (
							<Button
								key={modeSlug}
								type="button"
								variant={isSelected ? "primary" : "outline"}
								aria-pressed={isSelected}
								data-testid={`mode-setup-${modeSlug}`}
								onClick={() => setSelectedMode(modeSlug)}>
								{mode.name}
							</Button>
						)
					})}
				</div>

				<div key={selectedMode} className="flex flex-col gap-4" data-testid="primary-mode-setup">
					<div>
						<div className="mb-1 flex items-center justify-between gap-2">
							<label htmlFor={`${selectedMode}-role-definition`} className="font-medium">
								{t("prompts:roleDefinition.title")}
							</label>
							{resetButton("roleDefinition", t("prompts:roleDefinition.resetToDefault"))}
						</div>
						<p className="mt-0 mb-2 text-sm text-vscode-descriptionForeground">
							{t("prompts:roleDefinition.description")}
						</p>
						<Textarea
							id={`${selectedMode}-role-definition`}
							rows={5}
							value={getPromptValue("roleDefinition")}
							data-testid={`${selectedMode}-prompt-textarea`}
							onChange={(event) => updatePromptField("roleDefinition", event.target.value || undefined)}
						/>
					</div>

					<div>
						<div className="mb-1 flex items-center justify-between gap-2">
							<label htmlFor={`${selectedMode}-description`} className="font-medium">
								{t("prompts:description.title")}
							</label>
							{resetButton("description", t("prompts:description.resetToDefault"))}
						</div>
						<p className="mt-0 mb-2 text-sm text-vscode-descriptionForeground">
							{t("prompts:description.description")}
						</p>
						<Input
							id={`${selectedMode}-description`}
							value={getPromptValue("description")}
							data-testid={`${selectedMode}-description-textfield`}
							onChange={(event) => updatePromptField("description", event.target.value || undefined)}
						/>
					</div>

					<div>
						<div className="mb-1 flex items-center justify-between gap-2">
							<label htmlFor={`${selectedMode}-when-to-use`} className="font-medium">
								{t("prompts:whenToUse.title")}
							</label>
							{resetButton("whenToUse", t("prompts:whenToUse.resetToDefault"))}
						</div>
						<p className="mt-0 mb-2 text-sm text-vscode-descriptionForeground">
							Describe when {selectedModeName} is the right workflow for a task.
						</p>
						<Textarea
							id={`${selectedMode}-when-to-use`}
							rows={4}
							value={getPromptValue("whenToUse")}
							data-testid={`${selectedMode}-when-to-use-textarea`}
							onChange={(event) => updatePromptField("whenToUse", event.target.value || undefined)}
						/>
					</div>

					<div>
						<div className="mb-1 flex items-center justify-between gap-2">
							<label htmlFor={`${selectedMode}-custom-instructions`} className="font-medium">
								{t("prompts:customInstructions.title")}
							</label>
							{resetButton("customInstructions", t("prompts:customInstructions.resetToDefault"))}
						</div>
						<p className="mt-0 mb-2 text-sm text-vscode-descriptionForeground">
							{t("prompts:customInstructions.description", { modeName: selectedModeName })}
						</p>
						<Textarea
							id={`${selectedMode}-custom-instructions`}
							rows={8}
							value={getPromptValue("customInstructions")}
							data-testid={`${selectedMode}-custom-instructions-textarea`}
							onChange={(event) =>
								updatePromptField("customInstructions", event.target.value || undefined)
							}
						/>
					</div>
				</div>
			</Section>

			<Section>
				<div>
					<label htmlFor="global-custom-instructions" className="font-medium">
						{t("prompts:globalCustomInstructions.title")}
					</label>
					<p className="mt-1 mb-2 text-sm text-vscode-descriptionForeground">
						Instructions entered here apply across workflows.
					</p>
					<Textarea
						id="global-custom-instructions"
						rows={6}
						value={customInstructions ?? ""}
						data-testid="global-custom-instructions-textarea"
						onChange={(event) => setCustomInstructions(event.target.value)}
					/>
				</div>
			</Section>
		</div>
	)
}

export default ModesView
