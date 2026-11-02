// The test hub for the phone tests (run.sh): the real hub, with filing stubbed. It files to
// me/ostrakon (public) and me/pane (private); a note's text steers it: `[nodraft]` fails the
// draft, `[refuse]` is refused by GitHub, `[unsure]` gets no answer. Issues are numbered from 1.
import { serve } from '../../server/hub'
import { type Filing, NotCreated } from '../../server/requests'

let issues = 0
const filing: Filing = {
  repos: async () => [
    { repo: 'me/ostrakon', public: true },
    { repo: 'me/pane', public: false },
  ],
  draft: async request => {
    if (request.text.includes('[nodraft]')) throw new Error('drafting timed out')
    return { title: request.text.split('\n')[0] ?? '', body: request.text, labels: ['bug'] }
  },
  file: async request => {
    if (request.text.includes('[refuse]')) throw new NotCreated('label not found')
    if (request.text.includes('[unsure]')) throw new Error('no answer from GitHub')
    issues += 1
    return `https://github.com/${request.repo}/issues/${issues}`
  },
  find: async () => null,
}

const { HUB_PORT, HUB_DATA, HUB_TOKEN } = process.env
if (!HUB_PORT || !HUB_DATA || !HUB_TOKEN) throw new Error('set HUB_PORT, HUB_DATA and HUB_TOKEN (run.sh does)')
serve({ port: Number(HUB_PORT), dataDir: HUB_DATA, auth: { token: HUB_TOKEN }, filing })
