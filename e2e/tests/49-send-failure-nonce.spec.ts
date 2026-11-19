/**
 * CONTRACT-V6-MEDIA §5b: an `error` answering a `message.send` names its
 * nonce, and the client fails exactly that row. Two sends are in flight; the
 * FIRST is refused after the second has gone out — the old rule ("the last
 * message sent") would have failed the wrong one. Without a nonce on the error
 * (a server from before), the old rule still applies.
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test'
import { freshServer } from '../lib/server'
import { apiJoin, expect, personViaApi, personWithSession, test, type ContextOptions } from '../lib/trio'
import { row, submitComposer } from '../lib/messages'

test.beforeEach(async () => {
  await freshServer()
})

/**
 * A socket route that holds the first `message.send` until the second one
 * arrives, then forwards the first with content the server must refuse (a NUL
 * character) and the second as it is. `stripNonce` takes the nonce off error
 * frames on the way back, as a pre-V6 server would send them.
 */
function holdFirstSend(stripNonce: boolean) {
  const state = { refused: [] as string[] }
  const prepare = (context: BrowserContext) =>
    context.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      let held: Record<string, unknown> | null = null
      let sends = 0
      ws.onMessage((raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>
        if (frame.type !== 'message.send') return server.send(raw)
        sends += 1
        if (sends === 1) {
          held = { ...frame, content: `${String(frame.content)}\u0000` }
          return
        }
        if (sends === 2 && held) {
          server.send(JSON.stringify(held))
          held = null
        }
        server.send(raw)
      })
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>
        if (frame.type === 'error') {
          state.refused.push(String(frame.nonce ?? '(none)'))
          if (stripNonce) {
            delete frame.nonce
            return ws.send(JSON.stringify(frame))
          }
        }
        ws.send(raw)
      })
    })
  return { state, prepare: prepare as ContextOptions['prepare'] }
}

for (const width of [1280, 390] as const) {
  test(`two sends in flight, the first refused: exactly that row fails, the second is sent (${width} px)`, async ({ browser, trio }) => {
    const options: ContextOptions = width === 390 ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}
    const route = holdFirstSend(false)
    const ayse = trio.add(await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), { ...options, prepare: route.prepare }))
    const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
    const composer = ayse.page.getByTestId('composer')
    await composer.fill('birinci mesaj')
    await submitComposer(ayse.page)
    await composer.fill('ikinci mesaj')
    await submitComposer(ayse.page)

    await expect(row(ayse.page, 'ikinci mesaj')).toHaveAttribute('data-status', 'sent')
    await expect(row(ayse.page, 'birinci mesaj')).toHaveAttribute('data-status', 'failed')
    await expect(row(ayse.page, 'birinci mesaj')).toContainText('Gönderilemedi.')
    expect(route.state.refused).toHaveLength(1)
    expect(route.state.refused[0]).not.toBe('(none)')
    await expect(row(mehmet.page, 'ikinci mesaj')).toHaveCount(1)
    await expect(row(mehmet.page, 'birinci mesaj')).toHaveCount(0)

    // Tried again (the same nonce, the real text this time): it goes through.
    await row(ayse.page, 'birinci mesaj').getByRole('button', { name: 'Tekrar dene' }).click()
    await expect(row(ayse.page, 'birinci mesaj')).toHaveAttribute('data-status', 'sent')
    await expect(row(mehmet.page, 'birinci mesaj')).toHaveCount(1)
  })
}

test('an error with no nonce (a server from before V6): the send just made fails, as before', async ({ browser, trio }) => {
  const route = holdFirstSend(true)
  const ayse = trio.add(await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), { prepare: route.prepare }))
  const composer = ayse.page.getByTestId('composer')
  await composer.fill('birinci mesaj')
  await composer.press('Enter')
  await composer.fill('ikinci mesaj')
  await composer.press('Enter')
  // The old rule fails the last send (the second), whose confirmation then comes and wins;
  // the first is left unconfirmed and given up on by its timer.
  await expect(row(ayse.page, 'ikinci mesaj')).toHaveAttribute('data-status', 'sent')
  await expect(row(ayse.page, 'birinci mesaj')).toHaveAttribute('data-status', 'failed', { timeout: 15_000 })
  expect(route.state.refused).toHaveLength(1)
})
