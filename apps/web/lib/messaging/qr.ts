import QRCode from "qrcode";

// Render `text` to an inline SVG QR code (server-side). We generate locally rather than calling a
// third-party QR image service so the one-time link token in the deep link never leaves our backend.
export async function renderQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    width: 220,
    errorCorrectionLevel: "M",
  });
}
