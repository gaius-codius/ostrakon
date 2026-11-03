// `ostrakon doctor` (bin/doctor) reading the settings: which plugin entry, the hub as a pair, and
// where CLAUDE_CONFIG_DIR puts them. claude, curl and systemctl are stubs; curl writes down what it
// was asked for, so the tests see which hub doctor checked and with which token.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // An empty create (POST, -d) is logged with its method and data, and answered from
  // $GH_PROBES/<owner>_<repo> when that's there, else with GitHub's 422.
  curl: `url=\${!#} token='' sent='' prev=''
for arg in "$@"; do
  [ "$arg" = @- ] && token=$(cat)
  case $prev in -X|-d) sent+=" $arg" ;; esac
  prev=$arg
done
echo "$url \${token#Authorization: Bearer }$sent" >> "$CURL_LOG"
case $url in
  */healthz) printf 'ok 0' ;;
  */user/repos*) [ -z "\${GH_REPLY:-}" ] || cat "$GH_REPLY" ;;
  */repos/*/issues) probe=\${url%/issues} probe=\${probe#*/repos/} probe=\${probe%%/*}_\${probe#*/}
    if [ -f "\${GH_PROBES:-}/$probe" ]; then cat "$GH_PROBES/$probe"; else printf 'HTTP/2 422 Unprocessable Entity\r\n\r\n{}'; fi ;;
  *) printf 200 ;;
esac`,
  // The hub's user lingers, so doctor has no note about it to make.
  loginctl: 'echo yes',
  // There, so the hub section says nothing about it on a machine without one.
  qrencode: 'true',
  // With HUB_SHOW set, an ostrakon-hub (MainPID 4242) whose settings are in that file, running unless
  // HUB_ACTIVE=0. Its Environment is HUB_ENVIRONMENT when that's set.
  systemctl: `[ -n "\${HUB_SHOW:-}" ] || exit 1
case "$*" in
  '--user cat ostrakon-hub') ;;
  '--user is-active --quiet ostrakon-hub') [ "\${HUB_ACTIVE:-1}" = 1 ] ;;
  *'-p MainPID --value') echo 4242 ;;
  *'-p Environment --value'*) if [ -n "\${HUB_ENVIRONMENT:-}" ]; then echo "$HUB_ENVIRONMENT"; else cat "$HUB_SHOW"; fi ;;
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
      USER: 'tester',
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

// The hub on this machine, set up the way the sandbox and filing tests need: the unit's settings
// (systemctl's stub), the running hub's /proc, and the env file.
const SYSTEM = ['/run/dbus/system_bus_socket', '/run/docker.sock', '/run/podman']
const FAMILIES = 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX'
const mount = (at: string, root = '/', opts = 'rw', dev = '0:1') => `1 1 ${dev} ${root} ${at.replaceAll(' ', '\\040')} ${opts},relatime shared:1 - fs src rw`
const OWN = [mount('/'), mount('/tmp', '/', 'rw', '0:2')]

type Run = {
  unit?: 'sandbox' | 'none'
  applied?: boolean // whether the running hub has the limits
  active?: boolean
  data?: string // HUB_DATA in the env file, ~ for home
  show?: (home: string) => string[] // more settings, or ones that replace the sandbox's
  mounts?: (home: string) => string[] // more mounts in the hub
  setup?: (home: string) => void
  home?: (home: string) => string // HOME as doctor gets it
  proc?: boolean // whether the hub's /proc entry is there
  envFile?: string // the env file's contents, instead of HUB_TOKEN and HUB_DATA
  vars?: (home: string) => Record<string, string> // more variables for doctor
}
const run = ({
  unit = 'sandbox',
  applied = true,
  active = true,
  data = '',
  show = () => [],
  mounts = () => [],
  setup = () => {},
  home: homeAs,
  proc: hasProc = true,
  envFile,
  vars = () => ({}),
}: Run = {}) => {
  let home = ''
  let runtime = ''
  // Filled in once the folders exist; doctor reads it when it runs.
  const env: Record<string, string> = {}
  const result = doctor(undefined, 'home', env, at => {
    home = at.home
    runtime = join(at.root, 'run')
    for (const dir of [runtime, join(home, '.ssh'), join(home, '.config/gh')]) mkdirSync(dir, { recursive: true })
    setup(home)
    const hidden = [join(home, '.ssh'), join(home, '.gnupg'), join(home, '.config/gh'), join(home, '.claude'), runtime, ...SYSTEM]
    const settings =
      unit === 'sandbox'
        ? [
            'ProtectHome=read-only',
            'NoNewPrivileges=yes',
            'PrivateTmp=yes',
            FAMILIES,
            `ReadWritePaths=-${home}/.local/share/ostrakon-hub`,
            `InaccessiblePaths=${hidden.map(path => `-${path}`).join(' ')}`,
          ]
        : ['ProtectHome=no', 'ReadWritePaths=', 'InaccessiblePaths=', 'NoNewPrivileges=no', 'PrivateTmp=no', 'RestrictAddressFamilies=']
    const more = show(home)
    const keys = new Set(more.map(line => line.split('=')[0]))
    writeFileSync(join(at.root, 'show'), [...settings.filter(line => !keys.has(line.split('=')[0])), ...more].join('\n'))
    writeFileSync(join(at.root, 'env'), envFile ?? `HUB_TOKEN=secret\n${data ? `HUB_DATA=${data.replace('~', home)}\n` : ''}`)
    chmodSync(join(at.root, 'env'), 0o600)
    const proc = join(at.root, 'proc')
    mkdirSync(join(proc, 'self'), { recursive: true })
    writeFileSync(join(proc, 'self/mountinfo'), OWN.join('\n'))
    const sandboxed = [
      mount('/'),
      mount('/tmp', '/', 'rw', '0:2'),
      mount('/tmp', '/systemd-private-x/tmp', 'rw', '0:2'),
      mount(home, '/home', 'ro'),
      mount(join(home, '.local/share/ostrakon-hub'), '/home/.local/share/ostrakon-hub'),
      ...hidden.map(path => mount(path, '/systemd/inaccessible/dir', 'ro')),
      ...mounts(home),
    ]
    if (hasProc) {
      mkdirSync(join(proc, '4242'))
      writeFileSync(join(proc, '4242/mountinfo'), (applied ? sandboxed : OWN).join('\n'))
      writeFileSync(join(proc, '4242/status'), applied ? 'NoNewPrivs:\t1\nSeccomp:\t2\n' : 'NoNewPrivs:\t0\nSeccomp:\t0\n')
    }
    Object.assign(env, {
      HUB_SHOW: join(at.root, 'show'),
      HUB_ACTIVE: active ? '1' : '0',
      OSTRAKON_PROC: proc,
      OSTRAKON_HUB_ENV: join(at.root, 'env'),
      XDG_RUNTIME_DIR: runtime,
      ...(homeAs ? { HOME: homeAs(home) } : {}),
      ...vars(home),
    })
  })
  const filingAt = result.out.indexOf('== filing notes as issues')
  const toolsAt = result.out.indexOf('== tools')
  const section = result.out.slice(result.out.indexOf('== the hub on this machine'), filingAt >= 0 ? filingAt : toolsAt)
  const filing = filingAt >= 0 ? result.out.slice(filingAt, toolsAt) : ''
  return { section, filing, out: result.out, curled: result.curled, home, runtime }
}

// The hub's sandbox, as doctor reads it from a fake /proc: the running hub's mounts, status and
// environment next to doctor's own mounts, and the unit's settings from systemctl.
describe('ostrakon doctor on the hub sandbox', () => {
  test('says the hub runs in its sandbox when the running hub has every limit', () => {
    const { section } = run()
    expect(section).toContain('ok  the hub runs in its sandbox')
    expect(section).not.toContain('!!')
    expect(section).not.toContain('--')
  })

  test("names each limit the running hub doesn't have, skipping paths this machine doesn't have, and counts it as no problem", () => {
    const { section, runtime } = run({ applied: false })
    expect(section).toContain("--  the running hub doesn't have ProtectHome=read-only, InaccessiblePaths=~/.ssh, InaccessiblePaths=~/.config/gh, ")
    for (const limit of [`InaccessiblePaths=${runtime}`, 'NoNewPrivileges=yes', 'PrivateTmp=yes', `${FAMILIES}.`, "this machine can't apply them"])
      expect(section).toContain(limit)
    expect(section).not.toContain('.gnupg')
    expect(section).not.toContain('!!')
    expect(section).not.toContain('runs in its sandbox')
  })

  test('flags a unit without the sandbox, says which unit file and how to fix it', () => {
    const { section } = run({ unit: 'none', applied: false })
    expect(section).toContain("!!  the hub's unit (/units/ostrakon-hub.service) leaves out ProtectHome=read-only, InaccessiblePaths=~/.ssh,")
    expect(section).toContain("install.sh' --hub again")
    expect(section).not.toContain("the running hub doesn't have")
  })

  test('flags an address-family list wider than the three', () => {
    expect(run({ show: () => [`${FAMILIES} AF_NETLINK`] }).section).toContain(`leaves out ${FAMILIES} (SPEC`)
    expect(run({ show: () => ['RestrictAddressFamilies=AF_INET'] }).section).toContain('ok  the hub runs in its sandbox')
  })

  test("flags a HUB_DATA in the home folder that the unit doesn't open up, even when the hub can't start", () => {
    const stopped = run({ data: '~/notes-hub', active: false, applied: false })
    expect(stopped.section).toContain(`!!  the hub can't write its data folder ${stopped.home}/notes-hub`)
    expect(stopped.section).toContain("install.sh' --hub again")
    expect(run({ data: '~/notes-hub' }).section).toContain("!!  the hub can't write its data folder")
    // Opened up by a ReadWritePaths= (the drop-in's), the default, or outside home: nothing to say.
    const opened = run({ data: '~/notes hub/', show: home => [`ReadWritePaths=-${home}/.local/share/ostrakon-hub "-${home}/notes hub"`] })
    expect(opened.section).not.toContain("can't write")
    for (const data of ['~/.local/share/ostrakon-hub', '/srv/hub']) expect(run({ data }).section).not.toContain("can't write")
  })

  test('flags a HUB_DATA in /tmp or /var/tmp, which the hub gets a private copy of', () => {
    for (const data of ['/tmp/hub', '/var/tmp/hub']) expect(run({ data }).section).toContain(`!!  the hub's data folder ${data} is in /tmp or /var/tmp`)
  })

  // The settings the tests above stand in for, as the real unit has them.
  test('the unit has every limit doctor checks, each path with the - prefix', () => {
    const unit = readFileSync(join(import.meta.dir, 'ostrakon-hub.service'), 'utf8')
    const lines = unit.split('\n')
    for (const line of [
      'ProtectHome=read-only',
      'ReadOnlyPaths=-%h',
      'ReadWritePaths=-%h/.local/share/ostrakon-hub',
      'ExecStartPre=+-/bin/mkdir -p %h/.local/share/ostrakon-hub',
      'InaccessiblePaths=-%h/.ssh -%h/.gnupg -%h/.config/gh -%h/.claude',
      'InaccessiblePaths=-%t',
      'InaccessiblePaths=-/run/dbus/system_bus_socket -/run/docker.sock -/run/podman',
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      FAMILIES,
    ])
      expect(lines).toContain(line)
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=/m)
  })

  test('says what else in the home folder the hub can write, besides its data folder', () => {
    const { section } = run({
      data: '~/notes-hub',
      show: home => [`ReadWritePaths=-${home}/notes-hub -${home}/Documents`],
      mounts: home => [mount(join(home, 'notes-hub')), mount(join(home, 'notes-hub/backups')), mount(join(home, 'Documents'))],
    })
    expect(section).toContain('--  besides its data folder, the hub can write ~/Documents (ReadWritePaths= in its unit)')
    expect(section).not.toContain('notes-hub')
  })

  test('follows symlinks to where systemd hides them, and reads a HOME with a trailing slash as the same folder', () => {
    const linked = run({
      setup: home => {
        mkdirSync(join(home, 'dot/gnupg'), { recursive: true })
        symlinkSync(join(home, 'dot/gnupg'), join(home, '.gnupg'))
      },
      mounts: home => [mount(join(home, 'dot/gnupg'), '/systemd/inaccessible/dir', 'ro')],
    })
    expect(linked.section).toContain('ok  the hub runs in its sandbox')
    const slash = run({ home: home => `${home}/` })
    expect(slash.section).toContain('ok  the hub runs in its sandbox')
    expect(slash.section).not.toContain('!!')
  })

  test("says it couldn't check when the hub's /proc entry can't be read", () => {
    const { section } = run({ proc: false })
    expect(section).toContain("--  couldn't check the hub's sandbox")
    expect(section).not.toContain('runs in its sandbox')
  })
})

