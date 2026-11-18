import type { Metadata } from "next";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./fonts.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3 (both in fonts.css),
// titles = CMU Serif (the bundled lh-cmu @font-face in globals.css). All are
// served from public/fonts, so builds and pages never reach a font CDN.

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	return (
		<html
			lang="en"
			className={theme.mode}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<head>
				<link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
				<link rel="preload" href="/fonts/source-sans-3-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
