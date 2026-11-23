import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "./components/WorkspaceApp";
import "./styles.css";
import "./mobile.css";
import "./workspace.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceApp />
  </StrictMode>,
);
