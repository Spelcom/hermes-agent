import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'
import { createServer, transformWithEsbuild } from 'vite'

const baseline = process.argv.includes('--baseline')
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mocks = {
  '@/i18n': `import { ru } from '/src/i18n/ru.ts'; export const useI18n = () => ({t: ru});`,
  '@/api/config': `export const saveHermesConfigRecord = async () => ({ok:true});`,
  '@/lib/voice-live': `export const fetchVoiceLiveStatus = async () => ({auth:'codex-subscription', voice:'spruce', voices:['spruce','maple','juniper'], output_gain:2});`,
  '@/lib/voice-live-check': `export const checkLiveVoice = async () => {if(window.fixtureError) throw new Error('ОченьДлиннаяОшибкаБезПробелов'.repeat(16));};`,
  './agent-conversation-session': `export const captureAgentConversationRoute = route => route; export const openAgentConversationSession = async () => {throw new Error('Unexpected session open');};`
}
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AgentVoicePicker} from '/src/app/chat/agent-voice-picker.tsx';
  import {Button} from '/src/components/ui/button.tsx';
  import '/src/styles.css';
  const route = {connectionId:'fixture', mode:'remote', profile:'alias', targetProfile:'yuki'};
  createRoot(document.getElementById('root')).render(<>
    {[280, 200, 340].map(width => <section key={width} data-fixture={width} style={{width, margin:16}}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 p-2">
        <AgentVoicePicker className="min-w-0 flex-1 basis-48" route={route} sessionId="fixture-session" />
        <Button aria-label="Микрофон" size="icon" variant="ghost">🎙</Button>
      </div>
    </section>)}
  </>);
`
const plugin = {
  name: 'voice-picker-layout-fixture',
  enforce: 'pre',
  resolveId(id) {
    if (id === '/voice-picker-fixture.tsx') return '\0voice-picker-fixture.tsx'
    const mockKey = Object.keys(mocks).find(
      key => id === key || (key.startsWith('@/') && id === path.join(desktop, 'src', key.slice(2)))
    )
    if (mockKey) return `\0voice-picker-mock:${mockKey}`
  },
  async load(id) {
    if (
      baseline &&
      ['agent-voice-picker.tsx', 'agent-voice-check.tsx'].some(name => id === path.join(desktop, 'src/app/chat', name))
    ) {
      const source = execFileSync('git', ['show', `HEAD:apps/desktop/${path.relative(desktop, id)}`], {
        cwd: desktop,
        encoding: 'utf8'
      })
      return source
    }
    if (id === '\0voice-picker-fixture.tsx')
      return (await transformWithEsbuild(fixture, 'voice-picker-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code
    if (id.startsWith('\0voice-picker-mock:')) return mocks[id.slice('\0voice-picker-mock:'.length)]
  },
  configureServer(server) {
    server.middlewares.use('/voice-layout-check', async (_request, response) => {
      const html = await server.transformIndexHtml(
        '/voice-layout-check',
        '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/voice-picker-fixture.tsx"></script></body></html>'
      )
      response.setHeader('Content-Type', 'text/html')
      response.end(html)
    })
  }
}
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, 'vite.config.ts'),
  plugins: [plugin],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error'
})
let browser
try {
  await server.listen()
  const executable = process.argv.slice(2).find(arg => !arg.startsWith('--'))
  browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) })
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors = []
  page.on('pageerror', error => {
    errors.push(error.message)
    console.error(error.message)
  })
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/voice-layout-check`)
  await page.getByRole('combobox').first().waitFor({ timeout: 10000 })
  const checkBounds = async state => {
    const overflow = await page.locator('[data-fixture]').evaluateAll(sections =>
      sections.flatMap(section => {
        const bounds = section.getBoundingClientRect()
        return [...section.querySelectorAll('*')]
          .filter(element => {
            if (globalThis.getComputedStyle(element).position === 'absolute' || !element.getClientRects().length)
              return false
            const box = element.getBoundingClientRect()
            return box.right > bounds.right + 1 || box.left < bounds.left - 1
          })
          .map(element => ({
            width: section.dataset.fixture,
            tag: element.tagName,
            role: element.getAttribute('role'),
            text: element.textContent?.slice(0, 60)
          }))
      })
    )
    assert.deepEqual(overflow, [], `${state}: elements must remain inside their panel`)
    assert.equal(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
      true
    )
  }
  await checkBounds('idle')
  for (const button of await page.getByRole('button', { name: 'Послушать голос', exact: true }).all())
    await button.click()
  await page.getByText('Голос работает: получены звук и текст', { exact: true }).first().waitFor()
  await checkBounds('long Russian success')
  await page.screenshot({ path: path.join(tmpdir(), 'hermes-voice-picker-success.png') })
  await page.evaluate(() => {
    globalThis.fixtureError = true
  })
  for (const button of await page.getByRole('button', { name: 'Послушать голос', exact: true }).all())
    await button.click()
  await page.getByRole('status').first().filter({ hasText: 'ОченьДлиннаяОшибкаБезПробелов' }).waitFor()
  await checkBounds('unbroken error')
  assert.deepEqual(errors, [])
  const output = path.join(tmpdir(), 'hermes-voice-picker-layout.png')
  await page.screenshot({ path: output })
  console.log(
    JSON.stringify({
      widths: [280, 200, 340],
      states: ['idle', 'long Russian success', 'unbroken error'],
      overflow: false,
      screenshot: output
    })
  )
} finally {
  await browser?.close()
  await server.close()
}
