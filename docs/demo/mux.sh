#!/usr/bin/env bash
# Assembles the demo video: for every narrated scene, strips the intervals recorded in
# clips/cuts.json from its clip (or takes its title still), paces the picture to its narration,
# re-encodes everything to one intermediate (1440x900, 30 fps, yuv420p, H.264 crf 20, AAC 48 kHz
# stereo), concatenates the scenes and fades out the last second.
#
#   bash docs/demo/mux.sh
#
# Environment (all optional): CLIPS_DIR, AUDIO_DIR, OUT_DIR, OUT_NAME, FFMPEG, FFPROBE, and the
# pacing knobs LEAD, TAIL, SLACK, MAX_SPEEDUP, FADE.
#
# Pacing, per scene (N = narration length, V = footage left after the cuts):
#   still      held for LEAD + N + TAIL
#   V <= LEAD + N + TAIL            the last frame is held until the narration and TAIL have played
#   V <= LEAD + N + SLACK           the footage plays as it is; the voice finishes inside it
#   longer                          sped up to LEAD + N + SLACK, by at most MAX_SPEEDUP; if it is still
#                                   longer the scene runs at that speed and the voice ends early
# Narration starts LEAD seconds into its scene, so the voice never starts before its picture.
set -euo pipefail
cd "$(dirname "$0")"

FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/usr/bin/ffprobe}"
CLIPS_DIR="${CLIPS_DIR:-clips}"
AUDIO_DIR="${AUDIO_DIR:-audio}"
OUT_DIR="${OUT_DIR:-out}"
OUT_NAME="${OUT_NAME:-goodleap-loan-assistant-demo}"
LEAD="${LEAD:-0.2}"
TAIL="${TAIL:-0.6}"
SLACK="${SLACK:-2.0}"
MAX_SPEEDUP="${MAX_SPEEDUP:-1.6}"
FADE="${FADE:-1.0}"
export LEAD TAIL SLACK MAX_SPEEDUP

SEG="$OUT_DIR/seg"
rm -rf "$SEG"
mkdir -p "$SEG"
: > "$OUT_DIR/concat.txt"
: > "$OUT_DIR/plan.tsv"

dur() { "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$1"; }

for wav in $(ls "$AUDIO_DIR"/s[0-9][0-9]_*_norm.wav | LC_ALL=C sort); do
  stem="$(basename "$wav" _norm.wav)"
  n="${stem%%_*}"
  narr="$(dur "$wav")"
  clip="$(ls "$CLIPS_DIR"/"$n"_*.webm 2>/dev/null | grep -v '\.failed\.webm$' | head -n 1 || true)"
  still="$(ls slides/png/"$n"_*.png 2>/dev/null | head -n 1 || true)"
  seg="$SEG/$n.mp4"

  if [ -n "$clip" ]; then
    clipstem="$(basename "$clip" .webm)"
    raw="$(dur "$clip")"
    # Cut list -> select expression, kept length, pacing. One line of shell assignments.
    eval "$(python3 - "$CLIPS_DIR/cuts.json" "$clipstem" "$raw" "$narr" <<'PY'
import json, os, sys
cuts_file, stem, raw, narr = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
lead, tail, slack, cap = (float(os.environ[k]) for k in ("LEAD", "TAIL", "SLACK", "MAX_SPEEDUP"))
cuts = json.load(open(cuts_file)).get(stem) if os.path.exists(cuts_file) else None
if cuts is None:
    sys.exit(f"echo 'no cuts recorded for {stem} in {cuts_file}' >&2; exit 1")
cuts = sorted([max(0.0, a), min(raw, b)] for a, b in cuts if b > a)
cut = sum(b - a for a, b in cuts)
kept = raw - cut
need = lead + narr + tail
if kept <= need:
    speed, hold, total, mode = 1.0, need - kept, need, "held"
elif kept <= lead + narr + slack:
    speed, hold, total, mode = 1.0, 0.0, kept, "as recorded"
