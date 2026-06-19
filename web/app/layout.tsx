import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inference Marketplace",
  description: "Bitcoin-settled AI inference marketplace — register your model, get paid in sBTC.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
