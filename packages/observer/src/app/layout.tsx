import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RelayAuth Observer",
  description: "Live RelayAuth authorization event observer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