else:
    target = lead + narr + slack
    speed = min(cap, kept / target)
    hold, total = 0.0, kept / speed
    mode = f"sped up x{speed:.2f}" + ("" if kept / speed <= target + 0.01 else ", voice ends early")
expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in cuts)
print(f"EXPR='{expr}'; CUT={cut:.2f}; KEPT={kept:.2f}; SPEED={speed:.4f}; HOLD={hold:.3f}; TOTAL={total:.3f}; MODE='{mode}'")
PY
)"
    vf="fps=30"
    [ -n "$EXPR" ] && vf="$vf,select='not($EXPR)',setpts=N/(30*TB)"
    vf="$vf,setpts=PTS/$SPEED,scale=1440:900:flags=lanczos,format=yuv420p,fps=30"
    [ "$(python3 -c "print(1 if $HOLD > 0 else 0)")" = 1 ] && vf="$vf,tpad=stop_mode=clone:stop_duration=$HOLD"
    "$FFMPEG" -nostdin -y -loglevel error -i "$clip" -i "$wav" \
      -filter_complex "[0:v]$vf[v];[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=$(python3 -c "print(int(round($LEAD*1000)))"):all=1,apad=whole_dur=$TOTAL[a]" \
      -map "[v]" -map "[a]" -t "$TOTAL" -r 30 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
      -c:a aac -b:a 192k -ar 48000 -ac 2 "$seg"
    printf "%s\tclip\t%s\t%s\t%s\t%s\t%s\t%s\n" "$clipstem" "$raw" "$CUT" "$KEPT" "$narr" "$TOTAL" "$MODE" >> "$OUT_DIR/plan.tsv"
  elif [ -n "$still" ]; then
    total="$(python3 -c "print(round($LEAD + $narr + $TAIL, 3))")"
    "$FFMPEG" -nostdin -y -loglevel error -loop 1 -framerate 30 -t "$total" -i "$still" -i "$wav" \
      -filter_complex "[0:v]scale=1440:900:flags=lanczos,format=yuv420p[v];[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=$(python3 -c "print(int(round($LEAD*1000)))"):all=1,apad=whole_dur=$total[a]" \
      -map "[v]" -map "[a]" -t "$total" -r 30 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
      -c:a aac -b:a 192k -ar 48000 -ac 2 "$seg"
    printf "%s\tstill\t-\t-\t-\t%s\t%s\theld\n" "$(basename "$still" .png)" "$narr" "$total" >> "$OUT_DIR/plan.tsv"
  else
    echo "no clip or still for $n" >&2
    exit 1
  fi
  echo "file 'seg/$n.mp4'" >> "$OUT_DIR/concat.txt"
done

"$FFMPEG" -nostdin -y -loglevel error -f concat -safe 0 -i "$OUT_DIR/concat.txt" -c copy "$OUT_DIR/_joined.mp4"
total="$(dur "$OUT_DIR/_joined.mp4")"
start="$(python3 -c "print(round($total - $FADE, 3))")"
"$FFMPEG" -nostdin -y -loglevel error -i "$OUT_DIR/_joined.mp4" \
  -vf "fade=t=out:st=$start:d=$FADE" -af "afade=t=out:st=$start:d=$FADE" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart \
  "$OUT_DIR/$OUT_NAME.mp4"
rm -f "$OUT_DIR/_joined.mp4"

echo
printf "%-24s %-6s %8s %8s %8s %8s %8s  %s\n" scene kind footage cut kept narration result mode
while IFS=$'\t' read -r name kind raw cut kept narr total mode; do
  printf "%-24s %-6s %8s %8s %8s %8s %8s  %s\n" "$name" "$kind" "$raw" "$cut" "$kept" "$narr" "$total" "$mode"
done < "$OUT_DIR/plan.tsv"
"$FFPROBE" -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate,sample_rate,channels \
  -of default=nw=1 "$OUT_DIR/$OUT_NAME.mp4"
