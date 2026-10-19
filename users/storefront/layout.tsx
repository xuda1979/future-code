import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Future Code — AI R&D on your terms | GATC', description: 'Future Code commercial desktop preview. Planned downloads for Windows, macOS and Ubuntu, simple annual passes, and your choice of AI model provider.' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
