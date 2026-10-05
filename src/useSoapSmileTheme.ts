import { useState } from 'react'

export type SoapSmileTheme = 'modern-light' | 'dark-tech'
export const soapSmileThemeStorageKey = 'soapsmile.workspace-theme'

export function readSoapSmileTheme(): SoapSmileTheme {
  try {
    return window.localStorage.getItem(soapSmileThemeStorageKey) === 'dark-tech' ? 'dark-tech' : 'modern-light'
  } catch {
    return 'modern-light'
  }
}

export function useSoapSmileTheme() {
  const [theme, setTheme] = useState<SoapSmileTheme>(readSoapSmileTheme)

  function changeTheme(nextTheme: SoapSmileTheme) {
    setTheme(nextTheme)
    try {
      window.localStorage.setItem(soapSmileThemeStorageKey, nextTheme)
    } catch {
      // The presentation preference still works when browser storage is unavailable.
    }
  }

  return { theme, changeTheme }
}
