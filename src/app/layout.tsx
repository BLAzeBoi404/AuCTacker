import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AucTracker — цены аукциона STALCRAFT",
  description:
    "AucTracker: цены, активные лоты, история продаж и уведомления о лотах аукциона STALCRAFT. Слежка по заточке, редкости и цене.",
  themeColor: "#060607",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a0a0c'/%3E%3Ctext x='32' y='45' font-family='Arial,sans-serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%2334d399'%3EA%3C/text%3E%3C/svg%3E",
  },
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
