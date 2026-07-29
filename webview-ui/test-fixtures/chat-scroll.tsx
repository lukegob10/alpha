import React, { useCallback, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import { useChatScrollController } from "../src/hooks/useChatScrollController"

const initialRows = Array.from({ length: 120 }, (_, index) => index)

function ChatScrollFixture() {
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const [rows, setRows] = useState(initialRows)
	const [composerHeight, setComposerHeight] = useState(120)
	const [distance, setDistance] = useState(0)
	const controller = useChatScrollController({
		taskTs: 1,
		itemCount: rows.length,
	})
	const setScrollerRef = controller.setScrollerRef
	const bindScroller = useCallback(
		(element: HTMLDivElement | null) => {
			scrollerRef.current = element
			setScrollerRef(element)
		},
		[setScrollerRef],
	)

	const handleScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			controller.handleScrollerScroll(event)
			const element = event.currentTarget
			setDistance(Math.round(Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)))
		},
		[controller],
	)

	return (
		<main
			data-testid="fixture-shell"
			style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
			<header style={{ flexShrink: 0, borderBottom: "1px solid #374151", padding: 12 }}>
				<strong>Single-owner chat scroll fixture</strong>
				<span data-testid="fixture-mode" style={{ marginLeft: 16 }}>
					{controller.scrollMode}
				</span>
				<span data-testid="fixture-distance" style={{ marginLeft: 16 }}>
					{distance}
				</span>
			</header>
			<section
				data-testid="fixture-transcript"
				style={{ flex: "1 1 0", minHeight: 0, overflow: "hidden", position: "relative" }}>
				<div
					ref={bindScroller}
					data-testid="fixture-scroller"
					tabIndex={0}
					style={{ height: "100%", overflowY: "auto", overflowAnchor: "none", scrollbarGutter: "stable" }}
					onScroll={handleScroll}
					onWheel={controller.handleScrollerWheel}
					onPointerDown={controller.handleScrollerPointerDown}
					onPointerUp={controller.handleScrollerPointerUp}
					onPointerCancel={controller.handleScrollerPointerUp}>
					<div ref={controller.setContentRef} data-testid="fixture-content">
						{rows.map((row, index) => (
							<article
								key={row}
								data-testid="fixture-row"
								style={{
									boxSizing: "border-box",
									minHeight: index % 7 === 0 ? 150 : 54,
									borderBottom: "1px solid #374151",
									padding: 12,
								}}>
								Message {index + 1}
							</article>
						))}
					</div>
				</div>
				{controller.showScrollToBottom && (
					<button
						data-testid="fixture-bottom-button"
						style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
						onClick={controller.handleScrollToBottomClick}>
						Bottom
					</button>
				)}
			</section>
			<section
				data-testid="fixture-dock"
				style={{
					boxSizing: "border-box",
					flexShrink: 0,
					height: composerHeight,
					borderTop: "1px solid #4b5563",
					padding: 12,
				}}>
				<button
					data-testid="fixture-grow-dock"
					onClick={() => setComposerHeight((height) => (height === 120 ? 260 : 120))}>
					Resize composer
				</button>
				<button
					data-testid="fixture-append"
					style={{ marginLeft: 8 }}
					onClick={() => setRows((current) => [...current, current.length])}>
					Append output
				</button>
			</section>
		</main>
	)
}

createRoot(document.getElementById("root")!).render(<ChatScrollFixture />)
