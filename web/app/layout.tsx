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
          background: '#f1f5f9',
          color: '#0f172a',
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        {children}
      </body>
    </html>
  );
}
