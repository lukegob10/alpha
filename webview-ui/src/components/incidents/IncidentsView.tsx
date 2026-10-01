import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Activity, AlertTriangle, Clock3, RefreshCw } from "lucide-react"
import {
	incidentDashboardTurnDetailMessageSchema,
	incidentDashboardUpdateMessageSchema,
	type IncidentDashboardEvidenceStatus,
	type IncidentDashboardSnapshot,
	type IncidentDashboardTurn,
	type IncidentDashboardTurnDetail,
} from "@alpha-code/types"
import { useTranslation } from "react-i18next"
import { vscode } from "../../utils/vscode"
import "./incidents.css"

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function formatTimestamp(timestamp: number) {
	const date = new Date(timestamp)
	return Number.isFinite(date.getTime()) ? timestampFormatter.format(date) : undefined
}

type TurnFilter = "all" | "positive" | "errors"
type TurnStatus = IncidentDashboardTurn["status"]

function isPositiveTurn(turn: IncidentDashboardTurn) {
	return turn.status === "completed" && turn.toolErrors === 0
}

function isErrorTurn(turn: IncidentDashboardTurn) {
	return turn.status === "failed" || turn.toolErrors > 0
}

function ProjectLabel({ workspace }: { workspace?: string }) {
	const { t } = useTranslation("incidents")
	// Saved tasks may come from either platform, regardless of the current host.
	const name =
		workspace
			?.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() || workspace
	return (
		<span className="incident-project" title={workspace}>
			{t("project")}: {name || t("projectUnavailable")}
		</span>
	)
}

