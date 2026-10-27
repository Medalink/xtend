import fs from 'node:fs'

const args = process.argv.slice(2)
const input = args.includes('-') ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input }) + '\n')

const [noun, verb] = args
const REPO = { archived: false, has_issues: true, has_pull_requests: true, pull_request_creation_policy: 'all' }
if (noun === 'api' && verb.endsWith('/community/profile')) console.log('')
else if (noun === 'api') console.log(process.env.FAKE_GH_REPO || JSON.stringify(REPO))
else if (verb === 'list') console.log(noun === 'pr' ? process.env.FAKE_GH_PRS || '[]' : '[]')
else if (verb === 'create') console.log(`https://github.com/acme/app/${noun === 'pr' ? 'pull' : 'issues'}/7`)
