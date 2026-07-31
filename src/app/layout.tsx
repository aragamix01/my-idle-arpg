import type { Metadata, Viewport } from "next";
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
  title: "Idle ARPG",
  description: "An idle action RPG: clear stages, roll loot, craft it into something better.",
};

/**
 * Mobile is the primary target, and three of these are load-bearing there.
 *
 * `viewportFit: 'cover'` lets the page paint under the notch and the home
 * indicator, which is only safe because the layout pads itself back out with
 * `env(safe-area-inset-*)` - without the pair, the action bar sits under
 * Safari's chrome and cannot be tapped.
 *
 * `userScalable: false` with `maximumScale: 1` because a double-tap on a game
 * canvas means "hit that thing", not "zoom". Accessibility zoom at the OS level
 * is unaffected; this only stops accidental pinch drift mid-fight.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        `overscroll-none` kills the rubber-band scroll that made the whole page
        bounce when a drag started on the canvas, and `overflow-hidden` keeps the
        shell fixed so only the sheet and the panel scroll.
      */}
      <body className="h-full overflow-hidden overscroll-none bg-neutral-950">{children}</body>
    </html>
  );
}
