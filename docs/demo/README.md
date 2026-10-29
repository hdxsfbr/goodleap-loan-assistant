# Demo video pipeline

Produces `out/goodleap-loan-assistant-demo.mp4` (1440x900, 30 fps, H.264 + AAC 48 kHz): a screen capture of the
running app narrated in Andre's cloned voice (Chatterbox standard model, local GPU). The scene list is
[`../demo-script.md`](../demo-script.md); each scene's narration is `narration/sNN_<name>.txt`. Everything is
scripted, so the video can be regenerated after a UI change.

Nothing on screen is simulated. Every copilot turn and the document extraction are live model calls through
the key in `.env` (about ten copilot turns and three extraction calls per take, under $0.50). The only
edits are the removal of waiting time, listed under "What is cut" below.

## Regenerate

Run from the repository root. `playwright-core` is not a project dependency; point `NODE_PATH` at any
`node_modules` that has it (the scripts load it with `createRequire`).

1. **Narration** (needs the `chatterbox` conda env and the voice reference in `~/code/chatterbox-play`):
   ```bash
   conda run -n chatterbox --no-capture-output python -u docs/demo/tts_std.py docs/demo/narration docs/demo/audio < /dev/null
   conda run -n chatterbox --no-capture-output python -u docs/demo/tts_std.py docs/demo/narration docs/demo/audio s04,s08 < /dev/null   # only these scenes
   bash docs/demo/verify.sh audio        # duration against word count, loudness, silent gaps
   ```
   One WAV per scene (`audio/sNN_*_norm.wav`, 48 kHz mono, loudness-normalised) and `audio/durations.json`. A
   paragraph that comes back with a stall of more than 1.5 s inside it is generated again.
2. **Slides**:
   ```bash
   NODE_PATH=<dir with node_modules/playwright-core> node docs/demo/slides.mjs
   ```
   renders `slides/title.html` and `slides/close.html` to `slides/png/s01_title.png` and `s11_close.png`
   (1440x900) and copies the title to `thumbnail.png`.
3. **Capture.** The server must be running from the commit being recorded, on a port nothing else uses:
   ```bash
   PORT=3477 npm start < /dev/null > /tmp/demo-server.log 2>&1 &
   curl -s localhost:3477/api/healthz        # has_llm_key true; versions.git_sha is the commit to record
   NODE_PATH=<...> node docs/demo/record.mjs                              # all scenes -> docs/demo/clips/
   NODE_PATH=<...> CLIPS_DIR=/tmp/dry node docs/demo/record.mjs           # a dry run into a throwaway directory
   NODE_PATH=<...> SCENES=s03,s08 node docs/demo/record.mjs               # selected scenes
   bash docs/demo/verify.sh sheets       # a contact sheet per clip, to look at before moving on
   ```
   Restart the server before a take so that review ticket ids start at REV-1001 (a reset empties the
   application but not that counter). `record.mjs` resets the server (`POST /api/reset`) before scene s02,
   which then shows the "Load demo project" click itself. The scenes share one application, so they run in order. A single scene can be
   re-recorded with `SCENES=` only while the server still holds the state the scene before it left, and
   only if that scene has not already run on that state (s05 confirms proposals, s07 submits, s08 and s09
   decide values); otherwise re-run from `s02`. `BASE` (default `http://localhost:3477`), `CLIPS_DIR` and
   `CHROME` are also read from the environment.
4. **Assembly**:
   ```bash
   bash docs/demo/mux.sh
   bash docs/demo/verify.sh final        # ffprobe, contact sheet, per-scene audio and video lengths
   ```
   Kill the server when the take is done.

## How the capture works

- One browser context per scene at 1440x900, so each scene is its own clip, `clips/sNN_<name>.webm`. A cursor
  is injected into every page; it follows the real mouse events and glides to each target before it clicks.
  Reduced motion is off.
