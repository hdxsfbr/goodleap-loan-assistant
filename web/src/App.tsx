import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { HealthResponseSchema, type HealthResponse } from "@shared/schemas";

/** The flags and key state from `/api/healthz`, read once when the app loads. */
const HealthContext = createContext<HealthResponse | null>(null);

export function useHealth(): HealthResponse | null {
  return useContext(HealthContext);
}

function Shell() {
  return (
    <>
      <nav aria-label="Role">
        <NavLink to="/" end>
          Contractor
        </NavLink>{" "}
        <NavLink to="/reviewer">Reviewer</NavLink>{" "}
        <NavLink to="/audit/app_demo_001">Audit</NavLink>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}

function Contractor() {
  return <h1>Contractor</h1>;
}

function Reviewer() {
  const { taskId } = useParams();
  return <h1>{taskId ? `Review ${taskId}` : "Reviewer"}</h1>;
}

function Audit() {
  const { applicationId } = useParams();
  return <h1>Audit for {applicationId}</h1>;
}

function Homeowner() {
  const location = useLocation();
  const props: unknown = location.state;
  if (!props) return <p>Open this from the application.</p>;
  return <h1>Payment options</h1>;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/healthz")
      .then((response) => response.json())
      .then((json) => {
        if (!cancelled) setHealth(HealthResponseSchema.parse(json));
      })
      .catch(() => {
        // the shell still renders; flags stay unknown
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HealthContext.Provider value={health}>
      <Routes>
        <Route path="/homeowner" element={<Homeowner />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Contractor />} />
          <Route path="/reviewer" element={<Reviewer />} />
          <Route path="/reviewer/:taskId" element={<Reviewer />} />
          <Route path="/audit/:applicationId" element={<Audit />} />
        </Route>
      </Routes>
    </HealthContext.Provider>
  );
}
