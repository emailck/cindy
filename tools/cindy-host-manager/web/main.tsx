import { createRoot } from "react-dom/client";
import { App } from "./App";
import "virtual:theme.css";
import "./style.css";
createRoot(document.getElementById("root")!).render(<App />);
