#!/usr/bin/env bash
# P3 screenshots: the Pocket band (0, 3, 9+ notes, narrow, beside the docked pane, light) and the
# harvest band. Output: working-docs/screens/p3/<name>.png (full frames) and working-docs/screens/p3/crops/ (the band).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
source $HERE/lib.sh
OUT=$ROOT/working-docs/screens/p3; mkdir -p $OUT/crops
# The band sits 5 rows above the bottom: crop the bottom rows of the frame.
keep() { cp $R/shots/$1.png $OUT/$1.png
  local w; read -r w _ < <(magick identify -format '%w %h' $OUT/$1.png)
  magick $OUT/$1.png -gravity SouthWest -crop ${w}x170+0+20 +repage $OUT/crops/$1.png; }
snap() { sleep 1; shot $1 "$2" >/dev/null; keep $1; echo $1; }

# Three proposals Claude "made" now in this session, in the fixture's project (what the jot tool
# will write in P5, which adds the turn id).
propose() { python3 -I - "$R/fixture-few/notes" "$SCREENS_CWD" "$SCREENS_SESSION" <<'EOF'
import sys, time, random
from datetime import datetime, timezone
d, cwd, session = sys.argv[1], sys.argv[2], sys.argv[3]
C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
for i, text in enumerate(['retry ignores Retry-After on 429', 'the arm runner image is 3 weeks old', 'merge.ts has no test for tombstones']):
    ms = int(time.time() * 1000) + i
    nid = ''.join(C[(ms >> (5 * k)) & 31] for k in range(9, -1, -1)) + ''.join(random.choice(C) for _ in range(16))
    at = datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{ms % 1000:03d}Z'
    open(f'{d}/{nid}.md', 'w').write(f'---\nid: {nid}\nstatus: proposed\nby: claude\ncreated: {at}\nupdated: {at}\norigin: office\nproject:\n  key: path:{cwd}\n  name: cc\n  path: {cwd}\ncontext:\n  sessionId: {session}\nsentAt: null\ndeleted: false\n---\n{text}\n')
EOF
}

dark() {
  export SCREENS_THEME=dark
  start empty 160 44; snap pocket0-160 "pocket · no notes"
  start few 160 44; snap pocket3-160 "pocket · 3 notes"
  lit 2; sleep 2; snap pocket-digit-160 "pocket · 2 typed and paused: note 2 in the prompt"
  start many 160 44; snap pocket9-160 "pocket · many notes (5 chips + more)"
  lit "/jot"; keys Enter; sleep 1.5; snap pocket-docked-160 "pocket · beside the docked pane"
  start many 100 40; snap pocket-100 "pocket · 100 columns"
  SCREENS_SESSION=$(python3 -c 'import uuid; print(uuid.uuid4())'); export SCREENS_SESSION
  start few 160 44
  lit "UI test: run the shell command sleep 6, then reply only with ok"; keys Enter; sleep 2; propose; sleep 14
  snap harvest-160 "harvest · 3 proposals from the last turn"
  SCREENS_SESSION=$(python3 -c "import uuid; print(uuid.uuid4())")
  start few 100 40; lit "UI test: run the shell command sleep 6, then reply only with ok"; keys Enter; sleep 2; propose; sleep 14
  snap harvest-100 "harvest · 100 columns"
  unset SCREENS_SESSION
}

light() {
  export SCREENS_THEME=light
  start many 160 44; snap pocket9-light-160 "light · pocket"
}

[ $# -eq 0 ] && set -- dark light
for part in "$@"; do $part; done
T kill-server
