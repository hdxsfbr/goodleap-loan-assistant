#!/usr/bin/env bash
# Checks for the demo pipeline. Subcommands:
#   verify.sh audio                narration clips: duration against word count, loudness, silent gaps
#   verify.sh sheets [clips_dir]   a 4x3 contact sheet per clip -> <clips_dir>/sheets/sNN.png (look at them)
#   verify.sh final                the finished video: streams, a contact sheet (a frame every 10 s),
#                                  per-scene audio/video lengths and where each narration starts
# Environment (optional): CLIPS_DIR, AUDIO_DIR, OUT_DIR, OUT_NAME, FFMPEG, FFPROBE.
set -euo pipefail
cd "$(dirname "$0")"

FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/usr/bin/ffprobe}"
CLIPS_DIR="${CLIPS_DIR:-clips}"
AUDIO_DIR="${AUDIO_DIR:-audio}"
OUT_DIR="${OUT_DIR:-out}"
OUT_NAME="${OUT_NAME:-goodleap-loan-assistant-demo}"
dur() { "$FFPROBE" -v error -show_entries "${2:-format}=duration" -of csv=p=0 "$1" | head -n 1; }

case "${1:-}" in
  audio)
    printf "%-22s %6s %7s %7s %6s %9s %8s\n" clip words secs expect ratio mean_dB gap_s
    for wav in "$AUDIO_DIR"/s[0-9][0-9]_*_norm.wav; do
      stem="$(basename "$wav" _norm.wav)"
      words="$(wc -w < narration/"$stem".txt)"
      secs="$(dur "$wav")"
      vol="$("$FFMPEG" -nostdin -hide_banner -i "$wav" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-\?[0-9.]*\) dB.*/\1/p')"
      gap="$("$FFMPEG" -nostdin -hide_banner -i "$wav" -af silencedetect=noise=-40dB:d=0.5 -f null - 2>&1 \
        | sed -n 's/.*silence_duration: \([0-9.]*\).*/\1/p' | sort -n | tail -n 1)"
      python3 - "$stem" "$words" "$secs" "$vol" "${gap:-0}" <<'PY'
import sys
stem, words, secs, vol, gap = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
expect = words / 2.5
ratio = secs / expect
flag = ""
if abs(ratio - 1) > 0.4: flag += "  DURATION IMPLAUSIBLE"
if vol < -35: flag += "  SILENT"
if gap > 1.5: flag += "  LONG GAP"
print(f"{stem:<22} {words:>6} {secs:>7.2f} {expect:>7.1f} {ratio:>6.2f} {vol:>9.1f} {gap:>8.2f}{flag}")
PY
    done
    ;;
  sheets)
    dir="${2:-$CLIPS_DIR}"
    mkdir -p "$dir/sheets"
    for clip in "$dir"/s[0-9][0-9]_*.webm; do
      name="$(basename "$clip" .webm)"
      d="$(dur "$clip")"
      "$FFMPEG" -nostdin -hide_banner -loglevel error -y -i "$clip" \
        -vf "fps=$(python3 -c "print(12/$d)"),scale=480:-1,tile=4x3" -frames:v 1 "$dir/sheets/$name.png"
      echo "$dir/sheets/$name.png"
    done
    ;;
  final)
    f="$OUT_DIR/$OUT_NAME.mp4"
    echo "== $f"
    "$FFPROBE" -v error -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels \
      -of default=nw=1 "$f"
    "$FFMPEG" -nostdin -hide_banner -loglevel error -y -i "$f" -vf "fps=1/10,scale=360:-1,tile=6x6" -frames:v 1 "$OUT_DIR/contact-sheet.png"
    echo "contact sheet: $OUT_DIR/contact-sheet.png"
    echo
    printf "%-6s %9s %9s %9s %12s\n" scene video_s audio_s narr_s voice_starts_s
    for seg in "$OUT_DIR"/seg/s[0-9][0-9].mp4; do
      n="$(basename "$seg" .mp4)"
      v="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$seg")"
      a="$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "$seg")"
      narr="$(dur "$(ls "$AUDIO_DIR"/"$n"_*_norm.wav)")"
      onset="$("$FFMPEG" -nostdin -hide_banner -i "$seg" -vn -af silencedetect=noise=-40dB:d=0.1 -f null - 2>&1 \
        | sed -n 's/.*silence_end: \([0-9.]*\).*/\1/p' | head -n 1)"
      printf "%-6s %9.2f %9.2f %9.2f %12s\n" "$n" "$v" "$a" "$narr" "${onset:-0}"
    done
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 2
    ;;
esac
