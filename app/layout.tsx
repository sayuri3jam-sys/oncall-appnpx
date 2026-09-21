import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // 🖨️ タイトルは、ブラウザの印刷ダイアログの「ヘッダーとフッター」設定がオンのままでも
  //    印刷用紙の上部に何も印字されないよう、あえて空にしている
  title: "",
  description: "訪問看護オンコール引き継ぎ管理システム",
  // 🌐 ページ全体が日本語のため、Chromeの自動翻訳（「このページを翻訳しますか？」）を無効化する。
  //    翻訳機能が有効なままだと、氏名など動的に変わるテキストのDOMを翻訳機能が勝手に書き換えてしまい、
  //    Reactの管理するDOMとズレて「removeChild」エラーで画面がクラッシュする実例が確認されたため
  other: {
    google: "notranslate",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased notranslate`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
