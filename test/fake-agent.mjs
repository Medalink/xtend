import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const at = process.argv.indexOf('--file')
const prompt = fs.readFileSync(at > 0 ? process.argv[at + 1] : 0, 'utf8')
const mode = process.env.FAKE_MODE
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, prompt.split('\n')[0] + '\n')
if (mode === 'fail') process.exit(0)
if (mode === 'hook') {
  fs.writeFileSync('.git/hooks/pre-commit', '#!/bin/sh\necho owned > owned.txt\n')
  fs.appendFileSync('app.js', '// footer\n')
  execFileSync('git', ['commit', '-qam', 'agent committed by itself'])
  process.exit(0)
}
if (mode === 'gitdir') {
  fs.rmSync('.git/hooks', { recursive: true })
  fs.appendFileSync('.git/config', '[core]\n\thooksPath = .evil\n')
  fs.writeFileSync('.git/info/attributes', '* filter=evil\n')
}

if (prompt.includes('Write a reference sheet')) {
  fs.writeFileSync(prompt.match(/ at (\S+)\.\n/)[1], '# app\n## Extension points\n- greeting lives in app.js\n')
} else if (prompt.includes('preparing one change')) {
  const src = fs.readFileSync('app.js', 'utf8')
  fs.writeFileSync('app.js', src.replace(/<<<<<<< .*\r?\n[\s\S]*?=======\r?\n([\s\S]*?)>>>>>>> .*\r?\n/g, '$1'))
} else if (prompt.includes('# Request')) {
  fs.writeFileSync('app.js', fs.readFileSync('app.js', 'utf8').replace("'hello'", "'howdy'"))
  if (mode === 'commit') execFileSync('git', ['commit', '-qam', 'agent committed by itself'])
  if (mode === 'append') fs.appendFileSync('app.js', '// twice\n')
  console.log('Changed the greeting to howdy.')
} else if (prompt.includes('merging new upstream')) {
  const src = fs.readFileSync('app.js', 'utf8')
  if (prompt.includes('the way it was resolved before') && !src.includes('<<<<<<<')) {
    fs.writeFileSync('app.js', "const greeting = 'howdy'\n// a\n// b\nconst name = 'everyone'\nconsole.log(greeting, name)\n")
    process.exit(0)
  }
  const fixed = mode === 'half'
    ? src.replace(/^(<<<<<<<|>>>>>>>) .*\r?\n/gm, '')
    : src.replace(/<<<<<<< .*\r?\n([\s\S]*?)=======\r?\n[\s\S]*?>>>>>>> .*\r?\n/g, '$1')
  fs.writeFileSync('app.js', fixed)
}
