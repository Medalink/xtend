import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const args = process.argv.slice(2)
const input = args.includes('-') ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input }) + '\n')

const [noun, verb] = args
if (process.env.FAKE_GH_FAIL) process.exit(1)
// `gh repo create <name> --private --source . --remote origin` makes the repo and adds it as a remote of the clone it runs in.
if (noun === 'repo' && verb === 'create') {
  execFileSync('git', ['init', '-q', '--bare', process.env.FAKE_GH_ORIGIN])
  execFileSync('git', ['remote', 'add', args[args.indexOf('--remote') + 1], process.env.FAKE_GH_ORIGIN])
  process.exit(0)
}
const REPO = { archived: false, has_issues: true, has_pull_requests: true, pull_request_creation_policy: 'all' }
if (noun === 'api' && verb.endsWith('/community/profile')) console.log('')
else if (noun === 'api') console.log(process.env.FAKE_GH_REPO || JSON.stringify(REPO))
else if (verb === 'list') console.log(noun === 'pr' ? process.env.FAKE_GH_PRS || '[]' : '[]')
else if (verb === 'create') console.log(`https://github.com/acme/app/${noun === 'pr' ? 'pull' : 'issues'}/7`)
