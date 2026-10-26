import { useState, type HTMLAttributes } from "react"
import {
	DEFAULT_MAX_CONCURRENT_TASKS,
	reasoningEffortsExtended,
	reasoningEffortExtendedSchema,
	subagentAgentTypeDefinitionSchema,
	subagentSpawnAgentTypeSchema,
	type SubagentAgentTypeDefinition,
} from "@alpha-code/types"
import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import {
	DEFAULT_MANAGED_AGENT_SETTINGS,
	MANAGED_AGENT_SETTING_LIMITS,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "./managed-agent-settings"
import { getManagedAgentSettingsIssues, parseManagedAgentNumericInput } from "./agents-settings-validation"

const inputClassName =
	"min-h-8 min-w-0 max-w-full self-start rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 focus-visible:outline focus-visible:outline-vscode-focusBorder"
const fieldClassName = "flex min-w-0 flex-col gap-2"

interface AgentsSettingsProps extends HTMLAttributes<HTMLDivElement> {
	values: SettingsCachedState
	setCachedStateField: SetSettingsCachedStateField
}

export function AgentsSettings({ values, setCachedStateField, ...props }: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const [newTypeName, setNewTypeName] = useState("")
	const [newTypeDescription, setNewTypeDescription] = useState("")
	const [showNewTypeError, setShowNewTypeError] = useState(false)
	const issues = getManagedAgentSettingsIssues(values)
	const errorFor = (id: string) => {
		const issue = issues.find((candidate) => candidate.settingId === id)
		return issue ? t(issue.translationKey) : undefined
	}
	const types = values.subagentAgentTypes ?? {}
	const updateType = (name: string, update: Partial<SubagentAgentTypeDefinition>) =>
		setCachedStateField("subagentAgentTypes", { ...types, [name]: { ...types[name], ...update } })
	const addType = () => {
		const name = newTypeName.trim()
		const definition = subagentAgentTypeDefinitionSchema.safeParse({
			description: newTypeDescription,
			developerInstructions: "",
		})
		if (
			!subagentSpawnAgentTypeSchema.safeParse(name).success ||
			!definition.success ||
			Object.hasOwn(types, name) ||
			Object.keys(types).length >= 24
		) {
			setShowNewTypeError(true)
			return
		}
		setCachedStateField("subagentAgentTypes", { ...types, [name]: definition.data })
		setNewTypeName("")
		setNewTypeDescription("")
		setShowNewTypeError(false)
	}
	const effortOptions = (
		<>
			<option value="">{t("agents:inherit")}</option>
			{reasoningEffortsExtended.map((effort) => (
				<option key={effort} value={effort}>
					{effort}
				</option>
			))}
		</>
	)
	return (
		<div {...props}>
			<SectionHeader description={t("agents:description")}>{t("agents:title")}</SectionHeader>
			<Section>
				<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:timing")}</p>
				<SearchableSetting
					settingId="agents-enabled"
					section="agents"
					label={t("agents:enabled.label")}
					className={fieldClassName}>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={values.subagentsEnabled}
							onChange={(event) => setCachedStateField("subagentsEnabled", event.target.checked)}
						/>
						{t("agents:enabled.label")}
					</label>
					<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:enabled.description")}</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-concurrency"
					section="agents"
					label={t("agents:concurrency.label")}
					className={fieldClassName}>
					<label htmlFor="agents-concurrency">{t("agents:concurrency.label")}</label>
					<input
						id="agents-concurrency"
						data-testid="agents-concurrency"
						className={cn(inputClassName, "w-24")}
						type="number"
						step={1}
						{...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents}
						value={Number.isFinite(values.maxConcurrentSubagents) ? values.maxConcurrentSubagents : ""}
						aria-invalid={!!errorFor("agents-concurrency")}
						aria-describedby="agents-concurrency-description agents-concurrency-error"
						onChange={(event) =>
							setCachedStateField(
								"maxConcurrentSubagents",
								parseManagedAgentNumericInput(event.target.value),
							)
						}
					/>
					<p id="agents-concurrency-description" className="text-vscode-descriptionForeground text-sm m-0">
						{t("agents:concurrency.description", {
							default: DEFAULT_MANAGED_AGENT_SETTINGS.maxConcurrentSubagents,
						})}
					</p>
					<p
						id="agents-concurrency-error"
						className="m-0"
						hidden={!errorFor("agents-concurrency")}
						role={errorFor("agents-concurrency") ? "alert" : undefined}>
						{errorFor("agents-concurrency")}
					</p>
					<p data-testid="agents-task-capacity" className="text-vscode-descriptionForeground text-sm m-0">
						{t("agents:concurrency.taskCapacity", {
							capacity: values.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
						})}
					</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-default-model"
					section="agents"
					label={t("agents:defaultModel.label")}
					className={fieldClassName}>
					<label htmlFor="agents-default-model">{t("agents:defaultModel.label")}</label>
					<input
						id="agents-default-model"
						data-testid="agents-default-model"
						className={cn(inputClassName, "w-full max-w-sm")}
						value={values.subagentDefaultModel}
						placeholder={t("agents:inherit")}
						aria-invalid={!!errorFor("agents-default-model")}
						onChange={(event) => setCachedStateField("subagentDefaultModel", event.target.value)}
					/>
					<p className="text-vscode-descriptionForeground text-sm m-0">
						{t("agents:defaultModel.description")}
					</p>
					{errorFor("agents-default-model") && (
						<p className="m-0" role="alert">
							{errorFor("agents-default-model")}
						</p>
					)}
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-default-reasoning"
					section="agents"
					label={t("agents:defaultReasoning.label")}
					className={fieldClassName}>
					<label htmlFor="agents-default-reasoning">{t("agents:defaultReasoning.label")}</label>
					<select
						id="agents-default-reasoning"
						data-testid="agents-default-reasoning"
						className={cn(inputClassName, "w-48")}
						value={values.subagentDefaultReasoningEffort ?? ""}
						onChange={(event) => {
							const effort = reasoningEffortExtendedSchema.safeParse(event.target.value)
							setCachedStateField(
								"subagentDefaultReasoningEffort",
								effort.success ? effort.data : undefined,
							)
						}}>
						{effortOptions}
					</select>
					<p className="text-vscode-descriptionForeground text-sm m-0">
						{t("agents:defaultReasoning.description")}
					</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-interrupt-message"
					section="agents"
					label={t("agents:interruptMessage.label")}
					className={fieldClassName}>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={values.subagentInterruptMessage}
							onChange={(event) => setCachedStateField("subagentInterruptMessage", event.target.checked)}
						/>
						{t("agents:interruptMessage.label")}
					</label>
					<p className="text-vscode-descriptionForeground text-sm m-0">
						{t("agents:interruptMessage.description")}
					</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-types"
					section="agents"
					label={t("agents:types.title")}
					className="flex min-w-0 flex-col gap-4">
					<div className={fieldClassName}>
						<h4 className="font-medium m-0">{t("agents:types.title")}</h4>
						<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:types.description")}</p>
					</div>
					{errorFor("agents-types") && (
						<p id="agents-types-error" className="m-0" role="alert">
							{errorFor("agents-types")}
						</p>
					)}
					{Object.entries(types).map(([name, definition]) => (
						<fieldset
							key={name}
							className="border border-vscode-input-border rounded p-3 flex flex-col gap-4 min-w-0">
							<legend>{name}</legend>
							<div className={fieldClassName}>
								<label htmlFor={name + "-description"}>
									{t("agents:types.descriptionLabel", { name })}
								</label>
								<textarea
									id={name + "-description"}
									className={cn(inputClassName, "w-full resize-y")}
									value={definition.description}
									aria-invalid={!!errorFor("agents-types")}
									aria-describedby={errorFor("agents-types") ? "agents-types-error" : undefined}
									onChange={(event) => updateType(name, { description: event.target.value })}
								/>
							</div>
							<div className={fieldClassName}>
								<label htmlFor={name + "-model"}>{t("agents:types.modelLabel", { name })}</label>
								<input
									id={name + "-model"}
									className={cn(inputClassName, "w-full max-w-sm")}
									value={definition.model ?? ""}
									placeholder={t("agents:inherit")}
									onChange={(event) => updateType(name, { model: event.target.value || undefined })}
								/>
							</div>
							<div className={fieldClassName}>
								<label htmlFor={name + "-reasoning"}>
									{t("agents:types.reasoningLabel", { name })}
								</label>
								<select
									id={name + "-reasoning"}
									className={cn(inputClassName, "w-48")}
									value={definition.reasoningEffort ?? ""}
									onChange={(event) => {
										const effort = reasoningEffortExtendedSchema.safeParse(event.target.value)
										updateType(name, { reasoningEffort: effort.success ? effort.data : undefined })
									}}>
									{effortOptions}
								</select>
							</div>
							<div className={fieldClassName}>
								<label htmlFor={name + "-instructions"}>
									{t("agents:types.instructionsLabel", { name })}
								</label>
								<textarea
									id={name + "-instructions"}
									className={cn(inputClassName, "w-full resize-y")}
									value={definition.developerInstructions ?? ""}
									onChange={(event) =>
										updateType(name, { developerInstructions: event.target.value })
									}
								/>
							</div>
							<Button
								type="button"
								variant="secondary"
								onClick={() => {
									const next = { ...types }
									delete next[name]
									setCachedStateField("subagentAgentTypes", next)
								}}>
								{t("agents:types.remove", { name })}
							</Button>
						</fieldset>
					))}
					{Object.keys(types).length === 0 && <p className="m-0">{t("agents:types.empty")}</p>}
					<div className={fieldClassName}>
						<label htmlFor="agents-new-type-name">{t("agents:types.name")}</label>
						<input
							id="agents-new-type-name"
							className={cn(inputClassName, "w-full max-w-xs")}
							value={newTypeName}
							aria-describedby="agents-new-type-name-hint"
							onChange={(event) => setNewTypeName(event.target.value)}
						/>
						<p id="agents-new-type-name-hint" className="text-vscode-descriptionForeground text-sm m-0">
							{t("agents:types.nameHint")}
						</p>
					</div>
					<div className={fieldClassName}>
						<label htmlFor="agents-new-type-description">{t("agents:types.newDescription")}</label>
						<textarea
							id="agents-new-type-description"
							className={cn(inputClassName, "w-full resize-y")}
							value={newTypeDescription}
							onChange={(event) => setNewTypeDescription(event.target.value)}
						/>
					</div>
					{showNewTypeError && (
						<p className="m-0" role="alert">
							{t("agents:validation.newType")}
						</p>
					)}
					<Button type="button" variant="secondary" className="self-start" onClick={addType}>
						{t("agents:types.add")}
					</Button>
				</SearchableSetting>
			</Section>
		</div>
	)
}
