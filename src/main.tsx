import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountApp } from "./components/AccountApp";
import "./styles.css";
import "./mobile.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountApp />
  </StrictMode>,
);
