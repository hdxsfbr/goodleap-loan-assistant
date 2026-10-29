import { ocrTesseractAdapter } from "../../server/extraction/adapters/ocr-tesseract.js";
import { simplePdf } from "./pdf.js";

// Whether the real OCR engine can run here: it needs data/tessdata/eng.traineddata, which the first
// run downloads. Offline with no cached file, the tests that need the engine skip and say why.

let checked: Promise<string | null> | undefined;

/** Starts the engine once and returns null when it works, or the reason it cannot run. */
export function ocrUnavailableReason(): Promise<string | null> {
  checked ??= ocrTesseractAdapter(simplePdf([null])).then(
    () => null,
    (err: unknown) => {
      const reason = `the OCR engine could not start (${err instanceof Error ? err.message : String(err)}); data/tessdata/eng.traineddata is missing and could not be downloaded`;
      console.warn(`SKIPPED, ${reason}`);
      return reason;
    },
  );
  return checked;
}
