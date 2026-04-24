import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scaler Sales Agent",
  description: "AI-assisted pre-call briefs and post-call personalised PDFs for Scaler BDAs",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
