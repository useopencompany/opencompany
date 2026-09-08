# Marketing site

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
