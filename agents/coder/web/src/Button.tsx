import type { ButtonHTMLAttributes, ReactNode } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "./control-classes";

/**
 * The Coder UI's button. Shape and colour come from the vendored table in `control-classes.ts`;
 * nothing about either is decided here (#366).
 *
 * This is a copy of `store/console/src/components/Button.tsx` for the reason set out in
 * `control-classes.ts`'s header — the console depends on this package, not the other way round.
 * The table is held byte-identical by a test; this wrapper is not, because it is nine lines of
 * plumbing rather than a decision. What matters is that both render `buttonClass(variant, size)`.
 *
 * `type="button"` is the default on purpose. React does not override the HTML default of
 * `submit`, so a bare `<button>` inside a `<form>` submits it, which here means a full page
 * reload — the reason nearly every existing call site writes `type="button"` by hand.
 *
 * `className` is passthrough for POSITION only — `shrink-0`, `ml-auto`, `w-full`, `self-start`.
 * Do not pass padding, radius or colour: Tailwind resolves same-property utilities by their order
 * in the generated stylesheet, not by their order in the class attribute, so a `px-4` handed in
 * here does not reliably beat the size's `px-3`. If a shape is missing, add a step to the table —
 * in BOTH copies.
 *
 * ── Why eight controls in this package still draw their own box
 *
 * `.hidden{display:none}` is emitted BEFORE `.inline-flex` in the built stylesheet, so
 * `className="hidden sm:flex"` on a Button does NOT hide it on mobile — `BUTTON_BASE`'s
 * `inline-flex` wins, silently, and it looks right on the desktop the author is testing on. The
 * session header's controls are all responsive that way (`hidden sm:flex`, `sm:hidden`), so they
 * are hand-written on purpose until the table grows a way to say it. Measured in
 * `store/console/dist/assets/index.css`, not reasoned about; the same note is in the console's copy.
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
