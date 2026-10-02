import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { query } from './claude'

const exec = promisify(execFile)

export type Handoff = { text: string; prUrl?: string; prTitle?: string; error?: string }

async function currentPr(cwd: string): Promise<{ url: string; title: string; body: string; number: number } | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'url,title,body,number'], { cwd, windowsHide: true })
    return JSON.parse(stdout)
  } catch {
    return null // no PR for this branch, or gh isn't set up
  }
}

/**
 * A short message for handing the work to someone else, written as you'd type it to a teammate:
 * two or three sentences in your own voice, then the link to the pull request. Written by a model
 * from the PR and what the session did; the link is added here so it's always the right one.
 */
export async function handoffMessage(cwd: string, sessionBrief: string): Promise<Handoff> {
  const pr = await currentPr(cwd)
  const prompt = `Write a message I'm about to send a teammate on Slack, handing over this piece of work. Write it as me, in the first person, the way a developer actually messages a colleague: relaxed and direct, like "Picked up the discount codes bug, turns out checkout was applying the code twice. I've moved it so it only runs once on the server and added tests. Could you give it a look when you get a sec?"

Rules:
- Two or three short sentences, under 45 words in all. Give the gist, not an inventory: the one main thing it changes and why, then what you need from them. No lists of items, counts or file names unless one really matters. Mention what's left only if it changes what they'd do.
- ${pr ? 'End by asking them to take a look, or saying what you need from them. Don\'t paste the link; I add it after your message.' : 'There\'s no pull request yet, so say it\'s still in progress on my branch.'}
- No greeting line on its own, no sign-off, no markdown, no bullet points, no emoji, no quotes around it.
- Don't start with "This PR" or "I've got this PR". Don't use em dashes. Avoid corporate phrases like "streamline", "leverage", "enhance", "robust".
- Reply with only the message.

${pr ? `Pull request #${pr.number}: ${pr.title}\n\n${pr.body.slice(0, 4000)}` : 'There is no pull request yet.'}

What happened in the session:
${sessionBrief.slice(0, 6000)}`
  let summary = ''
  try {
    for await (const msg of query({ prompt, options: { cwd, model: 'sonnet', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' } } })) {
      if (msg.type === 'result' && msg.subtype === 'success') summary = msg.result.trim()
    }
  } catch (err) {
    return { text: '', error: `Couldn't write the message: ${String(err)}` }
  }
  // Tidy what a model sometimes adds anyway: wrapping quotes, a pasted link, dashes.
  summary = summary
    .replace(/^["'“]+|["'”]+$/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!summary) return { text: '', error: 'Couldn’t write the message. Try again.' }
  const text = pr ? `${summary}\n${pr.url}` : summary
  return { text, prUrl: pr?.url, prTitle: pr?.title }
}
