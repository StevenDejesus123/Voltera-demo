import { useState } from 'react';
import { LandingPage } from './components/LandingPage';
import { MapExplorer } from './components/MapExplorer';
import 'leaflet/dist/leaflet.css';

export default function App() {
  const [showExplorer, setShowExplorer] = useState(false);

  if (!showExplorer) {
    return <LandingPage onExplore={() => setShowExplorer(true)} />;
  }

  return <MapExplorer />;
}
