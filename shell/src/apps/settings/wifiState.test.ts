import { describe, expect, it } from 'vitest'
import { sanitizeShellWifiState } from './wifiState'

describe('sanitizeShellWifiState', () => {
  it('keeps valid wifi devices and access points', () => {
    expect(
      sanitizeShellWifiState({
        wifi_enabled: true,
        devices: [{ device: 'wlan0', state: 'connected', connection: 'Cafe' }],
        access_points: [
          {
            ssid: 'Cafe',
            signal_percent: 61,
            security: 'WPA2',
            bars: 'bars',
            in_use: true,
            is_saved: true,
            requires_password: true,
          },
        ],
      }),
    ).toEqual({
      backend: 'networkmanager',
      wifi_enabled: true,
      devices: [{ device: 'wlan0', state: 'connected', connection: 'Cafe' }],
      access_points: [
        {
          ssid: 'Cafe',
          signal_percent: 61,
          security: 'WPA2',
          bars: 'bars',
          in_use: true,
          is_saved: true,
          requires_password: true,
        },
      ],
    })
  })

  it('drops malformed rows', () => {
    expect(
      sanitizeShellWifiState({
        wifi_enabled: true,
        devices: [{ device: '', state: 'connected' }],
        access_points: [{ ssid: '', signal_percent: 50 }],
      }),
    ).toEqual({
      backend: 'networkmanager',
      wifi_enabled: true,
      devices: [],
      access_points: [],
    })
  })
})
