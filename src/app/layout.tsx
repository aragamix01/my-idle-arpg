import type { Metadata, Viewport } from "next";
import { Pixelify_Sans, Silkscreen, VT323 } from "next/font/google";
import "./globals.css";

/*
  Three pixel faces, each with one job - see Phase 7a in currency-item.txt.

  Silkscreen is a caps-only display face: labels, buttons, headings. It is
  unreadable as body copy, so Pixelify Sans carries every sentence. VT323 is
  the number face, because it is monospaced and figures that change ten times a
  second must not make the row they sit in jitter sideways.
*/
const pixelify = Pixelify_Sans({
  variable: "--font-pixelify",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const silkscreen = Silkscreen({
  variable: "--font-silkscreen",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const vt323 = VT323({
  variable: "--font-vt323",
  subsets: ["latin"],
  weight: "400",
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
  themeColor: "#070605",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${pixelify.variable} ${silkscreen.variable} ${vt323.variable} h-full`}
    >
      {/*
        `overscroll-none` kills the rubber-band scroll that made the whole page
        bounce when a drag started on the canvas, and `overflow-hidden` keeps the
        shell fixed so only the screens scroll.
      */}
      <body className="h-full overflow-hidden overscroll-none">{children}</body>
    </html>
  );
}
