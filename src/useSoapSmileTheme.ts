import { useState } from 'react'

export type SoapSmileTheme = 'modern-light' | 'dark-tech'
export const soapSmileThemeStorageKey = (userId: string) => `soapsmile.workspace-theme:${userId}`

export function readSoapSmileTheme(userId: string): SoapSmileTheme {
  try {
    return window.localStorage.getItem(soapSmileThemeStorageKey(userId)) === 'dark-tech' ? 'dark-tech' : 'modern-light'
  } catch {
    return 'modern-light'
  }
}

export function useSoapSmileTheme(userId: string) {
  const [preference, setPreference] = useState(() => ({ userId, theme: readSoapSmileTheme(userId) }))
  // Resolve the current identity during render, never displaying another user's state.
  const theme = preference.userId === userId ? preference.theme : readSoapSmileTheme(userId)

  function changeTheme(nextTheme: SoapSmileTheme) {
    setPreference({ userId, theme: nextTheme })
    try {
      window.localStorage.setItem(soapSmileThemeStorageKey(userId), nextTheme)
    } catch {
      // The presentation preference still works when browser storage is unavailable.
    }
  }

  return { theme, changeTheme }
}
