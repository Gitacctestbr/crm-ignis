import "../../assets/main.css";
import "../../assets/theme.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { SidePanelApp } from "../../src/app/SidePanelApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidePanelApp />
  </React.StrictMode>
);
