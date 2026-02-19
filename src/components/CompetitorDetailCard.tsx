import { X } from 'lucide-react';
import type { CompetitorSite } from '../types';
import { getCategoryColor } from '../dataLoader/competitorLoader';

interface CompetitorDetailCardProps {
  site: CompetitorSite;
  onClose: () => void;
}

export function CompetitorDetailCard({ site, onClose }: CompetitorDetailCardProps) {
  const categoryColor = getCategoryColor(site.category);
  const location = [site.city, site.state].filter(Boolean).join(', ');

  return (
    <div style={{ width: 220, fontSize: 12, lineHeight: 1.4 }}>
      {/* Header — single compact row */}
      <div
        style={{
          backgroundColor: categoryColor,
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <div style={{ color: 'white', minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {site.companyName}
          </div>
          <div style={{ fontSize: 10, opacity: 0.85 }}>{site.category}</div>
        </div>
        <button
          onClick={onClose}
          style={{ color: 'white', background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '6px 8px' }}>
        {/* Badges */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
          {site.status && (
            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#f3f4f6', color: '#4b5563' }}>
              {site.status}
            </span>
          )}
          {site.volteraSegment && (
            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#eff6ff', color: '#2563eb' }}>
              {site.volteraSegment}
            </span>
          )}
        </div>

        {/* Location */}
        {location && <div style={{ color: '#6b7280', marginBottom: 2 }}>{location}</div>}
        {site.msa && <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 4 }}>{site.msa}</div>}

        {/* Key details */}
        {(site.siteAcres || site.zoning || site.totalStalls || site.numChargers) && (
          <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 4, marginTop: 2 }}>
            {site.siteAcres != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#9ca3af' }}>Size</span>
                <span style={{ fontWeight: 500 }}>{site.siteAcres.toFixed(2)} ac</span>
              </div>
            )}
            {site.zoning && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#9ca3af' }}>Zoning</span>
                <span style={{ fontWeight: 500, textAlign: 'right', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{site.zoning}</span>
              </div>
            )}
            {site.totalStalls != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#9ca3af' }}>Stalls</span>
                <span style={{ fontWeight: 500 }}>{site.totalStalls}</span>
              </div>
            )}
            {site.numChargers != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#9ca3af' }}>Chargers</span>
                <span style={{ fontWeight: 500 }}>{site.numChargers}</span>
              </div>
            )}
          </div>
        )}

        {/* Notes — one line */}
        {site.notes && (
          <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 3, marginTop: 4, fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {site.notes}
          </div>
        )}
      </div>
    </div>
  );
}
