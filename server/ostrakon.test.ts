// `ostrakon hub` (bin/ostrakon): what reaches the hub from the env file and from your shell. A
// stub `bun` prints the environment it was started with instead of running the hub.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const hub = (envFile: string, shell: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'ostrakon-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'bun'), '#!/usr/bin/env bash\nenv | grep -E "^(HUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=" | sort\n')
  chmodSync(join(dir, 'bun'), 0o755)
  writeFileSync(join(dir, 'env'), envFile)
  const run = Bun.spawnSync(['bash', join(import.meta.dir, '../bin/ostrakon'), 'hub'], {
    env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, OSTRAKON_HUB_ENV: join(dir, 'env'), ...shell },
  })
  return run.stdout.toString().trim().split('\n').filter(Boolean)
}

test("takes the filing tokens from the env file only, never your shell's", () => {
  const shell = { GH_TOKEN: 'github_pat_yours', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-yours' }
  expect(hub('HUB_TOKEN=t\n', shell)).toEqual(['HUB_TOKEN=t'])
  expect(hub("HUB_TOKEN=t\nGH_TOKEN='github_pat_hub'\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-hub\n", shell)).toEqual([
    'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-hub',
    'GH_TOKEN=github_pat_hub',
    'HUB_TOKEN=t',
  ])
  // HUB_* settings from the shell still go over the file's.
  expect(hub('HUB_TOKEN=t\n', { HUB_TOKEN: 'mine' })).toEqual(['HUB_TOKEN=mine'])
})

test('reads the env file as systemd and doctor do: the last line for a key wins, spaces and quotes dropped', () => {
  const file = 'HUB_TOKEN=t\nGH_TOKEN=ghp_old\nGH_TOKEN=github_pat_new\nCLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-hub"  \n'
  expect(hub(file, {})).toEqual(['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-hub', 'GH_TOKEN=github_pat_new', 'HUB_TOKEN=t'])
})
