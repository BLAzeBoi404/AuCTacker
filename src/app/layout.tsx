import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AucTracker — Мониторинг аукциона STALCRAFT",
  description:
    "Цены, активные лоты, история продаж и уведомления о лотах аукциона STALCRAFT: X. Слежка за предметами по заточке, редкости и цене.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a0a0c'/%3E%3Cpath d='M32 12l5.6 11.3 12.4 1.8-9 8.8 2.1 12.4L32 40.5l-11.1 5.8 2.1-12.4-9-8.8 12.4-1.8z' fill='%23d4ff3f'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#060607",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-[#060607] text-zinc-200 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
