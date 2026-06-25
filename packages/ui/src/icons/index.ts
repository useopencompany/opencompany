/**
 * Icon entry point for the design system.
 *
 * We standardize on Iconists Central (`@central-icons-react`, round / outlined /
 * radius-2 / stroke-2 variant). Apps import icons from `@opencompany/ui/icons`
 * rather than the icon package directly, so the set can be swapped or extended in
 * this one file without touching call sites.
 *
 * The named exports below alias Central glyphs to the Lucide names the design
 * system already uses (drop-in compatibility). For a Central icon that isn't
 * curated here, import it directly, e.g.
 *   import { IconRocket } from "@central-icons-react/round-outlined-radius-2-stroke-2";
 *
 * Central icons accept `size`, `color`, `ariaHidden` plus all SVG props, and use
 * `currentColor` — so `text-*` and `size-*` utilities tint and size them, same as
 * before.
 */

import {
  IconArrowBoxRight,
  IconArrowRight,
  IconArrowUpWall,
  IconBell,
  IconBookmark,
  IconBubbleText,
  IconCalendar1,
  IconChainLink1,
  IconCheckmark1,
  IconChevronBottom,
  IconChevronRight,
  IconCircleCheck,
  IconCircleInfo,
  IconClock,
  IconCreditCard1,
  IconCrossSmall,
  IconDotGrid1x3Horizontal,
  IconEmail1,
  IconExclamationTriangle,
  IconEyeOpen,
  IconFileText,
  IconFilter1,
  IconFolder1,
  IconHeart,
  IconHome,
  IconImport,
  IconLayersThree,
  IconLoader,
  IconLock,
  IconMagnifyingGlass,
  IconMinusSmall,
  IconMoon,
  IconPageEmpty,
  IconPlusMedium,
  IconSend,
  IconSettingsGear1,
  IconSparklesThree,
  IconSquareArrowOutTopLeft,
  IconSquareBehindSquare1,
  IconStar,
  IconSun,
  IconTag,
  IconTrashCan,
  IconUser,
  IconUserGroup,
  IconZap,
} from "@central-icons-react/round-outlined-radius-2-stroke-2";

export * from "./brand-icons";
// Project-owned icons (model providers, social, brand) — same currentColor +
// LucideIcon contract, so they compose with Central icons and the same utilities.
export * from "./provider-icons";
// Brand logos for connectable services (Linear, Slack, Gmail, …) — used to badge
// agent tool calls with the service they touch. Same currentColor + LucideIcon contract.
export * from "./service-icons";
// Shared icon types (`IconProps` / `LucideProps` / `LucideIcon`).
export type { IconProps, LucideIcon, LucideProps } from "./types";
export {
  IconArrowBoxRight as LogOut,
  IconArrowRight as ArrowRight,
  IconArrowUpWall as Upload,
  IconBell as Bell,
  IconBookmark as Bookmark,
  IconBubbleText as MessageSquare,
  IconCalendar1 as Calendar,
  IconChainLink1 as Link,
  IconCheckmark1 as Check,
  IconChevronBottom as ChevronDown,
  IconChevronRight as ChevronRight,
  IconCircleCheck as CheckCircle2,
  IconCircleCheck as CircleCheck,
  IconCircleInfo as Info,
  IconClock as Clock,
  IconCreditCard1 as CreditCard,
  IconCrossSmall as X,
  IconDotGrid1x3Horizontal as MoreHorizontal,
  IconEmail1 as Mail,
  IconExclamationTriangle as TriangleAlert,
  IconEyeOpen as Eye,
  IconFileText as FileText,
  IconFilter1 as Filter,
  IconFolder1 as Folder,
  IconHeart as Heart,
  IconHome as Home,
  IconImport as Download,
  IconLayersThree as Layers,
  IconLoader as Loader2,
  IconLock as Lock,
  IconMagnifyingGlass as Search,
  IconMinusSmall as Minus,
  IconMoon as Moon,
  IconPageEmpty as File,
  IconPlusMedium as Plus,
  IconSend as Send,
  IconSettingsGear1 as Settings,
  IconSparklesThree as Sparkles,
  IconSquareArrowOutTopLeft as ExternalLink,
  IconSquareBehindSquare1 as Copy,
  IconStar as Star,
  IconSun as Sun,
  IconTag as Tag,
  IconTrashCan as Trash2,
  IconUser as User,
  IconUserGroup as Users,
  IconZap as Zap,
};
