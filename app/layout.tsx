import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDF to Excel — Remove Repeated Headers",
  description: "Upload a multi-page PDF table and export a clean Excel file with duplicate headers removed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
