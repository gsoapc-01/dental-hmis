import type { SoapSmileTheme } from './useSoapSmileTheme'

export function SoapSmileThemeToggle({ theme, onChange }: { theme: SoapSmileTheme; onChange: (theme: SoapSmileTheme) => void }) {
  const nextTheme = theme === 'modern-light' ? 'dark-tech' : 'modern-light'
  return <button className="soap-theme-toggle" type="button" onClick={() => onChange(nextTheme)} aria-label={`Switch to ${nextTheme === 'modern-light' ? 'Modern Light' : 'Dark Tech'} theme`} title={`Current theme: ${theme === 'modern-light' ? 'Modern Light' : 'Dark Tech'}`}>
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">{theme === 'modern-light' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />}</svg>
    <span>{theme === 'modern-light' ? 'Modern Light' : 'Dark Tech'}</span>
  </button>
}

export function SoapSmileThemePicker({ theme, onChange }: { theme: SoapSmileTheme; onChange: (theme: SoapSmileTheme) => void }) {
  const themes: Array<{ value: SoapSmileTheme; name: string; description: string }> = [
    { value: 'modern-light', name: 'Modern Light', description: 'Bright, clinical and intelligent.' },
    { value: 'dark-tech', name: 'Dark Tech', description: 'Focused, immersive and technical.' },
  ]
  return <section className="soap-theme-settings" aria-labelledby="soap-theme-heading"><div className="section-heading"><div><p className="eyebrow">Your workspace</p><h2 id="soap-theme-heading">Appearance</h2><p>Choose the environment that feels right for you. Saved in this browser.</p></div></div>
    <div className="soap-theme-options" role="group" aria-label="Workspace theme">{themes.map((option) => <button className={`soap-theme-option${theme === option.value ? ' selected' : ''}`} key={option.value} type="button" aria-pressed={theme === option.value} onClick={() => onChange(option.value)}>
      <span className={`soap-theme-preview preview-${option.value}`} aria-hidden="true"><i /><span><b /><em /><em /></span></span>
      <span className="soap-theme-option-copy"><strong>{option.name}</strong><small>{option.description}</small></span><span className="soap-theme-choice" aria-hidden="true">{theme === option.value ? '✓' : ''}</span>
    </button>)}</div>
  </section>
}
