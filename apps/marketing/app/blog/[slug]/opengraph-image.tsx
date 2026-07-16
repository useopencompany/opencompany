import { ImageResponse } from "next/og";
import { getAllSlugs, getPostBySlug } from "@/lib/blog";

export const alt = "opencompany blog";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f7f7f5",
        color: "#111111",
        padding: "72px 80px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontFamily: "monospace",
          fontSize: 22,
        }}
      >
        <div style={{ width: 18, height: 18, background: "#7c3aed", transform: "rotate(45deg)" }} />
        opencompany
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            color: "#7c3aed",
            fontFamily: "monospace",
            fontSize: 18,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          {post?.cluster.replaceAll("-", " ") ?? "blog"}
        </div>
        <div
          style={{
            maxWidth: 1000,
            fontSize: 58,
            fontWeight: 600,
            lineHeight: 1.12,
            letterSpacing: "-0.035em",
          }}
        >
          {post?.title ?? "opencompany blog"}
        </div>
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 18, color: "#6b6b6b" }}>
        opencompany.cloud/blog
      </div>
    </div>,
    size,
  );
}
