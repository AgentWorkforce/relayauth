"use client";

import { useState, useEffect } from "react";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [darkMode, setDarkMode] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("observer-dark-mode");
    if (saved !== null) {
      setDarkMode(saved === "true");
    }
  }, []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.remove("theme-light");
      document.documentElement.classList.add("theme-dark");
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.classList.remove("theme-dark");
      document.documentElement.classList.add("theme-light");
      document.documentElement.setAttribute("data-theme", "light");
    }
    localStorage.setItem("observer-dark-mode", String(darkMode));
  }, [darkMode]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>RelayAuth Observer</title>
        <meta name="description" content="Live RelayAuth authorization event observer" />
      </head>
      <body className="min-h-screen">
        <div className="fixed top-4 right-4 z-50">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="brand-pill text-sm font-medium"
          >
            {darkMode ? "☀️ Light" : "🌙 Dark"}
          </button>
        </div>
        {children}
      </body>
    </html>
  );
}