// Filing notes as issues (SPEC §9.2 Filing): doctor reads the hub's two tokens from its env file and
// asks GitHub (a stub) which repos the fine-grained one covers and when it ends.
describe('ostrakon doctor on filing notes as issues', () => {
  const GH = 'github_pat_SECRETVALUE123'
  const CLAUDE = 'sk-ant-oat01-SECRETVALUE456'
  // The date n days from today, in UTC, as YYYY-MM-DD.
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const repos = [
    { full_name: 'me/cc', has_issues: true, visibility: 'public' },
    { full_name: 'me/off', has_issues: false, visibility: 'public' },
    { full_name: 'me/x', has_issues: true, visibility: 'private' },
  ]
  // GitHub's answer to `curl -i`, in the stub's file; headers are name: value lines.
  const answer = ({ status = '200 OK', headers = [], body = repos }: { status?: string; headers?: string[]; body?: unknown } = {}) =>
    `HTTP/2 ${status}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}\r\n${JSON.stringify(body)}`
  const expiring = (n: number) => `github-authentication-token-expiration: ${day(n)} 00:00:00 UTC`

  const filing = ({
    env = `GH_TOKEN=${GH}\nCLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\nCLAUDE_TOKEN_EXPIRES=${day(200)}\n`,
    reply = answer({ headers: [expiring(200)] }),
    environment,
    tools = false,
    probes = {},
  }: {
    env?: string
    reply?: string
    probes?: Record<string, string> // GitHub's answer to an empty create in owner/repo, when not 422
    environment?: string // the unit's Environment, with <bin> for a folder holding claude and gh stubs
    tools?: boolean
  } = {}) => {
    const result = run({
      envFile: env,
      setup: home => {
        mkdirSync(join(home, 'bin'), { recursive: true })
        writeFileSync(join(home, 'reply'), reply)
        mkdirSync(join(home, 'probes'))
        for (const [repo, probe] of Object.entries(probes)) writeFileSync(join(home, 'probes', repo.replace('/', '_')), probe)
        for (const name of tools ? ['claude', 'gh'] : []) {
          writeFileSync(join(home, 'bin', name), '#!/bin/sh\n')
          chmodSync(join(home, 'bin', name), 0o755)
        }
      },
      vars: home => ({
        GH_REPLY: join(home, 'reply'),
        GH_PROBES: join(home, 'probes'),
        ...(environment ? { HUB_ENVIRONMENT: environment.replaceAll('<bin>', join(home, 'bin')) } : {}),
      }),
    })
    const repoCalls = result.curled.filter(line => line.includes('/user/repos'))
    const probeCalls = result.curled.filter(line => line.includes('/issues'))
    return { ...result, repoCalls, probeCalls }
  }

  test('says filing is off, and asks GitHub nothing, when the hub has neither token', () => {
    const { filing: text, repoCalls } = filing({ env: 'HUB_TOKEN=secret\n' })
    expect(text).toContain('--  filing notes as issues is off: the hub has no GH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN (docs/phone.md')
    expect(text).not.toContain('!!')
    expect(repoCalls).toEqual([])
  })

  test('flags a hub with only one of the two tokens', () => {
    const noClaude = filing({ env: `GH_TOKEN=${GH}\n` })
    expect(noClaude.filing).toContain('!!  filing is off:')
    expect(noClaude.filing).toContain('has GH_TOKEN but no CLAUDE_CODE_OAUTH_TOKEN')
    const noGh = filing({ env: `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\n` })
    expect(noGh.filing).toContain('has CLAUDE_CODE_OAUTH_TOKEN but no GH_TOKEN')
    expect(noGh.repoCalls).toEqual([])
  })

  test('refuses a classic token without asking GitHub, and never prints it', () => {
    const token = 'ghp_CLASSICSECRET'
    const { filing: text, repoCalls, out } = filing({ env: `GH_TOKEN=${token}\nCLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\n` })
    expect(text).toContain('!!  filing is off: GH_TOKEN is a classic token (ghp_…)')
    expect(text).toContain('github_pat_…')
    expect(repoCalls).toEqual([])
    expect(out).not.toContain(token)
  })

  test("says a token with another prefix isn't fine-grained, and how it starts", () => {
    const token = 'gho_OAUTHSECRET'
    const { filing: text, repoCalls, out } = filing({ env: `GH_TOKEN=${token}\nCLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\n` })
    expect(text).toContain("!!  filing is off: GH_TOKEN isn't a fine-grained token (github_pat_…); it starts gho_")
    expect(repoCalls).toEqual([])
    expect(out).not.toContain(token)
    expect(filing({ env: `GH_TOKEN=plain\nCLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\n` }).filing).toContain("isn't a fine-grained token (github_pat_…)\n")
  })

  test("with both tokens, says it's on, which repos the token covers (leaving out ones without issues) and when it ends", () => {
    const { filing: text, repoCalls, probeCalls, out } = filing()
    expect(text).toContain('ok  filing notes as issues is on (GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are set; the hub reads them when it starts)')
    expect(text).toContain('ok  GH_TOKEN covers 2 repos: me/cc (public), me/x (private)')
    expect(text).toContain(`ok  GH_TOKEN expires on ${day(200)}`)
    expect(text).toContain(`ok  CLAUDE_CODE_OAUTH_TOKEN expires on ${day(200)}`)
    expect(text).not.toContain('!!')
    expect(repoCalls).toEqual([`https://api.github.com/user/repos?per_page=100 ${GH}`])
    // Each repo with issues is probed with an empty create, which has no title.
    expect(probeCalls).toEqual([`https://api.github.com/repos/me/cc/issues ${GH} POST {}`, `https://api.github.com/repos/me/x/issues ${GH} POST {}`])
    expect(out).not.toContain(GH)
    expect(out).not.toContain(CLAUDE)
  })

  // GitHub lists every public repo a fine-grained token can read; the hub keeps only those an
  // empty create answers 422 for, and doctor lists the same.
  test("lists only the repos the token can file to, as the hub does, and says which it couldn't tell about", () => {
    const listed = [
      { full_name: 'me/cc', has_issues: true, visibility: 'public' },
      { full_name: 'me/other', has_issues: true, visibility: 'public' },
      { full_name: 'me/x', has_issues: true, visibility: 'private' },
      { full_name: 'me/down', has_issues: true, visibility: 'public' },
      { full_name: 'me/busy', has_issues: true, visibility: 'public' },
    ]
    const github = (status: string, message: string) => `HTTP/2 ${status}\r\n\r\n${JSON.stringify({ message })}`
    const { filing: text } = filing({
      reply: answer({ body: listed, headers: [expiring(200)] }),
      probes: {
        'me/other': github('403 Forbidden', 'Resource not accessible by personal access token'),
        'me/down': github('502 Bad Gateway', 'Server Error'),
        'me/busy': github('403 Forbidden', 'You have exceeded a secondary rate limit.'),
      },
    })
    expect(text).toContain('ok  GH_TOKEN covers 2 repos: me/cc (public), me/x (private)\n')
    expect(text).toContain(
      "--  couldn't tell whether GH_TOKEN can file to me/down (HTTP 502), me/busy (HTTP 403, rate limited), so the hub leaves them out for now",
    )
    expect(text).not.toContain('!!')
    const none = filing({ probes: { 'me/cc': github('403 Forbidden', 'Resource not accessible'), 'me/x': github('404 Not Found', 'Not Found') } })
    expect(none.filing).toContain("!!  GH_TOKEN covers no repos with issues, so there's nowhere to file")
  })

  test("flags a GH_TOKEN that expired or ends within a month, and says when there's no date", () => {
    expect(filing({ reply: answer({ headers: [expiring(10)] }) }).filing).toContain(`!!  GH_TOKEN expires in 10 days (${day(10)}): make a new one before then`)
    expect(filing({ reply: answer({ headers: [expiring(30)] }) }).filing).toContain('!!  GH_TOKEN expires in 30 days')
    expect(filing({ reply: answer({ headers: [expiring(31)] }) }).filing).toContain(`ok  GH_TOKEN expires on ${day(31)}`)
    expect(filing({ reply: answer({ headers: [expiring(-3)] }) }).filing).toContain(`!!  GH_TOKEN expired on ${day(-3)}: make a new one`)
    expect(filing({ reply: answer() }).filing).toContain('--  GH_TOKEN has no expiry date')
    const plus = `Github-Authentication-Token-Expiration: ${day(5)} 00:00:00 +0000`
    expect(filing({ reply: answer({ headers: [plus] }) }).filing).toContain('!!  GH_TOKEN expires in 5 days')
  })

  test('says when the token covers more than 100 repos, and when it covers none with issues', () => {
    const more = filing({
      reply: answer({ headers: ['link: <https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=3>; rel="last"'] }),
    })
    expect(more.filing).toContain('ok  GH_TOKEN covers more than 100 repos, the first: me/cc (public), me/x (private)')
    const none = filing({ reply: answer({ body: [repos[1]] }) })
    expect(none.filing).toContain("!!  GH_TOKEN covers no repos with issues, so there's nowhere to file")
  })

  test('flags a token GitHub refuses, and GitHub not answering', () => {
    expect(filing({ reply: answer({ status: '401 Unauthorized', body: { message: 'Bad credentials' } }) }).filing).toContain(
      '!!  GitHub refuses GH_TOKEN (expired or revoked): make a new one (docs/phone.md)',
    )
    expect(filing({ reply: answer({ status: '500 Oops' }) }).filing).toContain("!!  couldn't ask GitHub which repos GH_TOKEN covers (HTTP 500, or no answer)")
    expect(filing({ reply: '' }).filing).toContain('(HTTP none, or no answer)')
  })

  test("says when CLAUDE_CODE_OAUTH_TOKEN's expiry isn't known, is near, or isn't a date", () => {
    const base = `GH_TOKEN=${GH}\nCLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}\n`
    const missing = filing({ env: base })
    expect(missing.filing).toContain(
      "--  CLAUDE_CODE_OAUTH_TOKEN's expiry isn't known: claude setup-token makes a token good for a year; add CLAUDE_TOKEN_EXPIRES=<YYYY-MM-DD> to ",
    )
    expect(filing({ env: `${base}CLAUDE_TOKEN_EXPIRES=${day(5)}\n` }).filing).toContain(`!!  CLAUDE_CODE_OAUTH_TOKEN expires in 5 days (${day(5)})`)
    expect(filing({ env: `${base}CLAUDE_TOKEN_EXPIRES=${day(-1)}\n` }).filing).toContain(`!!  CLAUDE_CODE_OAUTH_TOKEN expired on ${day(-1)}`)
    expect(filing({ env: `${base}CLAUDE_TOKEN_EXPIRES=soon\n` }).filing).toContain('!!  CLAUDE_TOKEN_EXPIRES in ')
    expect(filing({ env: `${base}CLAUDE_TOKEN_EXPIRES=2030-02-31\n` }).filing).toContain("isn't a date (YYYY-MM-DD)")
    expect(filing({ env: `${base}CLAUDE_TOKEN_EXPIRES="2030-01-01"\n` }).filing).toContain('ok  CLAUDE_CODE_OAUTH_TOKEN expires on 2030-01-01')
  })

  test('reads quoted and spaced values, the last assignment winning', () => {
    const env = `GH_TOKEN=old\nGH_TOKEN = x\n  GH_TOKEN="${GH}"  \nCLAUDE_CODE_OAUTH_TOKEN='${CLAUDE}'\n`
    const { filing: text } = filing({ env })
    expect(text).toContain('ok  filing notes as issues is on')
  })

  test('flags a unit PATH with no claude or gh, and says when it finds both', () => {
    const without = filing({ environment: 'HUB_PORT=8790 PATH=<bin>' })
    expect(without.filing).toContain("!!  the hub's PATH (its unit's Environment=PATH) has no claude, so filing fails")
    expect(without.filing).toContain('has no gh, so filing fails')
    expect(without.filing).not.toContain('finds claude and gh')
    const both = filing({ environment: 'HUB_PORT=8790 PATH=<bin>', tools: true })
    expect(both.filing).toContain("ok  the hub's PATH finds claude and gh")
    expect(both.filing).not.toContain('!!')
    expect(filing().filing).not.toContain("the hub's PATH")
  })
})

