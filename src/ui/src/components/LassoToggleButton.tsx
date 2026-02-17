import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { Pencil, Hand } from 'lucide-react';

interface LassoToggleButtonProps {
  active: boolean;
  onToggle: () => void;
}

/**
 * Renders a lasso toggle button as a native Leaflet control (top-left, below zoom).
 * Uses createPortal so it lives inside the Leaflet control pane and is always visible.
 */
export function LassoToggleButton({ active, onToggle }: LassoToggleButtonProps) {
  const map = useMap();

  const container = useMemo(() => {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  }, []);

  useEffect(() => {
    const control = new L.Control({ position: 'topleft' });
    control.onAdd = () => container;
    control.addTo(map);
    return () => {
      control.remove();
    };
  }, [map, container]);

  return createPortal(
    <button
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        cursor: 'pointer',
        border: 'none',
        borderRadius: '2px',
        backgroundColor: active ? '#2563eb' : '#fff',
        color: active ? '#fff' : '#374151',
      }}
      title={active ? 'Switch back to pan mode' : 'Draw to select regions'}
    >
      {active
        ? <Hand style={{ width: 16, height: 16 }} />
        : <Pencil style={{ width: 16, height: 16 }} />
      }
    </button>,
    container,
  );
}
