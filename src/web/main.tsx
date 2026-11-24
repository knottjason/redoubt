import '@mantine/core/styles.css'
import '@mantine/charts/styles.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router'
import { useSummary } from './api.ts'
import { Alerts } from './pages/Alerts.tsx'
import { History } from './pages/History.tsx'
import { MachinePage, Machines } from './pages/Machines.tsx'
import { Overview } from './pages/Overview.tsx'
import { Plugins } from './pages/Plugins.tsx'
import { Rules } from './pages/Rules.tsx'
import { theme } from './theme.ts'

function Shell() {
  const s = useSummary().data
  return <>
    <header className="top">
      <span className="brand"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4c8dff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7l8-4z" /><path d="M9 12l2 2 4-4" /></svg>Redoubt</span>
      <nav aria-label="Main"><NavLink to="/overview">Overview</NavLink><NavLink to="/alerts">Alerts</NavLink><NavLink to="/machines">Devices{s && s.newDevices > 0 && <span className="count" title="New devices on a watched network">{s.newDevices}</span>}</NavLink><NavLink to="/rules">Rules</NavLink><NavLink to="/history">History</NavLink><NavLink to="/plugins">Plugins</NavLink></nav>
      <span style={{ flex: 1 }} />
      {s && <span className="dim"><span className="dot" style={{ background: s.sensorOk ? (s.drops ? '#f5a524' : '#3ccf8e') : '#ff6b6b' }} />{s.sensorOk ? <>Sensor OK · <span className="mono">{s.drops}</span> drops in 10 min</> : 'Sensor is silent'} · {s.user}</span>}
    </header>
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/alerts" element={<Alerts />} /><Route path="/machines" element={<Machines />} /><Route path="/machines/:ip" element={<MachinePage />} />
      <Route path="/plugins" element={<Plugins />} /><Route path="/history" element={<History />} /><Route path="/overview" element={<Overview />} /><Route path="/rules" element={<Rules />} />
      <Route path="*" element={<div className="page">No such page.</div>} />
    </Routes>
  </>
}

createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} forceColorScheme="dark"><QueryClientProvider client={new QueryClient()}><BrowserRouter><Shell /></BrowserRouter></QueryClientProvider></MantineProvider>,
)
