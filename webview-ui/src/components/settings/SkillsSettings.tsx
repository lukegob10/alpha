import React, { useState, useEffect, useMemo, useCallback } from "react"
import { Plus, Globe, Folder, Edit, Trash2, Settings, BookOpen } from "lucide-react"
import { Trans } from "react-i18next"

import type { SkillMetadata } from "@alpha-code/types"

import { getAllModes } from "@alpha/modes"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Checkbox,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	StandardTooltip,
} from "@/components/ui"
import { vscode } from "@/utils/vscode"
import { buildDocLink } from "@/utils/docLinks"
import { getUserFacingModeOptions } from "@/utils/modePresentation"

import { useSectionGroup } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { CreateSkillDialog } from "./CreateSkillDialog"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import type { SettingsSectionId } from "./settingsNavigation"

interface SkillsSettingsProps {
	disabledBuiltinSkills?: string[]
	onDisabledBuiltinSkillsChange?: (names: string[]) => void
	embedded?: boolean
	searchSectionId?: SettingsSectionId
}

export const SkillsSettings: React.FC<SkillsSettingsProps> = ({
	disabledBuiltinSkills = [],
	onDisabledBuiltinSkillsChange,
	embedded = false,
	searchSectionId = "tools",
}) => {
	const { t } = useAppTranslation()
	const grouped = useSectionGroup()
	const { cwd, skills: rawSkills, skillsError, customModes } = useExtensionState()
	const skills = useMemo(() => rawSkills ?? [], [rawSkills])

	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
	const [skillToDelete, setSkillToDelete] = useState<SkillMetadata | null>(null)
	const [createDialogOpen, setCreateDialogOpen] = useState(false)

	// Mode selection modal state
	const [modeDialogOpen, setModeDialogOpen] = useState(false)
	const [skillToEditModes, setSkillToEditModes] = useState<SkillMetadata | null>(null)
	const [selectedModes, setSelectedModes] = useState<string[]>([])
	const [isAnyMode, setIsAnyMode] = useState(true)

	// Check if we're in a workspace/project
	const hasWorkspace = Boolean(cwd)

	// Saved bindings remain editable even after their modes stop being executable.
	const availableModes = useMemo(() => {
		const allModes = getAllModes(customModes)
		const options = getUserFacingModeOptions(allModes).map((m) => ({
			slug: m.slug,
			name: m.name,
		}))
		for (const slug of skillToEditModes?.modeSlugs ?? []) {
			if (!options.some((mode) => mode.slug === slug)) {
				options.push({ slug, name: allModes.find((mode) => mode.slug === slug)?.name ?? slug })
			}
		}
		return options
	}, [customModes, skillToEditModes])

	const handleRefresh = useCallback(() => {
		vscode.postMessage({ type: "requestSkills" })
	}, [])

	// Request skills when component mounts
	useEffect(() => {
		handleRefresh()
	}, [handleRefresh])

	const handleDeleteClick = useCallback((skill: SkillMetadata) => {
		setSkillToDelete(skill)
		setDeleteDialogOpen(true)
	}, [])

	const handleDeleteConfirm = useCallback(() => {
		if (skillToDelete) {
			vscode.postMessage({
				type: "deleteSkill",
				skillName: skillToDelete.name,
				source: skillToDelete.source,
				skillPath: skillToDelete.path,
				skillModeSlugs: skillToDelete.modeSlugs,
			})
			setDeleteDialogOpen(false)
			setSkillToDelete(null)
		}
	}, [skillToDelete])

	const handleDeleteCancel = useCallback(() => {
		setDeleteDialogOpen(false)
		setSkillToDelete(null)
	}, [])

	const handleEditClick = useCallback((skill: SkillMetadata) => {
		vscode.postMessage({
			type: "openSkillFile",
			skillName: skill.name,
			source: skill.source,
			skillPath: skill.path,
			skillModeSlugs: skill.modeSlugs,
		})
	}, [])

	// Open mode selection modal
	const handleOpenModeDialog = useCallback((skill: SkillMetadata) => {
		setSkillToEditModes(skill)
		// Initialize state from skill's current modeSlugs
		const hasModeSlugs = skill.modeSlugs && skill.modeSlugs.length > 0
		setIsAnyMode(!hasModeSlugs)
		setSelectedModes(hasModeSlugs ? [...skill.modeSlugs!] : [])
		setModeDialogOpen(true)
	}, [])

	// Handle "Any mode" toggle - mutually exclusive with specific modes
	const handleAnyModeToggle = useCallback((checked: boolean) => {
		if (checked) {
			setIsAnyMode(true)
			setSelectedModes([]) // Clear specific modes when "Any mode" is selected
		} else {
			setIsAnyMode(false)
		}
	}, [])

	// Handle specific mode toggle - unchecks "Any mode" when a specific mode is selected
	const handleModeToggle = useCallback((modeSlug: string, checked: boolean) => {
		if (checked) {
			setIsAnyMode(false) // Uncheck "Any mode" when selecting a specific mode
			setSelectedModes((prev) => [...prev, modeSlug])
		} else {
			setSelectedModes((prev) => {
				const newModes = prev.filter((m) => m !== modeSlug)
				// If no modes selected, default back to "Any mode"
				if (newModes.length === 0) {
					setIsAnyMode(true)
				}
				return newModes
			})
		}
	}, [])

	// Save mode changes
	const handleSaveModes = useCallback(() => {
		if (skillToEditModes) {
			const newModeSlugs = isAnyMode ? [] : selectedModes
			vscode.postMessage({
				type: "updateSkillModes",
				skillName: skillToEditModes.name,
				source: skillToEditModes.source,
				skillPath: skillToEditModes.path,
				newSkillModeSlugs: newModeSlugs,
			})
			setModeDialogOpen(false)
			setSkillToEditModes(null)
		}
	}, [skillToEditModes, isAnyMode, selectedModes])

	const handleCloseModeDialog = useCallback(() => {
		setModeDialogOpen(false)
		setSkillToEditModes(null)
	}, [])

	// No-op callback - the backend sends updated skills list via ExtensionStateContext
	const handleSkillCreated = useCallback(() => {}, [])

	// Group skills by source
	const projectSkills = useMemo(() => skills.filter((skill) => skill.source === "project"), [skills])
	const globalSkills = useMemo(() => skills.filter((skill) => skill.source === "global"), [skills])

	const builtinSkills = useMemo(() => skills.filter((skill) => skill.source === "builtin"), [skills])

	// Render a single skill item
	const renderSkillItem = useCallback(
		(skill: SkillMetadata) => {
			return (
				<div key={skill.path} className="rounded-xl border border-transparent px-2 py-1">
					<div
						role="group"
						aria-label={skill.name}
						className="settings-skill-row flex items-center justify-between gap-2">
						<StandardTooltip content={skill.description} maxWidth="min(24rem, calc(100vw - 2rem))">
							<span
								tabIndex={0}
								className="settings-skill-name min-w-0 flex-1 truncate font-medium focus-visible:outline focus-visible:outline-vscode-focusBorder">
								{skill.name}
							</span>
						</StandardTooltip>

						{/* Actions */}
						<div className="settings-skill-actions flex shrink-0 items-center gap-1">
							{skill.source === "builtin" ? (
								<>
									<Checkbox
										id={`builtin-${skill.name}`}
										aria-label={`${skill.name} ${t("settings:skills.enabled")}`}
										checked={!disabledBuiltinSkills.includes(skill.name)}
										onCheckedChange={(checked) =>
											onDisabledBuiltinSkillsChange?.(
												checked === true
													? disabledBuiltinSkills.filter((name) => name !== skill.name)
													: [...new Set([...disabledBuiltinSkills, skill.name])],
											)
										}
									/>
									<label className="sr-only" htmlFor={`builtin-${skill.name}`}>
										{t("settings:skills.enabled")}
									</label>
									<StandardTooltip content={t("settings:skills.inspectSkill")}>
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("settings:skills.inspectSkill")}
											onClick={() => handleEditClick(skill)}>
											<BookOpen className="size-4" />
										</Button>
									</StandardTooltip>
								</>
							) : (
								<>
									{/* Mode settings button (gear icon) */}
									<StandardTooltip content={t("settings:skills.configureModes")}>
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("settings:skills.configureModes")}
											onClick={() => handleOpenModeDialog(skill)}>
											<Settings className="size-4" />
										</Button>
									</StandardTooltip>

									<StandardTooltip content={t("settings:skills.editSkill")}>
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("settings:skills.editSkill")}
											onClick={() => handleEditClick(skill)}>
											<Edit />
										</Button>
									</StandardTooltip>

									<StandardTooltip content={t("settings:skills.deleteSkill")}>
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("settings:skills.deleteSkill")}
											onClick={() => handleDeleteClick(skill)}>
											<Trash2 className="text-destructive" />
										</Button>
									</StandardTooltip>
								</>
							)}
							{skill.description && <SettingsHelp label={skill.name}>{skill.description}</SettingsHelp>}
						</div>
					</div>
				</div>
			)
		},
		[
			t,
			handleOpenModeDialog,
			handleEditClick,
			handleDeleteClick,
			disabledBuiltinSkills,
			onDisabledBuiltinSkillsChange,
		],
	)
	const skillsHelp = (
		<SettingsHelp label={t("settings:sections.skills")}>
			<Trans
				i18nKey="settings:skills.description"
				components={{
					DocsLink: (
						<a
							href={buildDocLink("features/skills", "skills_settings")}
							target="_blank"
							rel="noopener noreferrer"
							className="text-vscode-textLink-foreground hover:underline">
							Docs
						</a>
					),
				}}
			/>
			<p>{t("settings:skills.appliesImmediately")}</p>
			<p>{t("settings:skills.builtinDescription")}</p>
		</SettingsHelp>
	)

	return (
		<SearchableSetting
			settingId="skills-management"
			section={searchSectionId}
			label={t("settings:sections.skills")}
			className={
				embedded
					? grouped
						? "flex min-w-0 flex-col gap-3"
						: "surface-raised mx-5 mb-5 flex flex-col gap-3 rounded-2xl p-4"
					: "flex flex-col h-full overflow-hidden"
			}>
			{/* Fixed Header */}
			<div className="flex-shrink-0">
				{embedded ? (
					<div className="flex items-center justify-between gap-2">
						<h4 className="m-0 text-base font-semibold text-vscode-foreground">
							{t("settings:sections.skills")}
						</h4>
						{skillsHelp}
					</div>
				) : (
					<SectionHeader>
						<span className="flex items-center justify-between gap-2">
							{t("settings:sections.skills")}
							{skillsHelp}
						</span>
					</SectionHeader>
				)}
				<div className={embedded ? "flex flex-col gap-2 pt-2" : "flex flex-col gap-2 px-5 py-2"}>
					{skillsError && (
						<div role="alert" className="rounded-xl border border-vscode-inputValidation-warningBorder p-3">
							<p className="m-0 text-sm text-vscode-descriptionForeground">
								{t("settings:skills.catalogError")}
							</p>
							<Button variant="secondary" size="sm" className="mt-2" onClick={handleRefresh}>
								{t("settings:skills.retry")}
							</Button>
						</div>
					)}

					{/* Add Skill button */}
					<Button variant="secondary" className="py-1" onClick={() => setCreateDialogOpen(true)}>
						<Plus />
						{t("settings:skills.addSkill")}
					</Button>
				</div>
			</div>

			{/* Scrollable List Area */}
			<div className={embedded ? "min-w-0" : "flex-1 overflow-y-auto px-4 py-2 min-h-0"}>
				<div className="flex flex-col gap-1">
					{builtinSkills.length > 0 && (
						<>
							<div className="flex items-center gap-2 px-2 py-1 mt-1">
								<BookOpen className="size-4 shrink-0" />
								<span className="text-xs font-medium">{t("settings:skills.builtinSkills")}</span>
							</div>
							{builtinSkills.map(renderSkillItem)}
						</>
					)}
					{/* Project Skills Section - Only show if in a workspace */}
					{hasWorkspace && (
						<>
							<div className="flex items-center gap-2 px-2 py-1 mt-1 cursor-default">
								<Folder className="size-4 shrink-0" />
								<span className="text-xs font-medium">{t("settings:skills.workspaceSkills")}</span>
							</div>
							{projectSkills.length > 0 ? (
								projectSkills.map(renderSkillItem)
							) : !skillsError ? (
								<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
									{t("settings:skills.noWorkspaceSkills")}
								</div>
							) : null}
						</>
					)}

					{/* Global Skills Section */}
					<div className="flex items-center gap-2 px-2 py-1 mt-1 cursor-default">
						<Globe className="size-4 shrink-0" />
						<span className="text-xs font-medium">{t("settings:skills.globalSkills")}</span>
					</div>
					{globalSkills.length > 0 ? (
						globalSkills.map(renderSkillItem)
					) : !skillsError ? (
						<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
							{t("settings:skills.noGlobalSkills")}
						</div>
					) : null}
				</div>
			</div>

			{/* Delete Confirmation Dialog */}
			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:skills.deleteDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:skills.deleteDialog.description", { name: skillToDelete?.name })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleDeleteCancel}>
							{t("settings:skills.deleteDialog.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleDeleteConfirm}>
							{t("settings:skills.deleteDialog.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Create Skill Dialog */}
			<CreateSkillDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				onSkillCreated={handleSkillCreated}
				hasWorkspace={hasWorkspace}
			/>

			{/* Mode Selection Dialog */}
			<Dialog open={modeDialogOpen} onOpenChange={setModeDialogOpen}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t("settings:skills.modeDialog.title")}</DialogTitle>
						<DialogDescription></DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-1">
						{/* Intro text */}
						<p className="text-vscode-descriptionForeground">{t("settings:skills.modeDialog.intro")}</p>

						{/* Any mode option */}
						<div className="flex items-center gap-3 px-1 rounded-lg hover:bg-vscode-list-hoverBackground">
							<Checkbox
								id="mode-any"
								checked={isAnyMode}
								onCheckedChange={(checked) => handleAnyModeToggle(checked === true)}
							/>
							<label htmlFor="mode-any" className="flex-1 cursor-pointer font-medium">
								{t("settings:skills.modeDialog.anyMode")}
							</label>
						</div>

						{/* Separator */}
						<div className="h-px bg-vscode-widget-border" />

						{/* Individual mode checkboxes */}
						<div className="flex flex-col max-h-60 overflow-y-auto">
							{availableModes.map((mode) => (
								<div
									key={mode.slug}
									className="flex items-center gap-3 p-1 rounded-lg hover:bg-vscode-list-hoverBackground">
									<Checkbox
										id={`mode-${mode.slug}`}
										checked={selectedModes.includes(mode.slug)}
										onCheckedChange={(checked) => handleModeToggle(mode.slug, checked === true)}
									/>
									<label htmlFor={`mode-${mode.slug}`} className="flex-1 cursor-pointer">
										{mode.name}
									</label>
								</div>
							))}
						</div>
					</div>

					<DialogFooter>
						<Button variant="secondary" onClick={handleCloseModeDialog}>
							{t("settings:skills.modeDialog.cancel")}
						</Button>
						<Button onClick={handleSaveModes}>{t("settings:skills.modeDialog.save")}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SearchableSetting>
	)
}