- The frames come from a CDP screencast that `record.mjs` timestamps itself and assembles into a 30 fps
  WebM. Playwright's `recordVideo` was tried first and is not used: it writes at least one 25 fps frame for
  every screencast frame, so any stretch with fast page updates (a scroll, a cursor glide) plays longer than
  it took, the clip drifts 5 to 12 % from the wall clock, and cut intervals measured on the wall clock land
  on the wrong frames. Here a clip's time is the wall clock, so a cut is exact.
- `slow(label, fn)` wraps every model turn and the extraction wait. It records `[start + 1.0, end - 0.4]`
  (seconds from the clip's first frame) into `clips/cuts.json`: the click and a second of the pending state
  stay in, and the footage resumes 0.4 s before the result appears. A wait too short to be worth cutting is
  not cut. Page loads at the start of a scene are recorded as a cut `[0, ready]`.
- `mux.sh` strips the intervals in `cuts.json` (`select` on the 30 fps stream), paces each scene to its
  narration (a short clip holds its last frame, a long one is sped up by at most 1.6x, and if it is still
  longer the scene runs on and the voice ends early), re-encodes every scene and still to one intermediate
  (H.264 crf 20, AAC, 48 kHz stereo), concatenates, and fades the last second out. Titles are held for
  their narration plus 0.6 s. Narration starts 0.2 s into its scene.
- Two live replies decide whether a take is usable. Scenes s03 and s04 need the model's explanation of the
  options, not the guardrail's fallback text ("I can't phrase that in a way that meets lending rules"): the
  three compliance checks sometimes block a draft, and the fallback is the correct behaviour but not what the
  narration describes. When one shows up, `record.mjs` discards the take and runs it again from a reset
  (`TAKES`, default 3). A retried scene on its own would leave the first attempt's events at the top of the
  audit trail that scene s10 scrolls through. Scene s06 expects the opposite, the fixed refusal, and is not
  checked.
- In s07 the files are attached by clicking the "Replace" button and answering the file chooser with
  `samples/estimate.pdf` and `samples/scope_letter.pdf` (the pay stub stays from the demo loader).
- Pauses on screen are a little longer than the minimums in the scene list where the narration runs long, so
  that no scene holds its last frame for more than about five seconds.

## What is cut

- **Model waits.** In scenes s03, s05 and s06 the time the copilot takes to answer (usually 3 to 6 s a turn,
  less the second that stays in), and in s07 the time the document extraction takes after Submit (about 16 s
  of the 17 s wait). Each cut is in `clips/cuts.json`; the log of the take prints it as `cut a-b`.
- **Page loads.** The first fraction of a second of each scene, before the page has drawn.
- **Scene s04's setup.** The chat lives in the page's memory and every scene is a fresh browser context, so
  scene s04 has no options table to open the homeowner view from. It asks the same question as s03 again,
  off camera, and the footage starts when the table and the explanation are on screen, as scene s03 left
  them. The whole of that setup (page load, the question, the live turn) is one cut in `cuts.json`. It adds
  one real copilot turn to the audit trail, which scene s10 shows.

## What happens off camera between s08 and s09

After s08 (the pay stub partly decided) and before s09, `record.mjs` decides every value of the project
estimate and the scope letter through the review API (`POST /api/review/tasks/<id>/decisions`, "confirm",
with the located-by-reviewer acknowledgement where a value was not located), so that s09 can stay on the
discrepancy and finish with Complete review. These are real reviewer decisions, recorded in the audit
trail like any other; they are not on screen. The log of the take prints how many values it decided.

## Deliverables

| File | What |
| --- | --- |
| `out/goodleap-loan-assistant-demo.mp4` | the narrated video |
| `thumbnail.png` | the title slide at 1440x900, for the video's thumbnail |
| `slides/title.html`, `slides/close.html` | the title and close slides (source of the stills) |
| `narration/*.txt`, `tts_std.py` | the narration text and the script that voices it |
| `record.mjs`, `mux.sh`, `slides.mjs`, `verify.sh` | capture, assembly, slides, checks |

Generated media (`audio/`, `clips/`, `slides/png/`, `out/`) is gitignored; the scripts, narration and slide
HTML are the source of truth. `thumbnail.png` is committed.
