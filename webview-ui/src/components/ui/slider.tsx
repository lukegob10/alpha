import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, "aria-label": ariaLabel, "aria-valuetext": ariaValueText, ...props }, ref) => (
	<SliderPrimitive.Root
		ref={ref}
		className={cn("relative flex w-full touch-none select-none items-center", className)}
		aria-label={ariaLabel}
		aria-valuetext={ariaValueText}
		{...props}>
		<SliderPrimitive.Track
			data-slot="slider-track"
			className="relative w-full h-[8px] grow overflow-hidden bg-accent rounded-sm border">
			<SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-vscode-button-background" />
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			data-slot="slider-thumb"
			aria-label={ariaLabel}
			aria-valuetext={ariaValueText}
			className="block h-3 w-3 rounded-full border border-primary/50 bg-vscode-button-background transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		/>
	</SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