// bin/hub-data-unit: the drop-in that opens up a HUB_DATA of your own in the hub's sandbox.
describe('hub-data-unit', () => {
  const SCRIPT = join(import.meta.dir, '../bin/hub-data-unit')
  const unit = (env: string | undefined, before = (_home: string) => {}) => {
    const home = temp()
    const file = join(home, '.config/ostrakon-hub/env')
    mkdirSync(join(home, '.config/ostrakon-hub'), { recursive: true })
    if (env !== undefined) writeFileSync(file, env.replaceAll('~', home))
    before(home)
    const run = Bun.spawnSync(['bash', SCRIPT], { env: { HOME: home, PATH: process.env.PATH ?? '' } })
    const dropin = join(home, '.config/systemd/user/ostrakon-hub.service.d/hub-data.conf')
    return {
      home,
      dropin,
      code: run.exitCode,
      out: run.stdout.toString() + run.stderr.toString(),
      conf: existsSync(dropin) ? readFileSync(dropin, 'utf8') : null,
    }
  }

  test('writes a drop-in that makes HUB_DATA and opens it up, quoted, with % escaped', () => {
    const { home, conf, code } = unit('HUB_TOKEN=t\nHUB_DATA="~/hub data/100%"\n')
    expect(code).toBe(0)
    expect(conf).toContain(`ExecStartPre=+-/bin/mkdir -p "${home}/hub data/100%%"\n`)
    expect(conf).toContain(`ReadWritePaths="-${home}/hub data/100%%"\n`)
  })

  test('writes nothing for the default or no HUB_DATA, and removes its drop-in when HUB_DATA goes back to the default', () => {
    expect(unit('HUB_TOKEN=t\n').conf).toBeNull()
    expect(unit(undefined).conf).toBeNull()
    const back = unit('HUB_DATA=~/.local/share/ostrakon-hub/\n', home => {
      mkdirSync(join(home, '.config/systemd/user/ostrakon-hub.service.d'), { recursive: true })
      writeFileSync(join(home, '.config/systemd/user/ostrakon-hub.service.d/hub-data.conf'), 'old')
    })
    expect(back.conf).toBeNull()
  })

  test('refuses a relative HUB_DATA or one with a quote, without failing', () => {
    for (const data of ['notes', '/srv/a"b']) {
      const { conf, code, out } = unit(`HUB_DATA=${data}\n`)
      expect(code).toBe(0)
      expect(conf).toBeNull()
      expect(out).toContain("the hub's sandbox can't open it up")
    }
  })
})
