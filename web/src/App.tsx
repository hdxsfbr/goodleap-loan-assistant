import { lazy, Suspense, useEffect, useState } from "react";
import { Link, Outlet, Route, Routes } from "react-router-dom";
import type { HealthResponse } from "@shared/schemas";
import { getHealth } from "./api";
import { KeyBanner } from "./components/KeyBanner";
import { RoleTabs } from "./components/RoleTabs";
import { HealthContext, useHealth } from "./health";
import { useSessionFlags } from "./hooks";
import { AuditView } from "./routes/AuditView";
import { ContractorView } from "./routes/ContractorView";
import { HomeownerView } from "./routes/HomeownerView";

export { useHealth };

// The reviewer screen carries the PDF renderer, so it loads when the tab is opened.
const ReviewerView = lazy(() => import("./routes/ReviewerView").then((module) => ({ default: module.ReviewerView })));

function Shell() {
  const health = useHealth();
  const flags = useSessionFlags();
  return (
    <>
      <RoleTabs />
      <KeyBanner health={health} keyMissing={flags.key_missing} keyRejected={flags.key_rejected} />
      <main>
        <Outlet />
      </main>
    </>
  );
}

function Reviewer() {
  return (
    <Suspense
      fallback={
        <div className="page">
          <p className="muted">Loading...</p>
        </div>
      }
    >
      <ReviewerView />
    </Suspense>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1 className="page-title">That page does not exist</h1>
      <p>
        <Link to="/">Go to the application</Link>
      </p>
    </div>
  );
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((next) => {
        if (!cancelled) setHealth(next);
      })
      .catch(() => {
        // The shell still renders; the flags stay unknown and the screens report their own failures.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HealthContext.Provider value={health}>
      <Routes>
        <Route path="/applications/:applicationId/homeowner" element={<HomeownerView />} />
        <Route path="/homeowner" element={<HomeownerView />} />
        <Route element={<Shell />}>
          <Route path="/" element={<ContractorView />} />
          <Route path="/applications/:applicationId" element={<ContractorView />} />
          <Route path="/reviewer" element={<Reviewer />} />
          <Route path="/reviewer/:taskId" element={<Reviewer />} />
          <Route path="/audit/:applicationId" element={<AuditView />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </HealthContext.Provider>
  );
}
