# Service logo sources

Use a vendor's published mark for an integration, and verify that it belongs to
that product (for example, Fathom's meeting assistant and Fathom Analytics are
different services). Add it to `service-icons.tsx` so catalog rows, plugin details,
and other service badges can share the same artwork. Generic UI icons are for
actions and unbranded plugins, not substitutes for service logos.

The original monochrome paths in this module come from [Simple Icons](https://simpleicons.org),
except where their comments identify another source. The following marks were
verified against vendor assets on 2026-09-09. Brand assets remain the property of
their respective owners; inclusion identifies the integration and does not imply
endorsement.

| Mark | Vendor asset | Adaptation |
| --- | --- | --- |
| Supabase | [Brand guidelines](https://supabase.com/brand-assets), [SVG](https://github.com/supabase/supabase/blob/master/packages/common/assets/images/supabase-logo-icon.svg) | Original paths, colors, gradients, and viewBox. |
| Infisical | [Official repository SVG](https://github.com/Infisical/infisical/blob/main/frontend/public/images/gradientLogo.svg) | Original paths, gradient, and viewBox. |
| Jamie | [Website header](https://www.meetjamie.ai/) | Symbol path extracted from the wordmark; viewBox cropped to the symbol. Uses the surrounding foreground color. |
| Latitude | [Website header](https://latitude.so/) | First four paths of the header SVG (`svg-1440095973_4505`); viewBox cropped to the symbol. Original colors. |
| Render | [Website icon SVG](https://render.com/icon.svg) | Original path and viewBox; foreground color replaces the favicon's global light/dark CSS. |
| Vercel | [Brand kit](https://vercel.com/geist/brands) | `Vercel/icon/dark/vercel-icon-dark.svg`; original path and viewBox, foreground color. |
| Resend | [Brand kit](https://resend.com/brand), [white icon SVG](https://cdn.resend.com/brand/resend-icon-white.svg) | Original path, foreground color; viewBox crops the asset's surrounding whitespace because the UI badge provides padding. |
| SigNoz | [Website logo SVG](https://signoz.io/img/SigNozLogo-orange.svg) | Original paths, colors, gradient, filter, and viewBox. |
| Fathom | [Vendor website](https://www.fathom.ai/about-us), [header SVG](https://cdn.prod.website-files.com/6899da9beccbdbe92be49b5d/68e7961f4ff1cd5e326512f7_logo-wordmark-new.svg) | First three paths (the meeting assistant's symbol), original colors; viewBox cropped to the symbol. Replaces the unrelated Fathom Analytics mark. |

SVG attributes are translated to JSX. Gradients and filters use React `useId` to
keep references local to each rendered instance, including when a sidebar row and
a detail heading display the same logo together. Assets are bundled locally;
rendering does not fetch from vendor websites.

## Convex (verified 2026-09-09)

Source: https://www.convex.dev/brand — official download https://www.convex.dev/resources/logos.zip,
`Logos/SVG/symbol-color.svg`. The shared ConvexIcon preserves the vendor viewBox, paths,
clear space, and three brand colors. Only sizing is delegated to component props. No IDs,
gradients, masks, or clipping references occur in the source. This is Convex's database
platform, not the unrelated Convex blockchain project.

## Outlook (verified 2026-09-10)

Source: [Microsoft Outlook product page](https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook), [official FY26 SVG](https://www.microsoft.com/content/dam/microsoft/bade/images/icons/en-us/m365-app-icons-fy26/Outlook-Icon-FY26.svg).
The shared OutlookIcon preserves the 48 × 48 viewBox, paths, colors, gradients, and filters.
Only SVG-to-JSX attribute translation and per-instance ids are applied. Both mail and calendar
use the Outlook product mark.

## Google Admin (verified 2026-09-10)

Vendor source: https://workspace.google.com/products/admin/.
Exact SVG: https://storage.googleapis.com/gweb-workspace-assets/uploads/7uffzv9dk4sn-1Wi9Oq1LQ3QRaQSg7l82o5-d3afb24f28626a725d5f2507b2523595-Admin.svg.
GoogleAdminIcon retains all six paths, original blue colors, and the 96 × 96
viewBox. The two redundant rectangular clips exactly covering the viewBox were
removed; there are no remaining SVG IDs or references. Width and height follow
shared icon props. Catalog, installed rows, and details share this component.
