import { DM_Mono } from "next/font/google";

/**
 * Micro-label face for this landing variant. The reference design pairs a
 * single grotesque for everything readable with a mono used only for
 * 10px uppercase labels, so the mono never carries body copy.
 */
export const microMono = DM_Mono({
  subsets: ["latin"],
  weight: ["500"],
  display: "swap",
});

/**
 * Shared layout and type constants for the variant.
 *
 * The reference design is built on a restrained scale: a 1350px container with
 * 48px gutters, a 12-column grid, and a display size of 28px that never grows.
 * Keeping these as named constants stops the numbers drifting between sections —
 * the whole look depends on every section landing on the same column edges.
 */

/** 84.375rem = 1350px. Gutters are 16px on mobile, 48px from `sm` up. */
export const SHELL = "mx-auto w-full max-w-[84.375rem] px-4 sm:px-12";

/** 12-column grid every section aligns to, so headings and panels share edges. */
export const GRID = "grid grid-cols-12 gap-x-6";

/**
 * 28px/1.2 at -0.03em — the one display size, used for the h1 and every h2.
 * Deliberately not responsive: the reference design holds 28px from 390px up to
 * 1440px, and that restraint is most of why the page reads as engineered rather
 * than as a billboard.
 */
export const DISPLAY =
  "text-balance font-normal text-[28px] text-foreground leading-[1.2] tracking-[-0.03em]";

/** 17px/1.5 — the only size above body copy, reserved for lead paragraphs. */
export const LEAD = "text-[17px] leading-[1.5]";

/** 15px/1.5 — body copy, sub-headlines, and footer links. */
export const BODY = "text-[15px] leading-[1.5]";

/** Vertical rhythm: sections open on a hairline and close with 160px of air. */
export const SECTION = "border-border border-t pt-6 pb-24 sm:pb-40";
