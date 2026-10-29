import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { toErrorBody } from "../errors";
import { getDocumentFile } from "../review-api";
import {
  boxesOnPage,
  boxToPixels,
  formatRowValue,
  LOCATION_LABELS,
  rowPage,
  sourceClaim,
  type PageSize,
} from "../review-present";
import type { TaskDocumentView } from "../review-types";

// The page with the boxes. The server sends each located value's box as fractions of the page with
// a top-left origin; the box is drawn at those fractions times the size the page was rendered at.
// A value that was not located gets no box: the viewer shows what the model quoted and the page it
// claimed instead.

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MIN_PAGE_WIDTH = 280;
const MAX_PAGE_WIDTH = 760;
const DEFAULT_PAGE_WIDTH = 640;

type FileState =
  | { status: "loading" }
  | { status: "ready"; blob: Blob }
  | { status: "error"; message: string };

interface RenderedPage extends PageSize {
  page: number;
}

export interface DocumentViewerProps {
  doc: TaskDocumentView;
  selectedKey: string | null;
  /** Changes every time the reviewer picks a value, so picking the selected one again returns to its page. */
  focusNonce: number;
  notLocatedCaption: string;
  onSelect(fieldKey: string): void;
}

export function DocumentViewer({ doc, selectedKey, focusNonce, notLocatedCaption, onSelect }: DocumentViewerProps) {
  const selectedRow = useMemo(
    () => doc.rows.find((row) => row.field_key === selectedKey) ?? null,
    [doc.rows, selectedKey],
  );
  const [file, setFile] = useState<FileState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [page, setPage] = useState(() => (selectedRow ? rowPage(selectedRow) : null) ?? 1);
  const [width, setWidth] = useState(DEFAULT_PAGE_WIDTH);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // The file, fetched once per document so a failure carries the server's own message.
  useEffect(() => {
    let cancelled = false;
    setFile({ status: "loading" });
    getDocumentFile(doc.file_url)
      .then((blob) => {
        if (!cancelled) setFile({ status: "ready", blob });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFile({ status: "error", message: toErrorBody(error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [doc.file_url, attempt]);

  // The page is as wide as its column, within limits, and is drawn again when the column changes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setWidth(Math.max(MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, Math.floor(stage.clientWidth))));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Picking a value shows the page it was read from, or the page the model claimed.
  useEffect(() => {
    const target = selectedRow ? rowPage(selectedRow) : null;
    if (target !== null) setPage(target);
    // Only a new pick moves the page; a refreshed row (a decision) must not undo the reviewer's own paging.
  }, [selectedKey, focusNonce]);

  const shownPage = numPages === null ? page : Math.min(Math.max(page, 1), numPages);

  const onRenderSuccess = useCallback(() => {
    const element = pageRef.current;
    if (element) setRendered({ page: shownPage, width: element.clientWidth, height: element.clientHeight });
  }, [shownPage]);

  const boxesReady = rendered !== null && rendered.page === shownPage;
  const boxes = boxesReady ? boxesOnPage(doc, shownPage) : [];

  // The selected box is brought into view when the page is taller than the column.
  useEffect(() => {
    if (!boxesReady || selectedKey === null) return;
    const elements = Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []);
    elements.find((element) => element.dataset.field === selectedKey)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [boxesReady, selectedKey, focusNonce]);
  const claim = selectedRow?.location === "not_located" ? sourceClaim(selectedRow) : null;

  return (
    <section className="viewer" aria-label={`${doc.title}, page view`}>
      <header className="viewer-bar">
        <h2 className="viewer-title">{doc.title}</h2>
        {numPages !== null ? (
          <div className="viewer-pager">
            {numPages > 1 ? (
              <button
                type="button"
                className="button small"
                onClick={() => setPage(shownPage - 1)}
                disabled={shownPage <= 1}
                aria-label="Previous page"
              >
                Previous
              </button>
            ) : null}
            <span className="viewer-page-count" aria-live="polite">
              Page {shownPage} of {numPages}
            </span>
            {numPages > 1 ? (
              <button
                type="button"
                className="button small"
                onClick={() => setPage(shownPage + 1)}
                disabled={shownPage >= numPages}
                aria-label="Next page"
              >
                Next
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {selectedRow && claim ? (
        <div className="viewer-callout" role="note" data-testid="not-located-callout">
          <p className="viewer-callout-title">
            {selectedRow.label} · {LOCATION_LABELS.not_located}
          </p>
          <blockquote className="viewer-callout-quote">
            {claim.quote ? `“${claim.quote}”` : "No text was quoted."}
          </blockquote>
          <p className="viewer-callout-page">
            {claim.page === null ? "The model gave no page." : `The model claimed page ${claim.page}.`}
            {selectedRow.proposal?.value !== null && selectedRow.proposal?.value !== undefined
              ? ` Read as ${formatRowValue(selectedRow.type, selectedRow.proposal.value)}.`
              : ""}
          </p>
          <p className="viewer-callout-caption">{notLocatedCaption}</p>
        </div>
      ) : null}

      <div className="viewer-stage" ref={stageRef}>
        {file.status === "loading" ? <p className="muted viewer-message">Loading the document...</p> : null}
        {file.status === "error" ? (
          <div className="notice error viewer-message" role="alert">
            <p>{file.message}</p>
            <button type="button" className="button small" onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {file.status === "ready" ? (
          <Document
            file={file.blob}
            loading={<p className="muted viewer-message">Loading the document...</p>}
            error={<p className="notice error viewer-message">The document could not be shown.</p>}
            onLoadSuccess={({ numPages: count }) => setNumPages(count)}
            onLoadError={() => setNumPages(null)}
          >
            <div className="viewer-sheet" style={{ width }}>
              <Page
                pageNumber={shownPage}
                width={width}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                inputRef={pageRef}
                onRenderSuccess={onRenderSuccess}
                loading={<div className="viewer-page-loading" style={{ width, height: Math.round(width * 1.29) }} />}
                error={<p className="notice error viewer-message">This page could not be shown.</p>}
              >
                <div className="box-layer">
                  {rendered
                    ? boxes.map((box) => {
                        const row = doc.rows.find((candidate) => candidate.field_key === box.field_key);
                        const pixels = boxToPixels(box.bbox, rendered);
                        const classes = [
                          "page-box",
                          `box-${row?.status ?? "undecided"}`,
                          box.field_key === selectedKey ? "selected" : "",
                        ];
                        return (
                          <button
                            key={box.field_key}
                            type="button"
                            className={classes.filter(Boolean).join(" ")}
                            style={{
                              left: pixels.left,
                              top: pixels.top,
                              width: pixels.width,
                              height: pixels.height,
                            }}
                            title={row?.label}
                            aria-label={row ? `${row.label}: ${formatRowValue(row.type, row.proposal?.value ?? null)}` : box.field_key}
                            aria-pressed={box.field_key === selectedKey}
                            data-field={box.field_key}
                            onClick={() => onSelect(box.field_key)}
                          />
                        );
                      })
                    : null}
                </div>
              </Page>
            </div>
          </Document>
        ) : null}
      </div>
    </section>
  );
}
