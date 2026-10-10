#!/usr/bin/env python3
"""Generate a v2 ostrakon notes directory for screenshots.

Usage: fixture.py <empty|few|long|many> <out_dir> [--now ISO8601] [--cwd PATH]

Writes <out_dir>/notes/<ULID>.md (SPEC 6.2 format) plus <out_dir>/.fixture.
Refuses to write into a non-empty dir unless it holds the .fixture marker
(then notes/ is regenerated). Never touches ~/.claude-mods or
~/.local/share/ostrakon. Ages are offsets from --now (default: current time,
or $FIXTURE_NOW); ULID random parts are seeded, so output is reproducible
for a given --now. --cwd is the project the screenshot session runs in.
"""
import argparse, os, random, shutil, sys, time
from datetime import datetime, timezone

CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
H = 3600_000
ORIGIN = 'office'

def ulid(ms, rng):
    t = ''.join(CROCKFORD[(ms >> (5 * i)) & 31] for i in range(9, -1, -1))
    return t + ''.join(rng.choice(CROCKFORD) for _ in range(16))

def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{ms % 1000:03d}Z'

def yq(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'

def build(cwd):
    P = {
        'cc': ('path:' + cwd, 'cc', cwd),
        'infra': ('github.com/example/infra', 'infra', '/home/user/code/infra'),
        'nota': ('github.com/example/nota', 'nota', '/home/user/code/nota'),
        'none': None,
    }
    def n(text, p='cc', by='you', ago=1, status='open', sent_ago=None, branch=None, session=None):
        return dict(text=text, p=P[p], by=by, ago=ago, status=status, sent_ago=sent_ago, branch=branch, session=session)
    few = [
        n('check why the cache test is flaky on CI', ago=0.2, branch='main', session='0463fee3-6b1d-4c1e-9a52-3f0e8d7a1b20'),
        n('rename register.tsx helpers once the API settles', ago=3, branch='main'),
        n('Login handler swallows the 401 from refresh, worth a look after this task', by='claude', ago=26, branch='main'),
        n('rotate the staging api keys before friday', 'infra', ago=50),
        n('reply to the PR review about the retry backoff', 'nota', ago=5, branch='retry-backoff'),
        n('buy a usb-c cable for the office', 'none', ago=7),
    ]
    long = few + [
        n('investigate whether the hot reload drops the clock.every timer when the module reloads mid-tick, and if so whether the sync loop needs to re-arm itself on session.start or on the first render after a reload; also check what happens on /clear', ago=1, branch='main'),
        n('call the dentist', 'none', by='phone', ago=30),
    ]
    many = long + [
        n('bump node to 26 in CI', ago=8), n('write a test for the band toggle', by='claude', ago=9, status='proposed'),
        n('dark/light contrast check on the pane', ago=12), n('ask about desktop surface support', ago=30),
        n('the status line warning prefix looks like a warning', by='claude', ago=2, status='proposed'),
        n('try fzf-style capture', ago=70, status='sent', sent_ago=60),
        n('migrate infra secrets to sops', 'infra', ago=100), n('nota: flaky e2e on login', 'nota', by='claude', ago=4),
        n('clean up ~/.claude-mods dev copies', ago=200, status='archived'),
        n('read the mods overview docs again', ago=400, status='archived'),
        n('benchmark fs.read latency', ago=15), n('think about tags / priorities', ago=18),
        n('export notes to markdown', ago=22, status='sent', sent_ago=20),
        n('undo for d/send', by='claude', ago=1.5, status='archived'),
        n('look into a standing desk', 'none', ago=90), n('renew the domain before the 20th', 'none', by='phone', ago=48),
        n('pin the terraform provider versions', 'infra', ago=36), n('document the deploy rollback steps', 'infra', ago=60),
        n('add retry jitter to the webhook sender', 'nota', ago=20), n('paginate the notes list endpoint', 'nota', ago=44),
        n('draft the changelog for the pane release', ago=16), n('check the 100-column layout again', ago=6),
    ]
    return {'empty': [], 'few': few, 'long': long, 'many': many}

def render(nt, now, rng):
    created = now - int(nt['ago'] * H)
    updated = created
    sent = 'null'
    if nt['status'] == 'sent':
        updated = now - int(nt['sent_ago'] * H); sent = iso(updated)
    elif nt['status'] == 'archived':
        updated = created + H // 2
    nid = ulid(created, rng)
    L = ['---', f'id: {nid}', f"status: {nt['status']}", f"by: {nt['by']}",
         f'created: {iso(created)}', f'updated: {iso(updated)}', f'origin: {ORIGIN}']
    if nt['p'] is None:
        L.append('project: null')
    else:
        k, name, path = nt['p']
        L += ['project:', f'  key: {k}', f'  name: {name}', f'  path: {path}']
    if nt['session'] or nt['branch']:
        L.append('context:')
        if nt['session']: L.append(f"  sessionId: {nt['session']}")
        if nt['branch']: L.append(f"  branch: {nt['branch']}")
    L += [f'sentAt: {sent}', 'deleted: false', '---', nt['text'], '']
    return nid, '\n'.join(L)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name', choices=['empty', 'few', 'long', 'many'])
    ap.add_argument('out')
    ap.add_argument('--now', default=os.environ.get('FIXTURE_NOW'))
    ap.add_argument('--cwd', default='/tmp/ostrakon-screens/project')
    a = ap.parse_args()
    out = os.path.realpath(a.out)
    home = os.path.expanduser('~')
    for bad in (f'{home}/.claude-mods', f'{home}/.local/share/ostrakon'):
        if out == bad or out.startswith(bad + os.sep):
            sys.exit(f'refusing to write under {bad}')
    marker = os.path.join(out, '.fixture')
    if os.path.exists(out):
        if not os.path.isdir(out):
            sys.exit(f'{out} is not a directory')
        if os.listdir(out) and not os.path.exists(marker):
            sys.exit(f'refusing: {out} is non-empty and has no .fixture marker')
    now = int(datetime.fromisoformat(a.now.replace('Z', '+00:00')).timestamp() * 1000) if a.now else int(time.time() * 1000)
    shutil.rmtree(os.path.join(out, 'notes'), ignore_errors=True)
    os.makedirs(os.path.join(out, 'notes'))
    open(marker, 'w').write('created by tools/screens/fixture.py\n')
    rng = random.Random(42)
    for nt in build(a.cwd)[a.name]:
        nid, txt = render(nt, now, rng)
        with open(os.path.join(out, 'notes', nid + '.md'), 'w') as f:
            f.write(txt)
    print(f'{a.name}: {len(os.listdir(os.path.join(out, "notes")))} notes in {out}/notes')

main()
