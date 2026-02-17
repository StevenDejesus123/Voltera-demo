import { useRef, useState, useCallback, useEffect } from 'react';
import { Polyline, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Region } from '../types';

interface LassoSelectorProps {
  enabled: boolean;
  regions: Region[];
  onLassoSelect: (regions: Region[]) => void;
}

type LatLng = [number, number];

function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  const [py, px] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iy, ix] = polygon[i];
    const [jy, jx] = polygon[j];
    if ((iy > py) !== (jy > py) && px < ((jx - ix) * (py - iy)) / (jy - iy) + ix) {
      inside = !inside;
    }
  }
  return inside;
}

function LassoEventHandler({
  enabled,
  regions,
  onLassoSelect,
  setDrawingPoints,
}: LassoSelectorProps & { setDrawingPoints: (pts: LatLng[]) => void }) {
  const isDrawing = useRef(false);
  const points = useRef<LatLng[]>([]);
  // Refs to avoid stale closures in Leaflet event handlers
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const onLassoSelectRef = useRef(onLassoSelect);
  onLassoSelectRef.current = onLassoSelect;

  const finishDraw = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    const polygon = points.current;

    if (polygon.length >= 3) {
      const selected = regionsRef.current.filter(
        (r) => r.lat !== 0 && r.lng !== 0 && isPointInPolygon([r.lat, r.lng], polygon),
      );
      if (selected.length > 0) {
        onLassoSelectRef.current(selected);
      }
    }

    points.current = [];
    setDrawingPoints([]);
  }, [setDrawingPoints]);

  const map = useMapEvents({
    mousedown(e: L.LeafletMouseEvent) {
      if (!enabled) return;
      isDrawing.current = true;
      points.current = [[e.latlng.lat, e.latlng.lng]];
      setDrawingPoints(points.current);
    },
    mousemove(e: L.LeafletMouseEvent) {
      if (!enabled || !isDrawing.current) return;
      points.current.push([e.latlng.lat, e.latlng.lng]);
      setDrawingPoints([...points.current]);
    },
    mouseup() {
      if (!enabled) return;
      finishDraw();
    },
  });

  // Document-level mouseup catches releases outside the map container
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDrawing.current) {
        finishDraw();
      }
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [finishDraw]);

  // Toggle map dragging when lasso mode changes
  useEffect(() => {
    if (enabled) {
      map.dragging.disable();
      map.getContainer().style.cursor = 'crosshair';
    } else {
      map.dragging.enable();
      map.getContainer().style.cursor = '';
      // Clean up in case user toggled off mid-draw
      if (isDrawing.current) {
        isDrawing.current = false;
        points.current = [];
        setDrawingPoints([]);
      }
    }
    return () => {
      map.dragging.enable();
      map.getContainer().style.cursor = '';
    };
  }, [enabled, map, setDrawingPoints]);

  return null;
}

export function LassoSelector({ enabled, regions, onLassoSelect }: LassoSelectorProps) {
  const [drawingPoints, setDrawingPoints] = useState<LatLng[]>([]);

  return (
    <>
      <LassoEventHandler
        enabled={enabled}
        regions={regions}
        onLassoSelect={onLassoSelect}
        setDrawingPoints={setDrawingPoints}
      />
      {drawingPoints.length >= 2 && (
        <Polyline
          positions={drawingPoints}
          pathOptions={{
            color: '#3b82f6',
            weight: 2,
            dashArray: '6 4',
            fill: true,
            fillColor: '#3b82f6',
            fillOpacity: 0.1,
          }}
        />
      )}
    </>
  );
}
