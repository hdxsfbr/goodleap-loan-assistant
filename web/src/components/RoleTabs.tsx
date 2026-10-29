import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { listTasks, REVIEW_TASKS_CHANGED } from "../review-api";
import { auditPath, DEFAULT_APPLICATION_ID } from "../routes";

type Role = "contractor" | "reviewer" | "audit";

const CAPTIONS: Record<Role, string> = {
  contractor: "You are: Contractor",
  reviewer: "You are: GoodLeap reviewer",
  audit: "You are: Compliance",
};

function roleOf(pathname: string): Role {
  if (pathname.startsWith("/reviewer")) return "reviewer";
  if (pathname.startsWith("/audit")) return "audit";
  return "contractor";
}

/**
 * How many review tasks are not complete. It is read again whenever a tab is selected, when the
 * window regains focus and after a write on the reviewer screen; a failed read keeps the last count.
 */
function useOpenReviewTasks(pathname: string): number {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listTasks()
        .then((result) => {
          if (!cancelled) setOpen(result.open_count);
        })
        .catch(() => {
          // The badge is a convenience; the screens report their own failures.
        });
    };
    load();
    window.addEventListener(REVIEW_TASKS_CHANGED, load);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener(REVIEW_TASKS_CHANGED, load);
      window.removeEventListener("focus", load);
    };
  }, [pathname]);
  return open;
}

/** The top bar: the three role tabs and a caption saying whose screen this is. */
export function RoleTabs() {
  const { pathname } = useLocation();
  const role = roleOf(pathname);
  const openTasks = useOpenReviewTasks(pathname);
  const tabClass = (active: boolean) => (active ? "role-tab active" : "role-tab");
  return (
    <header className="topbar">
      <span className="brand">GoodLeap Loan Assistant</span>
      <nav className="role-tabs" aria-label="Role">
        <NavLink to="/" end className={() => tabClass(role === "contractor")}>
          Contractor
        </NavLink>
        <NavLink to="/reviewer" className={() => tabClass(role === "reviewer")}>
          Reviewer
          {openTasks > 0 ? (
            <span className="tab-badge" aria-label={`${openTasks} open review ${openTasks === 1 ? "task" : "tasks"}`}>
              {openTasks}
            </span>
          ) : null}
        </NavLink>
        <NavLink to={auditPath(DEFAULT_APPLICATION_ID)} className={() => tabClass(role === "audit")}>
          Audit
        </NavLink>
      </nav>
      <span className="role-caption">{CAPTIONS[role]}</span>
    </header>
  );
}
