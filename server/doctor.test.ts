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
  curl: `url=\${!#} token=''
for arg in "$@"; do [ "$arg" = @- ] && token=$(cat); done
echo "$url \${token#Authorization: Bearer }" >> "$CURL_LOG"
case $url in */healthz) printf 'ok 0' ;; *) printf 200 ;; esac`,
  // With HUB_SHOW set, an ostrakon-hub (MainPID 4242) whose settings are in that file, running unless
  // HUB_ACTIVE=0.
  systemctl: `[ -n "\${HUB_SHOW:-}" ] || exit 1
case "$*" in
  '--user cat ostrakon-hub') ;;
  '--user is-active --quiet ostrakon-hub') [ "\${HUB_ACTIVE:-1}" = 1 ] ;;
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
      writeFileSync(join(at.root, 'env'), `HUB_TOKEN=secret\n${data ? `HUB_DATA=${data.replace('~', home)}\n` : ''}`)
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
      })
    })
    const section = result.out.slice(result.out.indexOf('== the hub on this machine'), result.out.indexOf('== tools'))
    return { section, home, runtime }
  }

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
