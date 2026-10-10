import type { ReactNode } from "react";

export const metadata = {
  title: "Echo",
  description: "Camera glasses that stay quiet until something matters.",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
