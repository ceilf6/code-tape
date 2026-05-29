import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installStaleChunkRecovery } from "./app/staleChunkRecovery";
import "./styles/globals.css";

installStaleChunkRecovery();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
