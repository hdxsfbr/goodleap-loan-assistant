"""Narration with the standard Chatterbox model, paragraph-chunked, with clean joins.

Why not scripts/chatterbox_agent.py: it splits per sentence and butt-joins chunks with raw
silence, which produces audible prosody jumps and clicks. Here each paragraph is one generate()
call (natural intra-paragraph flow), chunk edges are trimmed of silence, a short fade is applied,
and gaps are inserted between paragraphs. Output is loudness-normalised 48 kHz mono.

Run in the chatterbox conda env:
  conda run -n chatterbox python docs/demo/tts_std.py docs/demo/narration docs/demo/audio
  conda run -n chatterbox python docs/demo/tts_std.py docs/demo/narration docs/demo/audio s04,s08   # only these scenes

A paragraph that comes back with a silent gap longer than MAX_GAP_S inside it (the model sometimes
stalls mid-sentence) is generated again, up to RETRIES times, keeping the shortest-gap take.
"""
import json, subprocess, sys
from pathlib import Path
import torch, torchaudio as ta
from chatterbox.tts import ChatterboxTTS

VOICE = "/home/hdx/code/chatterbox-play/voices/andre_voice_clean_ref.wav"
STYLE = dict(exaggeration=0.42, cfg_weight=0.50)   # the wrapper's "documentary" preset
GAP_MS = 420        # pause between paragraphs
MAX_GAP_S = 1.5     # a longer silence inside one paragraph is a stall: generate it again
RETRIES = 3
FADE_MS = 18        # tiny fade at chunk edges to avoid clicks
TRIM_DB = -45.0     # trim leading/trailing audio below this level

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
only = sys.argv[3].split(",") if len(sys.argv) > 3 else None
dst.mkdir(parents=True, exist_ok=True)
model = ChatterboxTTS.from_pretrained(device="cuda")
sr = model.sr

def trim(wav: torch.Tensor) -> torch.Tensor:
    x = wav[0]
    thresh = 10 ** (TRIM_DB / 20)
    idx = (x.abs() > thresh).nonzero()
    if idx.numel() == 0:
        return wav
    a, b = int(idx[0]), int(idx[-1]) + 1
    pad = int(sr * 0.04)
    return wav[:, max(0, a - pad): min(x.numel(), b + pad)]

def longest_gap(wav: torch.Tensor) -> float:
    """Longest run of near-silence (seconds) strictly inside the clip."""
    quiet = (wav[0].abs() < 10 ** (-40.0 / 20)).float()
    win = int(sr * 0.02)
    quiet = quiet[: quiet.numel() // win * win].view(-1, win).mean(dim=1) > 0.98
    longest = run = 0
    for q in quiet.tolist():
        run = run + 1 if q else 0
        longest = max(longest, run)
    return longest * win / sr

def fade(wav: torch.Tensor) -> torch.Tensor:
    n = int(sr * FADE_MS / 1000)
    if wav.shape[1] <= 2 * n:
        return wav
    ramp = torch.linspace(0, 1, n)
    wav = wav.clone()
    wav[:, :n] *= ramp
    wav[:, -n:] *= ramp.flip(0)
    return wav

report = {}
for txt in sorted(src.glob("s*.txt")):
    if only and not any(txt.stem.startswith(o) for o in only):
        continue
    paragraphs = [p.strip() for p in txt.read_text().split("\n\n") if p.strip()]
    pieces = []
    for i, p in enumerate(paragraphs):
        best = None
        for attempt in range(RETRIES + 1):
            with torch.inference_mode():
                wav = trim(model.generate(p, audio_prompt_path=VOICE, **STYLE).cpu())
            gap = longest_gap(wav)
            if best is None or gap < best[0]:
                best = (gap, wav)
            if gap <= MAX_GAP_S:
                break
            print(f"  {txt.stem} paragraph {i + 1}: {gap:.1f}s stall, generating again", flush=True)
        pieces.append(fade(best[1]))
        if i < len(paragraphs) - 1:
            pieces.append(torch.zeros(1, int(sr * GAP_MS / 1000)))
    out = torch.cat(pieces, dim=1)
    raw = dst / f"{txt.stem}_raw.wav"
    ta.save(str(raw), out, sr)
    norm = dst / f"{txt.stem}_norm.wav"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw),
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "1", str(norm)], check=True)
    report[txt.stem] = round(out.shape[1] / sr, 2)
    print(txt.stem, report[txt.stem], "s", f"({len(paragraphs)} paragraphs)", flush=True)
durations = dst / "durations.json"
if only and durations.exists():
    report = {**json.load(open(durations)), **report}
json.dump(dict(sorted(report.items())), open(durations, "w"), indent=2)
