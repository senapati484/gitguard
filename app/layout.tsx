import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GitGuard",
    template: "%s | GitGuard",
  },
  description:
    "Automated GitHub repository security checks powered by a GitHub App.",
  keywords: ["github", "security", "code review", "ci", "github app"],
  authors: [{ name: "GitGuard" }],
  openGraph: {
    title: "GitGuard",
    description: "Automated GitHub repository security checks.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}

