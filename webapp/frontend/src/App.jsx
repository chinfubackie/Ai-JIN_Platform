import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import LiveDemo from './pages/LiveDemo'
import Dataset from './pages/Dataset'
import Annotator from './pages/Annotator'
import DataImport from './pages/DataImport'
import Training from './pages/Training'
import ModelManagement from './pages/ModelManagement'
import ApiDocs from './pages/ApiDocs'
import Projects from './pages/Projects'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/demo" element={<LiveDemo />} />
          <Route path="/dataset" element={<Dataset />} />
          <Route path="/annotator" element={<Annotator />} />
          <Route path="/import" element={<DataImport />} />
          <Route path="/training" element={<Training />} />
          <Route path="/models" element={<ModelManagement />} />
          <Route path="/api-docs" element={<ApiDocs />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/team" element={<Navigate to="/settings" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
