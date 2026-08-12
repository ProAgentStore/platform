import type { ButtonHTMLAttributes, ReactNode } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "../lib/control-classes";

/**
 * The console's button. Shape and colour come from the table in `lib/control-classes.ts`;
 * nothing about either is decided here (#366).
 *
 * `type="button"` is the default on purpose. React does not override the HTML default of
 * `submit`, so a bare `<button>` inside a `<form>` submits it — which in this console means a
 * full page reload, and is why nearly every existing call site writes `type="button"` by hand.
 * A caller inside a real form passes `type="submit"` deliberately.
 *
 * `className` is passthrough for POSITION only — `shrink-0`, `ml-auto`, `w-full`, `self-start`.
 * Do not pass padding, radius or colour: Tailwind resolves same-property utilities by their
 * order in the generated stylesheet, not by their order in the class attribute, so a
 * `px-4` handed in here does not reliably beat the size's `px-3`. If a shape is missing, add a
 * step to the table.
 *
 * ── The test for "is this class safe to hand in", measured rather than guessed (#366)
 *
 * Safe if the vocabulary sets no rule for that CSS PROPERTY at all — `border-dashed` (style, where
 * the variant sets width and colour), `active:scale-95` (transform), every position utility.
 *
 * If the vocabulary DOES set the property, the incoming utility only wins when it is emitted later
 * in the stylesheet. Two that matter, read out of the built `index.css`:
 *
 *  - **`hidden` loses.** `.hidden{display:none}` is emitted BEFORE `.inline-flex`, so
 *    `className="hidden sm:flex"` on a Button does nothing on mobile — the control stays visible.
 *    That is silent: no error, no warning, and it looks correct on the desktop the author is on.
 *    A control with responsive visibility therefore cannot use this component today; the honest
 *    options are a wrapper element or a step in the table, not a class handed in here.
 *  - **`transition-transform` wins**, being emitted after `.transition-colors` — but it REPLACES
 *    `transition-property` rather than adding to it, so the hover colour transition is lost. Two
 *    outcomes, one class, and only one of them visible from the call site.
 */
export default function Button({
	variant = "secondary",
	size = "md",
	className = "",
	type = "button",
	children,
	...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<button type={type} className={buttonClass(variant, size, className)} {...rest}>
			{children}
		</button>
	);
}
