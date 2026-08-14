import type { Metadata } from "next";
import { Noto_Sans_SC } from "next/font/google";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const notoSans = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "天巡 · 全球自然灾害预警",
  description: "全球灾害事件实时发现、遥感可观测性筛选和卫星任务候选生成。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={notoSans.variable}>{children}</body>
    </html>
  );
}
