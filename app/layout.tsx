export const metadata = {
  title: "DDICBot",
  description: "Drug–drug interaction checker · 药物相互作用查询",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
