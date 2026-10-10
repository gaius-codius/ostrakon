#!/usr/bin/env bash
# P5 screenshots: harvest after a real turn (this runs the model: one short fix in a throwaway
# sample project, then harvest's review of it). Output: working-docs/screens/p5/<name>.png and crops/.
# The sample lives in $R/p5-sample; the first run trusts that folder (Claude Code asks once).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
export SCREENS_OPTIONS='"harvest":true'
source $HERE/lib.sh
OUT=$ROOT/working-docs/screens/p5; mkdir -p $OUT/crops
keep() { cp $R/shots/$1.png $OUT/$1.png
  local w h; read w h < <(magick identify -format '%w %h' $OUT/$1.png)
  magick $OUT/$1.png -gravity SouthWest -crop ${w}x170+0+20 +repage $OUT/crops/$1.png; }
snap() { sleep 1; shot $1 "$2" >/dev/null; keep $1; echo $1; }
busy() { T capture-pane -p -t rv | grep -qE '… \([0-9]+[ms]'; }
idle() { sleep 8; for i in $(seq 1 90); do sleep 4; busy || { sleep 4; busy || return 0; }; done; }

# A tiny cart: one test to fix, and side issues around it (a case-sensitive discount code, a TODO).
sample() {
  local s=$R/p5-sample; rm -rf $s; mkdir -p $s/shop; touch $s/shop/__init__.py
  cat > $s/shop/pricing.py <<'EOF'
TAX_RATE = 0.1  # TODO: varies by region


def line_total(price, qty):
    return price * qty


def apply_discount(total, code):
    # Codes are case-sensitive for now.
    if code == "SAVE10":
        return total * 0.9
    return total


def with_tax(total):
    return round(total * (1 + TAX_RATE), 2)
EOF
  cat > $s/shop/cart.py <<'EOF'
from shop.pricing import apply_discount, line_total, with_tax


class Cart:
    def __init__(self):
        self.items = []
        self.code = None

    def add(self, name, price, qty=1):
        self.items.append((name, price, qty))

    def total(self):
        total = sum(line_total(price, qty) for _, price, qty in self.items)
        if self.code:
            total = apply_discount(total, self.code)
        return with_tax(total)

    def count(self):
        return len(self.items)
EOF
  cat > $s/test_cart.py <<'EOF'
from shop.cart import Cart


def test_discount():
    cart = Cart()
    cart.add("book", 20.0)
    cart.code = "save10"
    assert cart.total() == 19.8


def test_count_counts_quantities():
    cart = Cart()
    cart.add("pen", 2.0, qty=3)
    cart.add("book", 20.0)
    assert cart.count() == 4


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok  ", name)
            except AssertionError:
                print("FAIL", name)
EOF
  (cd $s && git init -q && git add -A && git -c user.name=fixture -c user.email=fixture@example.com commit -qm init)
  export SCREENS_CWD=$s
}

# Claude Code asks once whether to trust a new folder: yes (the sample is ours).
trusted() { T capture-pane -p -t rv | grep -q "trust this folder" || return 0
  T send-keys -t rv Down; sleep 0.5; T send-keys -t rv Enter
  for i in $(seq 1 30); do T capture-pane -p -t rv | grep -q "shift+tab" && break; sleep 1; done; sleep 2; }

run() { # cols rows
  start few $1 $2 >/dev/null; trusted
  lit "Make test_count_counts_quantities in test_cart.py pass. Keep the change minimal."; keys Enter; idle
  for i in $(seq 1 20); do T capture-pane -p -t rv | grep -q "from this turn" && return 0; sleep 2; done
  echo "no harvest after the turn (the review found nothing?)"; return 1
}

sample
export SCREENS_THEME=dark
run 160 45 && {
  snap harvest-160 "harvest · the review's proposals after a turn"
  lit 1; sleep 1.5; snap harvest-kept-160 "harvest · 1 keeps the first; the rest wait"
  keys C-x s; sleep 2; keys C-l; sleep 1.5; snap harvest-list-160 "harvest · the rest wait in the list view under proposed"
}
(cd $SCREENS_CWD && git checkout -q .)
run 100 40 && snap harvest-100 "harvest · 100 columns"
(cd $SCREENS_CWD && git checkout -q .)
export SCREENS_THEME=light
run 160 45 && snap harvest-light-160 "harvest · light"
T kill-server
