// `ostrakon doctor` (bin/doctor) reading the settings: which plugin entry, the hub as a pair, and
// where CLAUDE_CONFIG_DIR puts them. claude, curl and systemctl are stubs; curl writes down what it
// was asked for, so the tests see which hub doctor checked and with which token.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DOCTOR = join(import.meta.dir, '../bin/doctor')
const MOD = join(import.meta.dir, '../plugin')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'))
  dirs.push(dir)
  return dir
}

const STUBS = {
  claude: `case $1 in --version) echo '2.1.0 (Claude Code)' ;; esac`,
  // The URL is the last argument; a token comes in on stdin as a header (-H @-).
  curl: `url=\${!#} token=''
for arg in "$@"; do [ "$arg" = @- ] && token=$(cat); done
echo "$url \${token#Authorization: Bearer }" >> "$CURL_LOG"
case $url in */healthz) printf 'ok 0' ;; *) printf 200 ;; esac`,
  // With HUB_SHOW set, a running ostrakon-hub (MainPID 4242) whose settings are in that file.
  systemctl: `[ -n "\${HUB_SHOW:-}" ] || exit 1
case "$*" in
  '--user cat ostrakon-hub' | '--user is-active --quiet ostrakon-hub') ;;
  *'-p MainPID --value') echo 4242 ;;
  *'-p FragmentPath --value') echo /units/ostrakon-hub.service ;;
  *' show '*) cat "$HUB_SHOW" ;;
  *) exit 1 ;;
esac`,
}

type Where = 'home' | 'config' | 'cwd'

