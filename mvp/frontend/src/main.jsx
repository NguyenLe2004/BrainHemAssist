import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Simulator from "./Simulator";
import ModelStudioApp from "./ModelStudioApp";
import DocsApp from "./DocsApp";
import FeedbackApp from "./FeedbackApp";
import SupportBot from "./components/SupportBot";
import AppAuthGate from "./components/AppAuth";
import { installAuthenticatedFetch } from "./permissions";
installAuthenticatedFetch(import.meta.env.VITE_API_BASE_URL || "");
import TrainingMonitor from "./components/TrainingMonitor";
import "./styles.css";
import "./DesignSystem.css";
import "./components/InputContrast.css";

const simulatorRoute = window.location.pathname.startsWith("/simulator");
const modelStudioRoute = window.location.pathname.startsWith("/model-studio");
const monitorRun=modelStudioRoute ? new URLSearchParams(window.location.search).get("monitor") : null;
const docsRoute = window.location.pathname.startsWith("/guide");
const feedbackRoute = window.location.pathname.startsWith("/feedback");
document.title = simulatorRoute
  ? "BrainHem CT Simulator"
  : docsRoute
  ? "BrainHem Docs · Hướng dẫn sử dụng"
  : feedbackRoute
  ? "BrainHem · Gửi phản hồi"
  : modelStudioRoute
  ? "BrainHem Model Studio"
  : "BrainHem Radiology Workstation";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppAuthGate allowAnonymous={feedbackRoute}>
      {monitorRun ? <TrainingMonitor runId={monitorRun}/> : simulatorRoute ? <Simulator /> : docsRoute ? <DocsApp /> : feedbackRoute ? <FeedbackApp /> : modelStudioRoute ? <ModelStudioApp /> : <App />}
      <SupportBot />
    </AppAuthGate>
  </React.StrictMode>,
);
