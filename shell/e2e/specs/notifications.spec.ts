import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  assert,
  clickRect,
  defineGroup,
  getJson,
  openSettings,
  waitFor,
  type ShellSnapshot,
} from '../lib/runtime.ts'
import { postJson } from '../lib/setup.ts'

const execFileAsync = promisify(execFile)

async function switchSettingsPage(
  base: string,
  controlKey: 'settings_tab_notifications',
  pageId: 'notifications',
) {
  return waitFor(
    `wait for settings ${pageId} page`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      if (
        shell.controls?.[controlKey] &&
        shell.settings_window_visible &&
        shell.controls.settings_notifications_page
      ) {
        return shell
      }
      const rect = shell.controls?.[controlKey]
      if (rect) await clickRect(base, rect)
      const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
      return next.controls?.settings_notifications_page && next.controls?.[controlKey] ? next : null
    },
    5000,
    100,
  )
}

async function sendNativeNotification(summary: string, body: string) {
  await execFileAsync('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.Notifications',
    '--object-path',
    '/org/freedesktop/Notifications',
    '--method',
    'org.freedesktop.Notifications.Notify',
    'Derp Native E2E',
    '0',
    '',
    summary,
    body,
    '[]',
    '{}',
    '5000',
  ])
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('shell notifications render, invoke action, and land in history', async ({ base }) => {
    await openSettings(base, 'click')
    await switchSettingsPage(base, 'settings_tab_notifications', 'notifications')

    await postJson(base, '/notifications_shell', {
      app_name: 'Shell E2E',
      summary: 'Shell notification',
      body: 'Action me',
      actions: [{ key: 'open', label: 'Open' }],
      expire_timeout_ms: 0,
    })

    const activeShell = await waitFor(
      'wait for shell notification visible',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if ((shell.notifications?.active_count ?? 0) < 1) return null
        if (!shell.controls?.shell_notification_first_action) return null
        return shell
      },
      5000,
      100,
    )

    assert(activeShell.controls?.shell_notification_first_action, 'missing shell notification action button')
    await clickRect(base, activeShell.controls.shell_notification_first_action)

    await waitFor(
      'wait for shell notification action to close toast',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return (shell.notifications?.active_count ?? 0) === 0 && (shell.notifications?.history_count ?? 0) >= 1
          ? shell
          : null
      },
      5000,
      100,
    )

    await switchSettingsPage(base, 'settings_tab_notifications', 'notifications')
    await waitFor(
      'wait for shell notification history row',
      async () => {
        const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return shell.controls?.settings_notifications_history_first ? shell : null
      },
      5000,
      100,
    )
  })

  test('native notifications use dbus and respect enable or disable banners', async ({ base }) => {
    await openSettings(base, 'click')
    let shell = await switchSettingsPage(
      base,
      'settings_tab_notifications',
      'notifications',
    )

    if (shell.notifications?.enabled === false && shell.controls?.settings_notifications_enable) {
      await clickRect(base, shell.controls.settings_notifications_enable)
      shell = await waitFor(
        'wait for notifications enabled',
        async () => {
          const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
          return next.notifications?.enabled === true ? next : null
        },
        5000,
        100,
      )
    }

    await sendNativeNotification('Native visible notification', 'dbus visible')

    const visibleShell = await waitFor(
      'wait for native dbus notification visible',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if ((next.notifications?.active_count ?? 0) < 1) return null
        if (!next.controls?.shell_notification_first) return null
        return next
      },
      5000,
      100,
    )

    await switchSettingsPage(base, 'settings_tab_notifications', 'notifications')
    assert(visibleShell.controls?.settings_notifications_disable, 'missing notifications disable button')
    await clickRect(base, visibleShell.controls.settings_notifications_disable)

    await waitFor(
      'wait for notifications disabled',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return next.notifications?.enabled === false ? next : null
      },
      5000,
      100,
    )

    await sendNativeNotification('Native hidden notification', 'dbus hidden')

    const disabledShell = await waitFor(
      'wait for disabled notifications to stay off-screen',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (next.notifications?.enabled !== false) return null
        if ((next.notifications?.history_count ?? 0) < 2) return null
        return !next.controls?.shell_notification_first ? next : null
      },
      5000,
      100,
    )

    assert(disabledShell.controls?.settings_notifications_enable, 'missing notifications enable button')
    await clickRect(base, disabledShell.controls.settings_notifications_enable)

    const reenabledShell = await waitFor(
      'wait for notifications re-enabled',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        if (next.notifications?.enabled !== true) return null
        if ((next.notifications?.active_count ?? 0) < 1) return null
        return next.controls?.shell_notification_first_dismiss ? next : null
      },
      5000,
      100,
    )

    assert(reenabledShell.controls?.shell_notification_first_dismiss, 'missing notification dismiss button')
    await clickRect(base, reenabledShell.controls.shell_notification_first_dismiss)

    await waitFor(
      'wait for notification dismiss close',
      async () => {
        const next = await getJson<ShellSnapshot>(base, '/test/state/shell')
        return (next.notifications?.active_count ?? 0) === 0 ? next : null
      },
      5000,
      100,
    )
  })
})
