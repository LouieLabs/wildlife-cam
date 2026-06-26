export const metadata = {
  title: 'Louie Labs Wildlife Monitor',
  description: 'Backyard wildlife camera dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
          background: '#0f172a',
          color: '#e2e8f0',
        }}
      >
        {children}
      </body>
    </html>
  );
}