// Runs doctor with the settings in ~/.claude, in CLAUDE_CONFIG_DIR, or (CLAUDE_CONFIG_DIR set but
// empty) in the working directory; env adds to a clean environment.
const doctor = (
  settings: unknown,
  where: Where = 'home',
  env: Record<string, string> = {},
  before = (_at: { home: string; config: string; root: string }) => {},
) => {
  const root = temp()
  const home = join(root, 'home')
  const config = join(root, 'config')
  const cwd = join(root, 'cwd')
  const stubs = join(root, 'stubs')
  for (const dir of [home, join(home, '.claude'), config, cwd, stubs]) mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  const at = { home: join(home, '.claude'), config, cwd }[where]
  // undefined: no settings file at all.
  if (settings !== undefined) writeFileSync(join(at, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
  before({ home, config, root })
  const log = join(root, 'curl.log')
  writeFileSync(log, '')
  const run = Bun.spawnSync(['bash', DOCTOR], {
    cwd,
    env: {
      HOME: home,
      PATH: `${stubs}:${process.env.PATH ?? ''}`,
      OSTRAKON_CACHE: join(root, 'cache'),
      CURL_LOG: log,
      ...(where === 'config' ? { CLAUDE_CONFIG_DIR: config } : where === 'cwd' ? { CLAUDE_CONFIG_DIR: '' } : {}),
      ...env,
    },
  })
  const curled = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { out: run.stdout.toString(), curled, home, config, cwd }
}

// Installed from the marketplace, with an `ostrakon` entry left over from install.sh.
const leftover = (extra: object = {}) => ({
  enabledPlugins: { 'ostrakon@ostrakon': true },
  pluginConfigs: {
    ostrakon: { options: { hubUrl: 'https://old', hubToken: 'old-token', notesDir: '/old/notes-root' } },
    'ostrakon@ostrakon': { options: { hubUrl: 'https://current', hubToken: 'live-token', notesDir: '/current/notes-root' } },
  },
  ...extra,
})

describe('ostrakon doctor', () => {
  test('installed from the marketplace and loaded from no folder, checks only what ostrakon@ostrakon says', () => {
    const { out, curled } = doctor(leftover())
    expect(curled).toEqual(['https://current/healthz ', 'https://current/api/projects live-token'])
    expect(out).toContain('notes folder /current/notes-root/notes')
    expect(out).toContain('ok  the mod is installed from the marketplace')
  })

  test('loaded from a folder, checks ostrakon then ostrakon@inline, and says when the mod is also installed', () => {
    const both = doctor(leftover({ env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } }))
    expect(both.curled).toEqual(['https://old/healthz ', 'https://old/api/projects old-token'])
    expect(both.out).toContain('notes folder /old/notes-root/notes')
    expect(both.out).toContain(
      "!!  the mod is both installed from the marketplace and loaded from a folder (CLAUDE_CODE_PLUGIN_DIRS); sessions use the folder's copy, so its settings come from pluginConfigs ostrakon then ostrakon@inline, not ostrakon@ostrakon",
    )

    const inline = doctor(
      {
        pluginConfigs: {
          'ostrakon@inline': { options: { hubUrl: 'https://inline', hubToken: 't' } },
          'ostrakon@ostrakon': { options: { hubUrl: 'https://market', hubToken: 'u' } },
        },
      },
      'home',
      { CLAUDE_CODE_PLUGIN_DIRS: MOD },
    )
    expect(inline.curled).toEqual(['https://inline/healthz ', 'https://inline/api/projects t'])
    expect(inline.out).not.toContain('both installed')
  })

  test('reads a ~ in the plugin folders as home, and a relative folder as none', () => {
    // A relative folder, run from where it would name the mod: still none.
    const relative = doctor(leftover({ env: { CLAUDE_CODE_PLUGIN_DIRS: `../../../..${MOD}` } }))
    expect(relative.curled[0]).toBe('https://current/healthz ')
    const tilde = doctor(leftover({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/mod' } }), 'home', {}, ({ home }) =>
      cpSync(join(MOD, '.claude-plugin'), join(home, 'mod', '.claude-plugin'), { recursive: true }),
    )
    expect(tilde.curled[0]).toBe('https://old/healthz ')
  })

  test('with no settings file, takes the plugin folders from the shell', () => {
    const { out } = doctor(undefined, 'home', { CLAUDE_CODE_PLUGIN_DIRS: MOD })
    expect(out).not.toContain("the mod isn't loaded")
    expect(out).toContain('ok  the mod loads in every session (CLAUDE_CODE_PLUGIN_DIRS)')
  })

  test("the settings' plugin folders go over the shell's, an empty list included", () => {
    const { out, curled } = doctor(leftover({ env: { CLAUDE_CODE_PLUGIN_DIRS: '' } }), 'home', { CLAUDE_CODE_PLUGIN_DIRS: MOD })
    expect(curled[0]).toBe('https://current/healthz ')
    expect(out).not.toContain('both installed')
  })

  test("takes the hub's URL and token from one entry, and flags a URL with no token", () => {
    const pair = doctor({
      pluginConfigs: { ostrakon: { options: { hubUrl: 'https://url-only' } }, 'ostrakon@inline': { options: { hubUrl: 'https://paired', hubToken: 'p' } } },
    })
    expect(pair.curled).toEqual(['https://paired/healthz ', 'https://paired/api/projects p'])

    const alone = doctor({ pluginConfigs: { ostrakon: { options: { hubUrl: 'https://url-only' } }, 'ostrakon@ostrakon': { options: { hubToken: 'x' } } } })
    expect(alone.curled).toEqual(['https://url-only/healthz '])
    expect(alone.out).toContain('!!  no hubToken set')
  })

  test('reads the settings from CLAUDE_CONFIG_DIR when set, and from the working directory when it is set but empty', () => {
    const hub = (url: string) => ({ pluginConfigs: { ostrakon: { options: { hubUrl: url, hubToken: 't' } } } })
    expect(doctor(hub('https://home')).curled[0]).toBe('https://home/healthz ')
    expect(doctor(hub('https://config'), 'config').curled[0]).toBe('https://config/healthz ')
    const empty = doctor(hub('https://cwd'), 'cwd')
    expect(empty.curled[0]).toBe('https://cwd/healthz ')
  })

  test("says the settings aren't valid when they aren't JSON, or are JSON but not an object", () => {
    const notJson = doctor('{', 'config')
    expect(notJson.out).toContain(`!!  ${join(notJson.config, 'settings.json')} isn't valid JSON`)
    const folder = doctor(undefined, 'config', {}, ({ config }) => mkdirSync(join(config, 'settings.json')))
    expect(folder.out).toContain(`!!  ${join(folder.config, 'settings.json')} can't be read`)
    for (const body of ['[1]', 'null']) {
      const { out, config, curled } = doctor(body, 'config')
      expect(out).toContain(`!!  ${join(config, 'settings.json')} isn't a JSON object, so Claude Code can't read it`)
      expect(out).not.toContain('no hubUrl set')
      expect(curled).toEqual([])
    }
  })
})

// The hub's sandbox, as doctor reads it from a fake /proc: the running hub's mounts, status and
// environment next to doctor's own mounts, and the unit's settings from systemctl.
describe('ostrakon doctor on the hub sandbox', () => {
  const SANDBOX = ['ProtectHome=read-only', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX']
  const NONE = ['ProtectHome=no', 'InaccessiblePaths=', 'NoNewPrivileges=no', 'PrivateTmp=no', 'RestrictAddressFamilies=~']
  const mount = (at: string, root = '/', opts = 'rw', dev = '0:1') => `1 1 ${dev} ${root} ${at.replaceAll(' ', '\\040')} ${opts},relatime shared:1 - fs src rw`
  const OWN = [mount('/'), mount('/tmp', '/', 'rw', '0:2')]

  // applied: whether the running hub has the limits; data: the HUB_DATA it runs with, if any.
  const run = ({ unit = 'sandbox', applied = true, data = '' }: { unit?: 'sandbox' | 'none'; applied?: boolean; data?: string } = {}) => {
    let home = ''
    let runtime = ''
    // Filled in once the folders exist; doctor reads it when it runs.
    const env: Record<string, string> = {}
    const result = doctor(undefined, 'home', env, at => {
      home = at.home
      runtime = join(at.root, 'run')
      for (const dir of [runtime, join(home, '.ssh'), join(home, '.config/gh')]) mkdirSync(dir, { recursive: true })
      const hidden = [join(home, '.ssh'), join(home, '.gnupg'), join(home, '.config/gh'), join(home, '.claude'), runtime]
      const show = join(at.root, 'show')
      writeFileSync(show, (unit === 'sandbox' ? [...SANDBOX, `InaccessiblePaths=${hidden.map(path => `-${path}`).join(' ')}`] : NONE).join('\n'))
      const proc = join(at.root, 'proc')
      mkdirSync(join(proc, 'self'), { recursive: true })
      mkdirSync(join(proc, '4242'))
      writeFileSync(join(proc, 'self/mountinfo'), OWN.join('\n'))
      const sandboxed = [
        mount('/'),
        mount('/tmp', '/', 'rw', '0:2'),
        mount('/tmp', '/systemd-private-x/tmp', 'rw', '0:2'),
        mount(home, '/home', 'ro'),
        mount(join(home, '.local/share/ostrakon-hub'), '/home/.local/share/ostrakon-hub'),
        ...hidden.map(path => mount(path, '/systemd/inaccessible/dir', 'ro')),
      ]
      writeFileSync(join(proc, '4242/mountinfo'), (applied ? sandboxed : OWN).join('\n'))
      writeFileSync(join(proc, '4242/status'), applied ? 'NoNewPrivs:\t1\nSeccomp:\t2\n' : 'NoNewPrivs:\t0\nSeccomp:\t0\n')
      writeFileSync(join(proc, '4242/environ'), ['HUB_TOKEN=secret', ...(data ? [`HUB_DATA=${data.replace('~', home)}`] : [])].join('\0'))
      Object.assign(env, { HUB_SHOW: show, OSTRAKON_PROC: proc, XDG_RUNTIME_DIR: runtime })
    })
    const section = result.out.slice(result.out.indexOf('== the hub on this machine'), result.out.indexOf('== tools'))
    return { section, home, runtime }
  }

  test('says the hub runs in its sandbox when the running hub has every limit', () => {
    const { section } = run()
    expect(section).toContain('ok  the hub runs in its sandbox')
    expect(section).not.toContain('!!')
    expect(section).not.toContain('secret')
  })

  test("names each limit the running hub doesn't have, skipping paths this machine doesn't have, and counts it as no problem", () => {
    const { section, runtime } = run({ applied: false })
    expect(section).toContain(
      `--  the running hub doesn't have ProtectHome=read-only, InaccessiblePaths=~/.ssh, InaccessiblePaths=~/.config/gh, InaccessiblePaths=~/.claude, InaccessiblePaths=${runtime}, NoNewPrivileges=yes, PrivateTmp=yes, RestrictAddressFamilies. If systemctl --user restart ostrakon-hub doesn't add them, this machine can't apply them`,
    )
    expect(section).not.toContain('.gnupg')
    expect(section).not.toContain('!!')
    expect(section).not.toContain('runs in its sandbox')
  })

  test('flags a unit without the sandbox, and says which unit file', () => {
    const { section } = run({ unit: 'none', applied: false })
    expect(section).toContain("!!  the hub's unit (/units/ostrakon-hub.service) leaves out ProtectHome=read-only, InaccessiblePaths=~/.ssh,")
    expect(section).toContain('ln -sf ')
    expect(section).not.toContain("the running hub doesn't have")
  })

  test('flags a HUB_DATA in the home folder that the sandbox leaves read-only', () => {
    expect(run({ data: '~/notes-hub' }).section).toContain("!!  the hub can't write its data folder")
    expect(run({ data: '~/.local/share/ostrakon-hub' }).section).not.toContain("can't write")
    expect(run({ data: '~/notes-hub', applied: false }).section).not.toContain("can't write")
  })
})
