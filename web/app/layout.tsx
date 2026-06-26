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
          background: '#ffffff',
          color: '#0f172a',
        }}
      >
        {children}
      </body>
    </html>
  );
}
