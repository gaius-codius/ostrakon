// The load report (SPEC §12): which Claude Code last loaded the mod, and the problems its sessions
// hit since. `ostrakon doctor` (bin/doctor) reads it from ~/.cache/ostrakon/report.json, the one
// way to see that the mod actually runs in the version someone has, not just that it validates.

export type ReportProblem = { where: string; message: string; count: number; first: string; last: string }
export type LoadReport = { loadedAt: string; writtenAt: string; claude: string; problems: ReportProblem[] }

// The distinct problems kept; the oldest go first. A repeat (a hub offline every poll) is counted.
export const REPORT_MAX_PROBLEMS = 10

export const freshReport = (at: string, claude: string): LoadReport => ({ loadedAt: at, writtenAt: at, claude, problems: [] })

export const withProblem = (report: LoadReport, where: string, message: string, at: string): LoadReport => {
  const same = report.problems.find(p => p.where === where && p.message === message)
  const rest = report.problems.filter(p => p !== same)
  const problem = same ? { ...same, count: same.count + 1, last: at } : { where, message, count: 1, first: at, last: at }
  return { ...report, problems: [...rest, problem].slice(-REPORT_MAX_PROBLEMS) }
}
