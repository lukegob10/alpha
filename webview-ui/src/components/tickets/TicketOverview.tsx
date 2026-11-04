import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TicketOverview as TicketOverviewData } from "@alpha-code/types"
import { nearestProgressPoint, progressTicks, progressX, smoothProgressPath } from "./ticketProgressChart"
import "./ticket-overview.css"

interface TicketOverviewProps {
	overview: TicketOverviewData | undefined
	loading: boolean
	error?: string
	onRetry: () => void
}

const chartHeight = 280
const chartLeft = 44
const chartRight = 16
const chartTop = 28
const chartBottom = 52
const ringRadius = 45
const circumference = 2 * Math.PI * ringRadius

export function TicketOverview({ overview, loading, error, onRetry }: TicketOverviewProps) {
	const { t, i18n } = useTranslation("tickets")
	const chartRef = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(640)
	const [hoverIndex, setHoverIndex] = useState<number>()
	const [selectedIndex, setSelectedIndex] = useState<number>()
	const chartDescription = useId()
	const locale = i18n?.resolvedLanguage ?? "en"
	const formatDate = useMemo(
		() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
		[locale],
	)
	const formatNumber = useMemo(() => new Intl.NumberFormat(locale), [locale])
	const shortDate = useMemo(
		() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }),
		[locale],
	)
	const points = overview?.points ?? []
	const hasPoints = points.length > 0
	const datesKey = points.map((point) => point.date).join(",")

	useEffect(() => {
		setHoverIndex(undefined)
		setSelectedIndex(undefined)
	}, [datesKey])

	useEffect(() => {
		const element = chartRef.current
		if (!element) return
		const update = () => {
			const measured = element.getBoundingClientRect().width
			if (measured > 0) setWidth(measured)
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(element)
		return () => observer.disconnect()
	}, [hasPoints])

	const plotWidth = Math.max(1, width - chartLeft - chartRight)
	const plotHeight = chartHeight - chartTop - chartBottom
	const largest = Math.max(overview?.total ?? 0, ...points.map((point) => point.total), 1)
	const tickSize = Math.max(1, Math.ceil(largest / 4))
	const ceiling = tickSize * 4
	const y = (value: number) => chartTop + plotHeight - (value / ceiling) * plotHeight
	const x = (date: string) => progressX(points, date, chartLeft, plotWidth)
	const completePath = smoothProgressPath(points.map((point) => ({ x: x(point.date), y: y(point.complete) })))
	const scopePath = smoothProgressPath(points.map((point) => ({ x: x(point.date), y: y(point.total) })))
	const percentage = overview?.total
		? overview.complete === overview.total
			? 100
			: Math.min(99, Math.round((overview.complete / overview.total) * 100))
		: 0
	const activeIndex = hoverIndex ?? selectedIndex
	const activePoint = activeIndex === undefined ? undefined : points[Math.min(activeIndex, points.length - 1)]
	const formattedDate = (date: string) => formatDate.format(new Date(`${date}T00:00:00.000Z`))
	const pointDescription = (index: number) => {
		const point = points[index]
		return point
			? t("overview.pointSummary", {
					date: formattedDate(point.date),
					complete: formatNumber.format(point.complete),
					total: formatNumber.format(point.total),
				})
			: ""
	}
	const selectPointerDate = (clientX: number, pin = false) => {
		const bounds = chartRef.current?.getBoundingClientRect()
		if (!bounds || !points.length) return
		const fraction = Math.max(0, Math.min(1, (clientX - bounds.left - chartLeft) / plotWidth))
		const index = nearestProgressPoint(points, fraction)
		setHoverIndex(index)
		if (pin) setSelectedIndex(index)
	}

	return (
		<section className="ticket-overview" aria-label={t("overview.title")} aria-busy={loading}>
			{error && (
				<div className="ticket-overview-error" role="alert">
					<p>{error}</p>
					<button type="button" onClick={onRetry} disabled={loading}>
						{t("reload")}
					</button>
				</div>
			)}
			{!overview ? (
				!error && <p role="status">{t(loading ? "overview.loading" : "overview.empty")}</p>
			) : (
				<>
					<div className="ticket-overview-summary">
						<div
							className="ticket-overview-ring"
							role="img"
							aria-label={t("overview.percentage", { percent: percentage })}>
							<svg viewBox="0 0 106 106" aria-hidden="true">
								<circle cx="53" cy="53" r={ringRadius} className="ticket-overview-ring-track" />
								<circle
									cx="53"
									cy="53"
									r={ringRadius}
									className="ticket-overview-ring-progress"
									strokeDasharray={`${(percentage / 100) * circumference} ${circumference}`}
								/>
							</svg>
							<div className="ticket-overview-ring-label" aria-hidden="true">
								<span>{formatNumber.format(percentage)}%</span>
								<small>{t("overview.complete")}</small>
							</div>
						</div>
						<div>
							<h1>
								{t("overview.completedCount", {
									complete: formatNumber.format(overview.complete),
									total: formatNumber.format(overview.total),
								})}
							</h1>
							<p>
								{t("overview.openCounts", {
									inProgress: formatNumber.format(overview.inProgress),
									backlog: formatNumber.format(overview.backlog),
								})}
							</p>
						</div>
					</div>
					{!overview.total && <p>{t("overview.empty")}</p>}
					<div className="ticket-overview-history-heading">
						<h2>{t("overview.history")}</h2>
						{points.length > 0 && (
							<span>
								{formattedDate(points[0].date)}
								{points.length > 1 && ` – ${formattedDate(points[points.length - 1].date)}`}
							</span>
						)}
					</div>
					<div className="ticket-overview-legend" aria-hidden="true">
						<span>
							<i />
							{t("overview.completed")}
						</span>
						<span>
							<i className="ticket-overview-scope-swatch" />
							{t("overview.scope")}
						</span>
					</div>
					{!points.length ? (
						<p>{t("overview.noHistory")}</p>
					) : (
						<>
							<div className="ticket-overview-chart" ref={chartRef}>
								<svg
									viewBox={`0 0 ${width} ${chartHeight}`}
									role="img"
									aria-label={t("overview.chart")}
									aria-describedby={chartDescription}
									onPointerMove={(event) => selectPointerDate(event.clientX)}
									onPointerDown={(event) => selectPointerDate(event.clientX, true)}
									onPointerLeave={() => setHoverIndex(undefined)}>
									<text x={chartLeft} y={15}>
										{t("overview.ticketsAxis")}
									</text>
									{Array.from({ length: 5 }, (_, index) => index * tickSize).map((value) => (
										<g key={value}>
											<line
												x1={chartLeft}
												x2={width - chartRight}
												y1={y(value)}
												y2={y(value)}
												className="ticket-overview-grid"
											/>
											<text x={chartLeft - 10} y={y(value) + 4} textAnchor="end">
												{formatNumber.format(value)}
											</text>
										</g>
									))}
									{progressTicks(points, width < 440 ? 3 : 5).map((index, _, ticks) => (
										<text
											key={points[index].date}
											x={x(points[index].date)}
											y={chartHeight - chartBottom + 24}
											textAnchor={
												index === ticks[0]
													? "start"
													: index === ticks[ticks.length - 1]
														? "end"
														: "middle"
											}>
											{shortDate.format(new Date(`${points[index].date}T00:00:00.000Z`))}
										</text>
									))}
									<text x={chartLeft + plotWidth / 2} y={chartHeight - 3} textAnchor="middle">
										{t("overview.dateAxis")}
									</text>
									<path d={scopePath} className="ticket-overview-scope-path" />
									<path d={completePath} className="ticket-overview-complete-path" />
									{points.length === 1 && (
										<g>
											<circle
												cx={x(points[0].date)}
												cy={y(points[0].total)}
												r={4}
												className="ticket-overview-scope-dot"
											/>
											<circle
												cx={x(points[0].date)}
												cy={y(points[0].complete)}
												r={4}
												className="ticket-overview-complete-dot"
											/>
										</g>
									)}
									{activePoint && (
										<g>
											<line
												x1={x(activePoint.date)}
												x2={x(activePoint.date)}
												y1={chartTop}
												y2={chartHeight - chartBottom}
												className="ticket-overview-guide"
											/>
											<circle
												cx={x(activePoint.date)}
												cy={y(activePoint.total)}
												r={4}
												className="ticket-overview-scope-dot"
											/>
											<circle
												cx={x(activePoint.date)}
												cy={y(activePoint.complete)}
												r={4}
												className="ticket-overview-complete-dot"
											/>
										</g>
									)}
								</svg>
								{activePoint && (
									<div
										className="ticket-overview-tooltip"
										style={{ left: Math.max(0, Math.min(width - 200, x(activePoint.date) + 8)) }}>
										<strong>{formattedDate(activePoint.date)}</strong>
										<span>{t("overview.completedValue", { count: activePoint.complete })}</span>
										<span>{t("overview.scopeValue", { count: activePoint.total })}</span>
									</div>
								)}
							</div>
							<p id={chartDescription} className="ticket-overview-help">
								{t("overview.chartHelp")}
							</p>
							{points.length > 1 && (
								<label className="ticket-overview-date-picker">
									<span>{t("overview.inspectDate")}</span>
									<input
										type="range"
										min={0}
										max={points.length - 1}
										value={selectedIndex ?? points.length - 1}
										aria-valuetext={pointDescription(selectedIndex ?? points.length - 1)}
										onFocus={() => setSelectedIndex((index) => index ?? points.length - 1)}
										onChange={(event) => {
											setHoverIndex(undefined)
											setSelectedIndex(Number(event.target.value))
										}}
									/>
								</label>
							)}
							<p className="ticket-overview-selection" role="status">
								{selectedIndex === undefined ? "" : pointDescription(selectedIndex)}
							</p>
						</>
					)}
					{points.length === 1 && <p className="ticket-overview-note">{t("overview.firstObservation")}</p>}
					<p className="ticket-overview-note">{t("overview.counting", { count: overview.canceled })}</p>
					{overview.invalidFiles.length > 0 && (
						<p role="alert">{t("overview.invalidFiles", { count: overview.invalidFiles.length })}</p>
					)}
				</>
			)}
		</section>
	)
}
