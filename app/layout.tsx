import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '多线代理控制台',
  description: '查看 Mihomo 多线代理的健康、速度与活动连接。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body>{children}</body>
    </html>
  );
}
