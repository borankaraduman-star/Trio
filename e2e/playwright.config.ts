import { defineConfig } from '@playwright/test'

export const CHROMIUM_ARGS = [
  // Grant camera/microphone/screen without a prompt. In current Chromium this
  // flag also makes getDisplayMedia pick a (fake) screen with no picker.
  '--use-fake-ui-for-media-stream',
  // A synthetic microphone (a beep) and camera/screen (a moving test pattern).
  '--use-fake-device-for-media-stream',
]

export default defineConfig({
  testDir: './tests',
  // ONE server for the whole run, and the tests kill and restart it.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  globalSetup: './lib/global-setup.ts',
  globalTeardown: './lib/global-teardown.ts',
  use: {
    trace: 'off',
    launchOptions: { args: CHROMIUM_ARGS },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
  },
})
