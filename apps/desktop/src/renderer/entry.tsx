// The page entry point. It is separate from the App component so that React
// Fast Refresh can update App in place instead of reloading the page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./renderer";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Renderer root element was not found.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
