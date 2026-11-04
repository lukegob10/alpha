import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TicketImportPreview } from "@alpha-code/types"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog"
import "./ticket-transfer.css"

export type TicketExportScope = "selected" | "filtered" | "all"

type CommonProps = { busy: boolean; error?: string; onCancel: () => void }

export function TicketExportDialog({
	selectedCount,
	filteredCount,
	busy,
	error,
	onCancel,
	onExport,
}: CommonProps & {
	selectedCount: number
	filteredCount: number
	onExport: (scope: TicketExportScope, includeDescendants: boolean) => void
}) {
	const { t } = useTranslation("tickets")
	const [scope, setScope] = useState<TicketExportScope>(selectedCount ? "selected" : "all")
	const [includeDescendants, setIncludeDescendants] = useState(true)
	return (
		<TransferDialog
			title={t("transfer.exportTitle")}
			description={t("transfer.exportDescription")}
			busy={busy}
			onCancel={onCancel}>
			<fieldset disabled={busy}>
				<legend>{t("transfer.exportScope")}</legend>
				{(["selected", "filtered", "all"] as const).map((value) => (
					<label key={value}>
						<input
							type="radio"
							name="exportScope"
							value={value}
							checked={scope === value}
							disabled={value === "selected" && !selectedCount}
							onChange={() => setScope(value)}
						/>
						{t(`transfer.scope.${value}`, { count: value === "selected" ? selectedCount : filteredCount })}
					</label>
				))}
				<label>
					<input
						type="checkbox"
						checked={includeDescendants}
						onChange={(event) => setIncludeDescendants(event.target.checked)}
					/>
					{t("transfer.includeDescendants")}
				</label>
			</fieldset>
			{error && <p role="alert">{error}</p>}
			<AlertDialogFooter>
				<button type="button" disabled={busy} onClick={onCancel}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="ticket-transfer-primary"
					disabled={busy || (scope === "selected" && !selectedCount)}
					onClick={() => onExport(scope, includeDescendants)}>
					{t(busy ? "transfer.saving" : "transfer.saveExport")}
				</button>
			</AlertDialogFooter>
		</TransferDialog>
	)
}

export function TicketImportDialog({
	preview,
	busy,
	error,
	onCancel,
	onImport,
}: CommonProps & {
	preview: TicketImportPreview
	onImport: (mode: "copy" | "update", resetStatus: boolean) => void
}) {
	const { t } = useTranslation("tickets")
	const [mode, setMode] = useState<"copy" | "update">("copy")
	const [resetStatus, setResetStatus] = useState(true)
	const [reviewed, setReviewed] = useState(false)
	const counts = preview.tickets.reduce(
		(result, ticket) => ({ ...result, [ticket.disposition]: result[ticket.disposition] + 1 }),
		{ new: 0, duplicate: 0, conflict: 0 },
	)
	return (
		<TransferDialog
			title={t("transfer.importTitle")}
			description={t("transfer.importDescription", { count: preview.tickets.length })}
			busy={busy}
			onCancel={onCancel}>
			<p>{t("transfer.importCounts", counts)}</p>
			<div className="ticket-import-preview">
				<ul aria-label={t("transfer.previewTickets")}>
					{preview.tickets.map((ticket) => (
						<li key={ticket.id}>
							<span>
								{ticket.reference ? `${ticket.reference} · ` : ""}
								{ticket.name}
							</span>
							<span>
								{t(ticket.status)} · {t(`transfer.disposition.${ticket.disposition}`)}
							</span>
							{!!ticket.changes?.length && (
								<details open={mode === "update"}>
									<summary>{t("transfer.reviewChanges", { count: ticket.changes.length })}</summary>
									{ticket.changes.map((change) => (
										<div className="ticket-import-change" key={change.field}>
											<strong>
												{t(change.field === "parentId" ? "parentTicket" : change.field)}
											</strong>
											<dl>
												<dt>{t("transfer.localValue")}</dt>
												<dd>{change.before || t("transfer.emptyValue")}</dd>
												<dt>{t("transfer.incomingValue")}</dt>
												<dd>{change.after || t("transfer.emptyValue")}</dd>
											</dl>
										</div>
									))}
								</details>
							)}
						</li>
					))}
				</ul>
			</div>
			{preview.warnings.length > 0 && (
				<ul className="ticket-import-warnings">
					{preview.warnings.map((warning, index) => (
						<li key={index}>{warning}</li>
					))}
				</ul>
			)}
			<fieldset disabled={busy}>
				<legend>{t("transfer.importMode")}</legend>
				<label>
					<input
						type="radio"
						name="importMode"
						checked={mode === "copy"}
						onChange={() => {
							setMode("copy")
							setResetStatus(true)
							setReviewed(false)
						}}
					/>
					{t("transfer.copy")}
				</label>
				<label>
					<input
						type="radio"
						name="importMode"
						checked={mode === "update"}
						onChange={() => {
							setMode("update")
							setResetStatus(false)
							setReviewed(false)
						}}
					/>
					{t("transfer.update")}
				</label>
				<p>{t(mode === "copy" ? "transfer.copyExplanation" : "transfer.updateExplanation")}</p>
				<label>
					<input
						type="checkbox"
						checked={resetStatus}
						onChange={(event) => setResetStatus(event.target.checked)}
					/>
					{t("transfer.resetStatus")}
				</label>
				{mode === "update" && (
					<label>
						<input
							type="checkbox"
							checked={reviewed}
							onChange={(event) => setReviewed(event.target.checked)}
						/>
						{t("transfer.reviewedUpdates")}
					</label>
				)}
			</fieldset>
			{error && <p role="alert">{error}</p>}
			<AlertDialogFooter>
				<button type="button" disabled={busy} onClick={onCancel}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="ticket-transfer-primary"
					disabled={busy || (mode === "update" && !reviewed)}
					onClick={() => onImport(mode, resetStatus)}>
					{t(busy ? "transfer.importing" : "transfer.confirmImport", { count: preview.tickets.length })}
				</button>
			</AlertDialogFooter>
		</TransferDialog>
	)
}

function TransferDialog({
	title,
	description,
	busy,
	onCancel,
	children,
}: {
	title: string
	description: string
	busy: boolean
	onCancel: () => void
	children: React.ReactNode
}) {
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onCancel()
			}}>
			<AlertDialogContent
				className="ticket-transfer"
				onEscapeKeyDown={(event) => {
					if (busy) event.preventDefault()
				}}>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{children}
			</AlertDialogContent>
		</AlertDialog>
	)
}