export default function IncidentsView() {
	const { t } = useTranslation("incidents")
	const [snapshot, setSnapshot] = useState<IncidentDashboardSnapshot>()
	const [loading, setLoading] = useState(true)
	const [invalidSnapshot, setInvalidSnapshot] = useState(false)
	const [selectedTurnId, setSelectedTurnId] = useState<string>()
	const selectedTurnIdRef = useRef<string>()
	const [turnDetail, setTurnDetail] = useState<IncidentDashboardTurnDetail>()
	const [loadingTurnDetail, setLoadingTurnDetail] = useState(false)
	const [unavailableTurnDetail, setUnavailableTurnDetail] = useState(false)
	const [invalidTurnDetail, setInvalidTurnDetail] = useState(false)
	const [selectedTaskId, setSelectedTaskId] = useState<string>()
	const [turnFilter, setTurnFilter] = useState<TurnFilter>("all")

	const requestSnapshot = useCallback(() => {
		setLoading(true)
		setInvalidSnapshot(false)
		selectedTurnIdRef.current = undefined
		setSelectedTurnId(undefined)
		setTurnDetail(undefined)
		setLoadingTurnDetail(false)
		setUnavailableTurnDetail(false)
		setInvalidTurnDetail(false)
		vscode.postMessage({ type: "incidentDashboardReady" })
	}, [])
	const evidenceStatusLabel = (status?: IncidentDashboardEvidenceStatus) =>
		status ? t(`evidenceStatus.${status}`) : t("evidenceStatus.notChecked")
	const turnStats = useMemo(() => {
		const turns = snapshot?.turns ?? []
		const statusCounts: Record<TurnStatus, number> = {
			running: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			interrupted: 0,
		}
		let positiveCount = 0
		let errorCount = 0
		let durationTotal = 0
		let durationCount = 0

		for (const turn of turns) {
			statusCounts[turn.status] += 1
			if (isPositiveTurn(turn)) positiveCount += 1
			if (isErrorTurn(turn)) errorCount += 1
			if (turn.durationMs !== undefined) {
				durationTotal += turn.durationMs
				durationCount += 1
			}
		}

		return {
			turns,
			statusCounts,
			positiveCount,
			errorCount,
			averageDurationMs: durationCount > 0 ? durationTotal / durationCount : undefined,
			durationCount,
		}
	}, [snapshot?.turns])
	const visibleTurns = useMemo(() => {
		if (turnFilter === "positive") return turnStats.turns.filter(isPositiveTurn)
		if (turnFilter === "errors") return turnStats.turns.filter(isErrorTurn)
		return turnStats.turns
	}, [turnFilter, turnStats.turns])
	const selectedTurn = selectedTurnId ? turnStats.turns.find((turn) => turn.id === selectedTurnId) : undefined
	const formatDuration = (durationMs?: number) => {
		if (durationMs === undefined) return t("durationUnavailable")
		const totalSeconds = Math.round(durationMs / 1000)
		if (totalSeconds < 60) return t("duration.seconds", { count: totalSeconds })
		const minutes = Math.floor(totalSeconds / 60)
		const seconds = totalSeconds % 60
		return seconds === 0
			? t("duration.minutes", { count: minutes })
			: t("duration.minutesSeconds", { minutes, seconds })
	}
	const requestTurnDetail = useCallback(
		(turnId: string) => {
			if (turnId === selectedTurnId && turnDetail) return
			selectedTurnIdRef.current = turnId
			setSelectedTurnId(turnId)
			setTurnDetail(undefined)
			setLoadingTurnDetail(true)
			setUnavailableTurnDetail(false)
			setInvalidTurnDetail(false)
			vscode.postMessage({ type: "incidentDashboardRequestTurnDetail", turnId })
		},
		[selectedTurnId, turnDetail],
	)

	useEffect(() => {
		const receive = (event: MessageEvent<unknown>) => {
			if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return

			if (event.data.type === "incidentDashboardUpdate") {
				const result = incidentDashboardUpdateMessageSchema.safeParse(event.data)
				if (!result.success) {
					setSnapshot(undefined)
					setInvalidSnapshot(true)
					setLoading(false)
					return
				}

				setSnapshot(result.data.snapshot)
				setInvalidSnapshot(false)
				setLoading(false)
				return
			}

			if (event.data.type !== "incidentDashboardTurnDetail") return
			const detailMessage = event.data as { turnId?: unknown }
			if (typeof detailMessage.turnId !== "string" || detailMessage.turnId !== selectedTurnIdRef.current) return
			const result = incidentDashboardTurnDetailMessageSchema.safeParse(event.data)
			if (!result.success) {
				setLoadingTurnDetail(false)
				setInvalidTurnDetail(true)
				return
			}
			if (!result.data.detail) {
				setTurnDetail(undefined)
				setLoadingTurnDetail(false)
				setUnavailableTurnDetail(true)
				return
			}
			if (result.data.detail.turn.id !== result.data.turnId) {
				setLoadingTurnDetail(false)
				setInvalidTurnDetail(true)
				return
			}
			setTurnDetail(result.data.detail)
			setLoadingTurnDetail(false)
			setUnavailableTurnDetail(false)
			setInvalidTurnDetail(false)
		}

		window.addEventListener("message", receive)
		requestSnapshot()
		return () => window.removeEventListener("message", receive)
	}, [requestSnapshot])

	return (
		<main className="incident-dashboard">
			<div className="incident-dashboard-content">
				<header className="incident-dashboard-header">
					<div>
						<p className="incident-dashboard-eyebrow">{t("debugMode")}</p>
						<h1>{t("title")}</h1>
						<p className="incident-dashboard-description">{t("description")}</p>
					</div>
					<button className="incident-refresh-button" type="button" onClick={requestSnapshot}>
						<RefreshCw size={15} aria-hidden="true" />
						{t("refresh")}
					</button>
				</header>

				{loading && !snapshot ? (
					<p className="incident-dashboard-message" role="status">
						{t("loading")}
					</p>
				) : invalidSnapshot || !snapshot ? (
					<section className="incident-dashboard-message" role="alert">
						<p>{t("unavailable")}</p>
						<button className="incident-secondary-button" type="button" onClick={requestSnapshot}>
							{t("tryAgain")}
						</button>
					</section>
				) : (
					<>
						<section className="incident-panel" aria-labelledby="incident-alerts-heading">
							<div className="incident-panel-heading">
								<div>
									<h2 id="incident-alerts-heading">{t("alerts")}</h2>
								</div>
								<span
									className="incident-count"
									aria-label={t("alertCount", { count: snapshot.alerts.length })}>
									{snapshot.alerts.length}
								</span>
							</div>
							{snapshot.alerts.length === 0 ? (
								<p className="incident-empty-state">{t("noAlerts")}</p>
							) : (
								<ul className="incident-alert-list">
									{snapshot.alerts.map((alert) => (
										<li
											className={`incident-alert incident-alert--${alert.severity}`}
											key={alert.id}>
											<div className="incident-alert-icon" aria-hidden="true">
												<AlertTriangle size={17} />
											</div>
											<div className="incident-alert-content">
												<p className="incident-alert-severity">
													{t(`severity.${alert.severity}`)}
												</p>
												<h3>{alert.title}</h3>
												<p>
													<strong>{t("affectedTask")}:</strong>{" "}
													{snapshot.tasks.find((task) => task.taskId === alert.taskId)
														?.chatTitle ??
														snapshot.tasks.find((task) => task.taskId === alert.taskId)
															?.label ??
														t("taskUnavailable")}
												</p>
												<ProjectLabel
													workspace={
														snapshot.tasks.find((task) => task.taskId === alert.taskId)
															?.workspace
													}
												/>
												<p className="incident-alert-summary">{alert.summary}</p>
												<details>
													<summary>{t("alertDetails")}</summary>
													<div className="incident-alert-details">
														<p>
															<strong>{t("errorStatusLabel")}:</strong>{" "}
															{t(`errorStatus.${alert.errorStatus}`)}
														</p>
														<p>{evidenceStatusLabel(alert.evidenceStatus)}</p>
													</div>
													{alert.turnIdSha256 && (
														<p className="incident-alert-reference">
															{t("turnId")}{" "}
															<code title={alert.turnIdSha256}>
																{alert.turnIdSha256.slice(0, 12)}
															</code>
														</p>
													)}
													{alert.toolName && (
														<p className="incident-alert-reference">
															{t("affectedTool")}: <code>{alert.toolName}</code>
														</p>
													)}
													{alert.toolCallIdSha256 && (
														<p className="incident-alert-reference">
															{t("toolCallId")}{" "}
															<code title={alert.toolCallIdSha256}>
																{alert.toolCallIdSha256.slice(0, 12)}
															</code>
														</p>
													)}
												</details>
												<time dateTime={new Date(alert.at).toISOString()}>
													{formatTimestamp(alert.at)}
												</time>
												<button
													className="incident-debug-button"
													aria-label={t("startDebuggingTaskFor", { title: alert.title })}
													type="button"
													onClick={() =>
														vscode.postMessage({
															type: "startDebuggingTask",
															alertId: alert.id,
														})
													}>
													<Activity size={15} aria-hidden="true" />
													{t("startDebuggingTask")}
												</button>
											</div>
										</li>
									))}
								</ul>
							)}
						</section>

						<section
							className="incident-panel incident-turns-panel"
							aria-labelledby="incident-turns-heading">
							<div className="incident-panel-heading">
								<div>
									<p className="incident-dashboard-eyebrow">{t("turnSummary")}</p>
									<h2 id="incident-turns-heading">{t("turns")}</h2>
									<p className="incident-turn-scope">
										{t("turnSampleScope", { count: turnStats.turns.length, maximum: 64 })}
									</p>
								</div>
							</div>
							<dl className="incident-turn-stats">
								<div className="incident-turn-stat">
									<dt>{t("observedTurns")}</dt>
									<dd>{turnStats.turns.length}</dd>
								</div>
								<div className="incident-turn-stat incident-turn-stat--positive">
									<dt>{t("positiveTurns")}</dt>
									<dd>
										{turnStats.positiveCount}
										<small>{t("positiveDefinition")}</small>
									</dd>
								</div>
								<div className="incident-turn-stat incident-turn-stat--error">
									<dt>{t("errorTurns")}</dt>
									<dd>
										{turnStats.errorCount}
										<small>{t("errorDefinition")}</small>
									</dd>
								</div>
								<div className="incident-turn-stat">
									<dt>{t("averageDuration")}</dt>
									<dd>
										{formatDuration(turnStats.averageDurationMs)}
										<small>{t("recordedDurations", { count: turnStats.durationCount })}</small>
									</dd>
								</div>
							</dl>
							<ul className="incident-turn-status-counts" aria-label={t("turnStatusCounts")}>
								{(Object.keys(turnStats.statusCounts) as TurnStatus[]).map((status) => (
									<li key={status}>
										<span>{t(`turnStatus.${status}`)}</span>
										<strong>{turnStats.statusCounts[status]}</strong>
									</li>
								))}
							</ul>
							<div className="incident-turn-table-toolbar">
								<div className="incident-turn-filters" role="group" aria-label={t("filterTurns")}>
									{(["all", "positive", "errors"] as const).map((filter) => (
										<button
											key={filter}
											type="button"
											className="incident-turn-filter"
											aria-pressed={turnFilter === filter}
											onClick={() => setTurnFilter(filter)}>
											{t(`turnFilter.${filter}`)}
										</button>
									))}
								</div>
								<span className="incident-turn-result-count">
									{t("turnResultCount", { count: visibleTurns.length })}
								</span>
							</div>
							{visibleTurns.length === 0 ? (
								<p className="incident-empty-state">
									{turnStats.turns.length === 0 ? t("noTurns") : t("noTurnsForFilter")}
								</p>
							) : (
								<div className="incident-turn-table-scroll">
									<table className="incident-turn-table">
										<caption className="incident-sr-only">{t("turnTableCaption")}</caption>
										<thead>
											<tr>
												<th scope="col">{t("turnColumn")}</th>
												<th scope="col">{t("statusColumn")}</th>
												<th scope="col">{t("startedColumn")}</th>
												<th scope="col">{t("durationColumn")}</th>
												<th scope="col">{t("stepsColumn")}</th>
												<th scope="col">{t("toolCallsColumn")}</th>
												<th scope="col">{t("toolErrorsColumn")}</th>
											</tr>
										</thead>
										<tbody>
											{visibleTurns.map((turn) => (
												<tr
													key={turn.id}
													className={
														selectedTurnId === turn.id
															? "incident-turn-row--selected"
															: undefined
													}>
													<th scope="row">
														<button
															className="incident-turn-select"
															aria-label={t("inspectTurn", {
																task: turn.chatTitle ?? turn.taskLabel,
																id: turn.id.slice(0, 12),
															})}
															type="button"
															onClick={() => requestTurnDetail(turn.id)}>
															<span>{turn.chatTitle ?? turn.taskLabel}</span>
															<ProjectLabel workspace={turn.workspace} />
															<code title={turn.id}>{turn.id.slice(0, 12)}</code>
														</button>
													</th>
													<td>
														<span
															className={`incident-turn-status incident-turn-status--${turn.status}`}>
															{t(`turnStatus.${turn.status}`)}
														</span>
													</td>
													<td>
														<time dateTime={new Date(turn.startedAt).toISOString()}>
															{formatTimestamp(turn.startedAt)}
														</time>
													</td>
													<td>{formatDuration(turn.durationMs)}</td>
													<td>{turn.steps}</td>
													<td>{turn.toolCalls}</td>
													<td
														className={
															turn.toolErrors > 0
																? "incident-turn-error-count"
																: undefined
														}>
														{turn.toolErrors}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</section>

						{selectedTurnId && (
							<section
								className="incident-panel incident-turn-detail"
								aria-labelledby="incident-turn-detail-heading">
								<div className="incident-panel-heading">
									<div>
										<p className="incident-dashboard-eyebrow">{t("investigation")}</p>
										<h2 id="incident-turn-detail-heading">
											{t("turnDetailTitle", {
												task:
													selectedTurn?.chatTitle ??
													selectedTurn?.taskLabel ??
													t("taskUnavailable"),
											})}
										</h2>
										<ProjectLabel workspace={selectedTurn?.workspace} />
										{selectedTurn && (
											<p className="incident-turn-detail-id">
												<code title={selectedTurn.id}>{selectedTurn.id}</code>
											</p>
										)}
									</div>
									{selectedTurn && (
										<button
											className="incident-debug-button"
											aria-label={t("startDebuggingTurnFor", {
												task: selectedTurn.chatTitle ?? selectedTurn.taskLabel,
											})}
											type="button"
											onClick={() =>
												vscode.postMessage({
													type: "startDebuggingTurn",
													turnId: selectedTurn.id,
												})
											}>
											<Activity size={15} aria-hidden="true" />
											{t("startDebuggingTurn")}
										</button>
									)}
								</div>
								{loadingTurnDetail ? (
									<p className="incident-empty-state" role="status">
										{t("loadingTurnDetail")}
									</p>
								) : unavailableTurnDetail ? (
									<p className="incident-empty-state" role="status">
										{t("turnDetailUnavailable")}
									</p>
								) : invalidTurnDetail ? (
									<p className="incident-empty-state" role="alert">
										{t("turnDetailInvalid")}
									</p>
								) : turnDetail ? (
									<>
										{turnDetail.turn.evidenceStatus && (
											<p className="incident-turn-detail-evidence">
												{evidenceStatusLabel(turnDetail.turn.evidenceStatus)}
											</p>
										)}
										{turnDetail.events.length > 0 ? (
											<ol className="incident-turn-events">
												{turnDetail.events.map((item) => (
													<li className="incident-turn-event" key={item.id}>
														<span className="incident-turn-event-kind">
															{t(`turnEvent.${item.kind}`)}
														</span>
														{item.toolName && (
															<code className="incident-turn-event-tool">
																{item.toolName}
															</code>
														)}
														<time dateTime={new Date(item.at).toISOString()}>
															{formatTimestamp(item.at)}
														</time>
													</li>
												))}
											</ol>
										) : (
											<p className="incident-empty-state">{t("noTurnEvents")}</p>
										)}
									</>
								) : null}
							</section>
						)}

						<div className="incident-dashboard-grid">
							<section className="incident-panel" aria-labelledby="incident-activity-heading">
								<div className="incident-panel-heading">
									<div>
										<h2 id="incident-activity-heading">{t("activity")}</h2>
									</div>
								</div>
								{snapshot.tasks.length === 0 ? (
									<p className="incident-empty-state">{t("noActivity")}</p>
								) : (
									<ul className="incident-task-list">
										{snapshot.tasks.map((task) => (
											<li className="incident-task" key={task.taskId}>
												<div className="incident-task-heading">
													<button
														type="button"
														className="incident-task-select"
														aria-expanded={selectedTaskId === task.taskId}
														onClick={() =>
															setSelectedTaskId(
																selectedTaskId === task.taskId
																	? undefined
																	: task.taskId,
															)
														}>
														{task.chatTitle ?? task.label}
													</button>
													<span
														className={`incident-task-state incident-task-state--${task.state}`}>
														{t(`state.${task.state}`)}
													</span>
												</div>
												<ProjectLabel workspace={task.workspace} />
												<p className="incident-task-updated">
													<Clock3 size={13} aria-hidden="true" />
													{t("updated", {
														time: formatTimestamp(task.updatedAt) ?? t("unknownTime"),
													})}
												</p>
												<p
													className="incident-task-evidence"
													hidden={selectedTaskId !== task.taskId}>
													{evidenceStatusLabel(task.evidenceStatus)}
												</p>
												{selectedTaskId === task.taskId &&
													(task.timeline.length > 0 ? (
														<ol className="incident-timeline">
															{task.timeline.map((event) => (
																<li className="incident-timeline-item" key={event.id}>
																	<span className="incident-timeline-kind">
																		{t(`event.${event.kind}`)}
																	</span>
																	<span className="incident-timeline-label">
																		{event.label}
																	</span>
																	<time dateTime={new Date(event.at).toISOString()}>
																		{formatTimestamp(event.at)}
																	</time>
																</li>
															))}
														</ol>
													) : (
														<p className="incident-empty-timeline">{t("noTaskActivity")}</p>
													))}
											</li>
										))}
									</ul>
								)}
							</section>
						</div>
					</>
				)}
				{snapshot && (
					<p className="incident-dashboard-updated" aria-live="polite">
						{t("snapshotUpdated", { time: formatTimestamp(snapshot.generatedAt) ?? t("unknownTime") })}
					</p>
				)}
			</div>
		</main>
	)
}
