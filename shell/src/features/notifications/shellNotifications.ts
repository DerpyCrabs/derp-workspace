import {
  closeViaShell,
  invokeNotificationActionViaShell,
  notifyViaShell,
  type ShellNotificationEvent,
  type ShellNotificationRequest,
} from './notificationsState'

export const DERP_NOTIFICATION_EVENT = 'derp-notification'

export type DerpNotificationsApi = {
  notify: (request: ShellNotificationRequest) => Promise<number>
  close: (notificationId: number) => Promise<void>
  invokeAction: (notificationId: number, actionKey: string) => Promise<void>
  addEventListener: (listener: (event: ShellNotificationEvent) => void) => () => void
}

declare global {
  interface Window {
    __DERP_NOTIFICATIONS__?: DerpNotificationsApi
  }
}

export function dispatchShellNotificationEvent(detail: ShellNotificationEvent) {
  window.dispatchEvent(new CustomEvent<ShellNotificationEvent>(DERP_NOTIFICATION_EVENT, { detail }))
}

export function installShellNotificationsApi() {
  const api: DerpNotificationsApi = {
    notify: (request) => notifyViaShell(request),
    close: (notificationId) => closeViaShell(notificationId),
    invokeAction: (notificationId, actionKey) =>
      invokeNotificationActionViaShell(notificationId, actionKey),
    addEventListener: (listener) => {
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<ShellNotificationEvent>).detail
        if (detail) listener(detail)
      }
      window.addEventListener(DERP_NOTIFICATION_EVENT, handler as EventListener)
      return () => window.removeEventListener(DERP_NOTIFICATION_EVENT, handler as EventListener)
    },
  }
  window.__DERP_NOTIFICATIONS__ = api
  return () => {
    if (window.__DERP_NOTIFICATIONS__ === api) delete window.__DERP_NOTIFICATIONS__
  }
}
