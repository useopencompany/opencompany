# Marketing site

## Demo requests

Demo CTAs and the legacy `/talk` link lead to `/request-demo`. The form asks for
work email, company type, and team size before opening the existing Cal.com
calendar in a dialog. Team size replaces the reference flow's funding question
because the product is built for founders and small teams, including bootstrapped
startups. All company types can schedule; this collects context without adding
an unvalidated rejection rule.

Email and qualification answers are passed to Cal.com using its documented
[booking field prefill parameters](https://cal.com/help/bookings/prefill-fields).
The answers prefill the booking's `notes` field and Cal.com booking metadata so
the host receives them with the completed booking. Keep that booking question
enabled on the event. Team size also prefills the existing custom question
`how-many-people-are-on-your-team`, mapping to its current values (`Just me`,
`2-10`, `10-50`, `>50`). Keep that mapping in sync if the Cal.com event changes.
The existing calendar still asks for name, AI stack, website, and intended use.
There is no separate lead submission or saved request before a booking is completed.
Form values stay in component memory until the visitor opens scheduling; they
are not added to the marketing page URL, local storage, or analytics events.
The dialog also offers a prefilled external link if the embedded calendar fails.

Run `bun run --cwd apps/marketing test` for the booking URL contract. For UI
verification, check `/request-demo` on desktop and mobile, missing/invalid fields,
keyboard selection, dialog close/reopen, and Cal.com's prefilled booking form.
Do not submit a real booking during verification.

## Favicon

`public/icon/oc-icon-v3.svg` is the source for both favicon formats. The root
layout advertises the SVG, and Next.js also serves `app/favicon.ico` for browsers
and clients that use the ICO format.

Regenerate the ICO from the SVG when the brand mark changes. From this directory,
using ImageMagick 6 (`magick` instead of `convert` with ImageMagick 7):

```sh
convert -background none -density 384 public/icon/oc-icon-v3.svg \
  -define png:color-type=6 -define icon:auto-resize=256,128,64,48,32,16 app/favicon.ico
```

Keep the SVG's square canvas and transparent background. Exporting a separate
bitmap previously introduced an opaque white background and uneven padding, so
the logo appeared off-center in browsers using the ICO. The ICO includes native
16px and 32px frames for browser tabs as well as larger sizes.
The explicit PNG color type keeps the embedded 256px frame in RGBA format, as
required by Next.js's ICO decoder.

After regenerating, build the marketing app and check `/favicon.ico` and the
homepage's icon links in a browser. Compare the ICO and SVG at tab sizes on light
and dark backgrounds; verify that the mark is centered and the corners are
transparent.
