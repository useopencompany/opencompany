import { ImageResponse } from "next/og";

const size = { width: 1200, height: 630 };

export function createSharedChatOpenGraphImage(titleInput: string) {
  const title = titleInput.trim() || "Shared chat";
  const titleFontSize = title.length > 52 ? 58 : title.length > 34 ? 64 : 72;

  return new ImageResponse(
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#f7f7f5",
        color: "#111111",
        padding: 46,
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -240,
          right: -110,
          display: "flex",
          width: 560,
          height: 560,
          border: "1px solid #deded8",
          borderRadius: 280,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 80,
          bottom: -360,
          display: "flex",
          width: 620,
          height: 620,
          border: "1px solid #e7e7e2",
          borderRadius: 310,
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          flex: 1,
          flexDirection: "column",
          justifyContent: "space-between",
          border: "1px solid #deded8",
          borderRadius: 30,
          background: "rgba(255, 255, 255, 0.92)",
          padding: "48px 54px",
          boxShadow: "0 20px 70px rgba(17, 17, 17, 0.08)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <BrandMark />
            <div
              style={{
                display: "flex",
                fontSize: 24,
                fontWeight: 650,
                letterSpacing: "-0.025em",
              }}
            >
              opencompany
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: "1px solid #deded8",
              borderRadius: 999,
              background: "#f7f7f5",
              padding: "10px 17px",
              color: "#555550",
              fontSize: 18,
              fontWeight: 550,
            }}
          >
            <div
              style={{
                display: "flex",
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "#216b35",
              }}
            />
            Shared chat
          </div>
        </div>

        <div
          style={{
            display: "flex",
            maxWidth: 980,
            flexDirection: "column",
            gap: 22,
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#6b6b66",
              fontSize: 17,
              fontWeight: 650,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Read-only conversation
          </div>
          <div
            style={{
              display: "flex",
              fontSize: titleFontSize,
              fontWeight: 650,
              lineHeight: 1.08,
              letterSpacing: "-0.045em",
            }}
          >
            {title}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: "#777772",
            fontSize: 18,
          }}
        >
          Shared from opencompany
        </div>
      </div>
    </div>,
    {
      ...size,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  );
}

function BrandMark() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M89.5 50C89.5 28.1848 71.8152 10.5 50 10.5C28.1848 10.5 10.5 28.1848 10.5 50C10.5 71.8152 28.1848 89.5 50 89.5C71.8152 89.5 89.5 71.8152 89.5 50ZM94.5 50C94.5 74.5767 74.5767 94.5 50 94.5C25.4233 94.5 5.5 74.5767 5.5 50C5.5 25.4233 25.4233 5.5 50 5.5C74.5767 5.5 94.5 25.4233 94.5 50Z"
        fill="#111111"
      />
      <path
        d="M64.5 50C64.5 38.6418 62.6316 28.4743 59.7031 21.2393C58.2363 17.6154 56.5523 14.8494 54.8105 13.0293C53.0749 11.2156 51.4494 10.5 50 10.5C48.5506 10.5 46.9251 11.2156 45.1895 13.0293C43.4477 14.8494 41.7637 17.6154 40.2969 21.2393C37.3684 28.4743 35.5 38.6418 35.5 50C35.5 61.3582 37.3684 71.5257 40.2969 78.7607C41.7637 82.3846 43.4477 85.1506 45.1895 86.9707C46.9251 88.7844 48.5506 89.5 50 89.5C51.4494 89.5 53.0749 88.7844 54.8105 86.9707C56.5523 85.1506 58.2363 82.3846 59.7031 78.7607C62.6316 71.5257 64.5 61.3582 64.5 50ZM69.5 50C69.5 61.8377 67.5622 72.6708 64.3379 80.6367C62.7285 84.6129 60.7495 87.9973 58.4238 90.4277C56.0918 92.8646 53.245 94.5 50 94.5C46.755 94.5 43.9082 92.8646 41.5762 90.4277C39.2505 87.9973 37.2715 84.6129 35.6621 80.6367C32.4378 72.6708 30.5 61.8377 30.5 50C30.5 38.1623 32.4378 27.3292 35.6621 19.3633C37.2715 15.3871 39.2505 12.0027 41.5762 9.57227C43.9082 7.13535 46.755 5.5 50 5.5C53.245 5.5 56.0918 7.13535 58.4238 9.57227C60.7495 12.0027 62.7285 15.3871 64.3379 19.3633C67.5622 27.3292 69.5 38.1623 69.5 50Z"
        fill="#111111"
      />
      <path
        d="M92 47.5C93.3807 47.5 94.5 48.6193 94.5 50C94.5 51.3807 93.3807 52.5 92 52.5H8C6.61929 52.5 5.5 51.3807 5.5 50C5.5 48.6193 6.61929 47.5 8 47.5H92Z"
        fill="#111111"
      />
      <path
        d="M50 28C52 40.6667 59.3333 48 72 50C59.3333 52 52 59.3333 50 72C48 59.3333 40.6667 52 28 50C40.6667 48 48 40.6667 50 28Z"
        fill="#111111"
      />
    </svg>
  );
}
