/**
 * Where the reader is stays where the reader put it (MessageList.tsx,
 * lib/scrollAnchor.ts), while rows change height around them.
 *
 * The list learns where the reader is from `scroll` events, which the browser
 * dispatches once per frame, AFTER the scroll happened. Anything that renders
 * the list in between (a reaction, a typing line, a click elsewhere on the
 * page) used to be laid out against the previous position: a reader who had
 * just left the bottom was put back at the bottom, and a reader up in history
 * had their last scroll undone.
 */
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { bulkSend, expect, GENEL, test, threePeople, type Person } from '../lib/trio'
import { giveAvatars } from '../lib/identity'
import { allMessages, exactRow, restOk, scrollUpTo } from '../lib/messages'

test.beforeEach(async () => {
  await freshServer()
})

async function rowTop(page: Page, text: string): Promise<number> {
  return exactRow(page, text).evaluate((element) => {
    const list = element.closest('[data-testid="message-list"]')!
    return Math.round(element.getBoundingClientRect().top - list.getBoundingClientRect().top)
  })
}

/**
 * Scrolls the list by `by` px and, in the SAME task (before the browser could
 * dispatch the scroll event), makes the page render the list again: a click on
 * a header button, as a person clicking right after a wheel turn. Returns the
 * scrollTop the reader chose; resolves after two frames.
 */
async function scrollThenRender(page: Page, by: number): Promise<number> {
  return page.getByTestId('message-list').evaluate(async (list, delta) => {
    list.scrollTop += delta
    const chosen = list.scrollTop
    // Opens the channel drawer: a state change in Session, which re-renders the list.
    document.querySelector<HTMLButtonElement>('[data-testid="btn-drawer"]')!.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return chosen
  }, by)
}

test('a render between a scroll and its scroll event keeps the reader where they scrolled', async ({ browser, trio }) => {
  const [, mehmet, zeynep] = await threePeople(browser, trio)
  await bulkSend(mehmet, GENEL, 80, 'satır')
  await expect(exactRow(zeynep.page, 'satır 80')).toBeVisible()
  const list = zeynep.page.getByTestId('message-list')

  // At the bottom, a turn of the wheel upwards: not put back at the bottom.
  const chosen = await scrollThenRender(zeynep.page, -600)
  expect(await list.evaluate((element) => element.scrollTop)).toBe(chosen)
  await zeynep.page.keyboard.press('Escape')

  // Up in history, another turn: not undone.
  const again = await scrollThenRender(zeynep.page, -300)
  expect(await list.evaluate((element) => element.scrollTop)).toBe(again)
  await zeynep.page.keyboard.press('Escape')

  // And a reaction near the bottom after it moves nothing either.
  const before = await rowTop(zeynep.page, 'satır 40')
  const target = (await allMessages(mehmet.token, GENEL)).find((message) => message.content === 'satır 79')!
  await restOk(mehmet.token, `/api/messages/${target.id}/reactions/${encodeURIComponent('🔥')}`, 'PUT')
  await expect(exactRow(zeynep.page, 'satır 79').getByTestId('reaction-chip')).toHaveCount(1)
  expect(await rowTop(zeynep.page, 'satır 40')).toBe(before)
})

/** The reading row's top, sampled on every frame until `stop` is set. */
async function watchRow(page: Page, text: string): Promise<void> {
  await exactRow(page, text).evaluate((element) => {
    const list = element.closest('[data-testid="message-list"]')!
    const state = window as unknown as { __trioWatch: { tops: number[]; stop: boolean } }
    state.__trioWatch = { tops: [], stop: false }
    const sample = () => {
      // The row may be re-created by React; find it again by its key.
      const row = list.querySelector(`[data-key="${(element as HTMLElement).dataset.key}"]`) ?? element
      state.__trioWatch.tops.push(Math.round(row.getBoundingClientRect().top - list.getBoundingClientRect().top))
      if (!state.__trioWatch.stop) requestAnimationFrame(sample)
    }
    sample()
  })
}

async function watched(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = window as unknown as { __trioWatch: { tops: number[]; stop: boolean } }
    state.__trioWatch.stop = true
    return state.__trioWatch.tops
  })
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 700 },
]) {
  test(`reactions from two people and late avatars do not move a reader up in history (${viewport.width} px)`, async ({ browser, trio }) => {
    test.setTimeout(150_000)
    const people = await threePeople(browser, trio, { viewport })
    const [ayse, mehmet, zeynep] = people
    await bulkSend(mehmet, GENEL, 120, 'geçmiş')
    await bulkSend(ayse, GENEL, 20, 'yeni')
    const all = await allMessages(ayse.token, GENEL)

    // The reader's pictures arrive late (and in no particular order).
    await zeynep.page.route('**/api/avatars/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 900))
      await route.continue()
    })
    const cdp = await zeynep.page.context().newCDPSession(zeynep.page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })

    await scrollUpTo(zeynep.page, exactRow(zeynep.page, 'geçmiş 20'))
    await expect(zeynep.page.locator('.list-note', { hasText: 'Eski mesajlar yükleniyor' })).toHaveCount(0)
    const reading = exactRow(zeynep.page, 'geçmiş 30')
    await reading.evaluate(async (element) => {
      const list = element.closest<HTMLElement>('[data-testid="message-list"]')!
      list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 40
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const before = await rowTop(zeynep.page, 'geçmiş 30')
    await watchRow(zeynep.page, 'geçmiş 30')

    // Avatars for all three (every row's header picture changes and loads late),
    // while two people react as fast as they can above, in and below the view.
    const keys = ['🎉', '🔥', '❤️', '👍', '😂', '🙏']
    const targets = ['geçmiş 22', 'geçmiş 25', 'geçmiş 31', 'geçmiş 33', 'geçmiş 90', 'geçmiş 119', 'yeni 20'].map(
      (text) => all.find((message) => message.content === text)!,
    )
    const burst = (person: Person, offset: number) =>
      Promise.all(
        targets.flatMap((message, index) =>
          keys.slice(0, 3).map((_, k) =>
            restOk(person.token, `/api/messages/${message.id}/reactions/${encodeURIComponent(keys[(index + k + offset) % keys.length])}`, 'PUT'),
          ),
        ),
      )
    await Promise.all([giveAvatars(people), burst(ayse, 0), burst(mehmet, 3)])
    for (const text of ['geçmiş 22', 'geçmiş 31', 'yeni 20']) {
      await expect(exactRow(zeynep.page, text).getByTestId('reaction-chip')).toHaveCount(6)
    }
    // Every picture in the reader's view has arrived.
    await expect
      .poll(() =>
        zeynep.page
          .getByTestId('message-list')
          .locator('.avatar-img')
          .evaluateAll((images) => (images as HTMLImageElement[]).filter((img) => !img.complete).length),
      )
      .toBe(0)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

    const tops = await watched(zeynep.page)
    expect(tops.length).toBeGreaterThan(5)
    expect(new Set(tops)).toEqual(new Set([before]))
    expect(await rowTop(zeynep.page, 'geçmiş 30')).toBe(before)
  })
}
