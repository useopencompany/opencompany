/**
 * Navigation model for the design-system docs site. Plain data so it can be used
 * from both server and client components (sidebar, command palette, static params).
 */

export type NavItem = {
  title: string;
  href: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const FOUNDATIONS: NavItem[] = [
  { title: "Introduction", href: "/" },
  { title: "Colors", href: "/foundations/colors" },
  { title: "Typography", href: "/foundations/typography" },
  { title: "Corner Radius", href: "/foundations/corner-radius" },
  { title: "Icons", href: "/foundations/icons" },
];

/** Component slugs in alphabetical order. Each maps to a demo in lib/registry. */
export const COMPONENT_SLUGS = [
  "alert",
  "avatar",
  "badge",
  "button",
  "card",
  "checkbox",
  "command",
  "dialog",
  "input",
  "label",
  "popover",
  "select",
  "separator",
  "skeleton",
  "sonner",
  "spinner",
  "switch",
  "tabs",
  "textarea",
  "tooltip",
] as const;

export type ComponentSlug = (typeof COMPONENT_SLUGS)[number];

export const COMPONENT_TITLES: Record<ComponentSlug, string> = {
  alert: "Alert",
  avatar: "Avatar",
  badge: "Badge",
  button: "Button",
  card: "Card",
  checkbox: "Checkbox",
  command: "Command",
  dialog: "Dialog",
  input: "Input",
  label: "Label",
  popover: "Popover",
  select: "Select",
  separator: "Separator",
  skeleton: "Skeleton",
  sonner: "Sonner",
  spinner: "Spinner",
  switch: "Switch",
  tabs: "Tabs",
  textarea: "Textarea",
  tooltip: "Tooltip",
};

export function componentHref(slug: ComponentSlug): string {
  return `/components/${slug}`;
}

export const NAV_SECTIONS: NavSection[] = [
  { title: "Foundations", items: FOUNDATIONS },
  {
    title: "Components",
    items: COMPONENT_SLUGS.map((slug) => ({
      title: COMPONENT_TITLES[slug],
      href: componentHref(slug),
    })),
  },
];
