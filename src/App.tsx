import './App.css'

function App() {
  return (
    <main className="landing">
      <div className="landing-inner">
        <div className="logo-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="56" height="56" fill="none">
            <circle cx="24" cy="24" r="24" fill="url(#g)" />
            <path
              d="M17 19c0-3.3 2.7-6 6-6 2.3 0 4.3 1.3 5.4 3.2.4-.1.8-.2 1.2-.2 3.3 0 6 2.7 6 6v2c0 3.3-2.7 6-6 6-.4 0-.8-.1-1.2-.2-1.1 1.9-3.1 3.2-5.4 3.2-3.3 0-6-2.7-6-6v-8z"
              fill="#fff"
              opacity="0.95"
            />
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0ea5e9" />
                <stop offset="1" stopColor="#06b6d4" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h1>SmartDental HMIS</h1>
        <p className="subtitle">Dental Clinic Management System</p>
        <div className="status-card">
          <div className="status-dot" aria-hidden="true" />
          <span className="status-text">
            Application foundation is ready. Awaiting further configuration.
          </span>
        </div>
      </div>
    </main>
  )
}

export default App
