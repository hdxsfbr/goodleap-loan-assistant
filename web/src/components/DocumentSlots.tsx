import { useState, type ChangeEvent } from "react";
import type { ApplicationView, DocumentSlot } from "@shared/schemas";
import { DOCUMENTS_HINT, NO_FILE_LABEL } from "../copy";
import { toErrorBody } from "../errors";
import { pickedFileProblem, slotRow, type SlotProgress, type SlotRow } from "../present";

const SLOTS: readonly DocumentSlot[] = ["pay_stub", "estimate", "scope_letter"];

interface DocumentSlotsProps {
  view: ApplicationView;
  /** Sends the picked file; rejects with the server's error when it is refused. */
  onUpload(slot: DocumentSlot, file: File): Promise<void>;
}

/** The Documents card: the three slots, each with the file name and a control to attach or replace it. */
export function DocumentSlots({ view, onUpload }: DocumentSlotsProps) {
  const [progress, setProgress] = useState<Partial<Record<DocumentSlot, SlotProgress>>>({});

  const update = (slot: DocumentSlot, next: SlotProgress) => setProgress((previous) => ({ ...previous, [slot]: next }));

  async function pick(slot: DocumentSlot, file: File) {
    const problem = pickedFileProblem(file);
    if (problem) {
      update(slot, { uploading: false, error: problem });
      return;
    }
    update(slot, { uploading: true, error: null });
    try {
      await onUpload(slot, file);
      update(slot, { uploading: false, error: null });
    } catch (error) {
      update(slot, { uploading: false, error: toErrorBody(error).message });
    }
  }

  return (
    <section className="slots-card" aria-labelledby="documents-title">
      <h2 id="documents-title">Documents</h2>
      <p className="slots-hint">{DOCUMENTS_HINT}</p>
      <ul className="slots">
        {SLOTS.map((slot) => (
          <DocumentSlotRow
            key={slot}
            row={slotRow(slot, view.documents, view.status, progress[slot])}
            onPick={(file) => void pick(slot, file)}
          />
        ))}
      </ul>
    </section>
  );
}

export function DocumentSlotRow({ row, onPick }: { row: SlotRow; onPick(file: File): void }) {
  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so that picking the same file again still counts as a change.
    event.target.value = "";
    if (file) onPick(file);
  }

  return (
    <li className="slot-row" data-slot={row.slot}>
      <div className="slot-info">
        <span className="slot-label">{row.label}</span>
        {row.fileName ? <span className="slot-file">{row.fileName}</span> : <span className="slot-empty">{NO_FILE_LABEL}</span>}
      </div>
      <label
        className={`button small slot-attach${row.fileName ? "" : " primary"}${row.canPick ? "" : " is-disabled"}`}
      >
        {row.actionLabel}
        <input
          type="file"
          accept="application/pdf"
          className="sr-only"
          aria-label={`${row.label}: ${row.actionLabel}`}
          disabled={!row.canPick}
          onChange={onChange}
        />
      </label>
      {row.error ? (
        <p className="field-error slot-error" role="alert">
          {row.error}
        </p>
      ) : null}
    </li>
  );
}
