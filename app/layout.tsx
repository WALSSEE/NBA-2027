import Nav from "./components/Nav";

export const metadata = {
  title: "NBA Model",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fi">
      <body style={{ margin: 0, background: "#0f172a" }}>
        <Nav />
        {children}
      </body>
    </html>
  );
}
