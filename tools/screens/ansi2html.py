import html, re, sys
PAL = ['#1d2021','#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#abb2bf',
       '#5c6370','#ff7b86','#b5e890','#ffd68a','#82c0ff','#de9cf0','#7fd4df','#ffffff']
def c256(n):
    if n < 16: return PAL[n]
    if n < 232:
        n -= 16; r, g, b = n // 36, (n // 6) % 6, n % 6
        f = lambda v: 0 if v == 0 else 55 + v * 40
        return '#%02x%02x%02x' % (f(r), f(g), f(b))
    v = 8 + (n - 232) * 10; return '#%02x%02x%02x' % (v, v, v)
FG, BG = '#d8dee9', '#0f1115'
def render(text, title):
    st = dict(fg=None, bg=None, b=False, d=False, i=False, u=False, inv=False)
    out = []
    for part in re.split(r'(\x1b\[[0-9;]*m)', text):
        m = re.fullmatch(r'\x1b\[([0-9;]*)m', part)
        if m:
            codes = [int(x) if x else 0 for x in m.group(1).split(';')] or [0]
            k = 0
            while k < len(codes):
                c = codes[k]
                if c == 0: st = dict(fg=None, bg=None, b=False, d=False, i=False, u=False, inv=False)
                elif c == 1: st['b'] = True
                elif c == 2: st['d'] = True
                elif c == 3: st['i'] = True
                elif c == 4: st['u'] = True
                elif c == 7: st['inv'] = True
                elif c == 22: st['b'] = st['d'] = False
                elif c == 23: st['i'] = False
                elif c == 24: st['u'] = False
                elif c == 27: st['inv'] = False
                elif 30 <= c <= 37: st['fg'] = PAL[c - 30]
                elif 90 <= c <= 97: st['fg'] = PAL[c - 82]
                elif 40 <= c <= 47: st['bg'] = PAL[c - 40]
                elif 100 <= c <= 107: st['bg'] = PAL[c - 92]
                elif c == 39: st['fg'] = None
                elif c == 49: st['bg'] = None
                elif c in (38, 48) and k + 1 < len(codes):
                    key = 'fg' if c == 38 else 'bg'
                    if codes[k + 1] == 5: st[key] = c256(codes[k + 2]); k += 2
                    elif codes[k + 1] == 2: st[key] = '#%02x%02x%02x' % tuple(codes[k + 2:k + 5]); k += 4
                k += 1
            continue
        if not part: continue
        fg, bg = st['fg'] or FG, st['bg']
        if st['inv']: fg, bg = (bg or BG), (st['fg'] or FG)
        css = f'color:{fg};' + (f'background:{bg};' if bg else '')
        if st['b']: css += 'font-weight:700;'
        if st['d']: css += 'opacity:.55;'
        if st['i']: css += 'font-style:italic;'
        if st['u']: css += 'text-decoration:underline;'
        out.append(f'<span style="{css}">{html.escape(part)}</span>')
    body = ''.join(out)
    return f'''<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:{BG};}} .t{{font:14px/1.25 "JetBrainsMono Nerd Font","JetBrains Mono","DejaVu Sans Mono",monospace;
white-space:pre;color:{FG};padding:14px 16px;}} .cap{{font:600 13px system-ui;color:#8b93a7;padding:10px 16px 0;}}</style>
<div class="cap">{html.escape(title)}</div><div class="t">{body}</div>'''
src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
open(dst, 'w').write(render(open(src, encoding='utf-8', errors='replace').read(), title))
