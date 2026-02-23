import { useState } from 'react';
import { X, ChevronRight } from 'lucide-react';
import type { CompetitorSite } from '../types';
import { getCategoryColor } from '../dataLoader/competitorLoader';

interface CompetitorDetailCardProps {
  site: CompetitorSite;
  onClose: () => void;
}

const truncateStyle = {
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

const sectionBorder = {
  borderTop: '1px solid #f3f4f6',
  paddingTop: 4,
  marginTop: 2,
};

const badgeBase = {
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: 3,
};

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
      <span style={{ color: '#9ca3af' }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right', maxWidth: 140, ...truncateStyle }}>
        {value}
      </span>
    </div>
  );
}

function formatCurrency(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toLocaleString()}`;
}

function formatDate(val: string): string {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface KeyDateItem {
  label: string;
  display: string;
}

const footerNoteStyle = {
  borderTop: '1px solid #f3f4f6',
  paddingTop: 3,
  marginTop: 4,
  fontSize: 10,
  color: '#9ca3af',
  ...truncateStyle,
};

function buildKeyDateItems(site: CompetitorSite): KeyDateItem[] {
  // Each entry: [label, raw value, formatter].
  // Null/empty raw values are filtered out automatically.
  const candidates: [string, string | number | null | undefined, (v: string | number) => string][] = [
    ['PSA/Lease Signature', site.psaLeaseSignature, v => formatDate(v as string)],
    ['Initial Inspection Period', site.initialInspectionPeriod, v => `${v} days`],
    ['Initial Earnest Money', site.initialEarnestMoney, v => formatCurrency(v as number)],
    ['Inspection Period Start', site.inspectionPeriodStart, v => formatDate(v as string)],
    ['Inspection Period End', site.inspectionPeriodEnd, v => formatDate(v as string)],
    ['Initial Closing Date', site.initialClosingDate, v => formatDate(v as string)],
    ['IP Extension End Date', site.ipExtensionEndDate, v => formatDate(v as string)],
    ['Outside Closing Date', site.outsideClosingDate, v => formatDate(v as string)],
  ];

  return candidates
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value, formatter]) => ({ label, display: formatter(value!) }));
}

export function CompetitorDetailCard({ site, onClose }: CompetitorDetailCardProps) {
  const categoryColor = getCategoryColor(site.category);
  const [keyDatesOpen, setKeyDatesOpen] = useState(false);

  const headerTitle = site.opportunityName || site.companyName;
  const headerSubtitle = site.opportunityName ? site.companyName : site.category;

  const keyDateItems = buildKeyDateItems(site);
  const hasKeyDates = keyDateItems.length > 0 || !!site.ipExtensionOptionDetails;

  const hasDetails =
    site.siteAcres != null ||
    site.siteSF != null ||
    site.buildingSize != null ||
    site.ahj ||
    site.zoning ||
    site.rePriceTotal != null ||
    site.evChargingStallCount != null ||
    site.totalStalls != null ||
    site.utility;

  const hasTransaction =
    site.purchaser ||
    site.purchaseDate ||
    site.lastSalePrice != null ||
    site.purchasePriceSF != null ||
    site.annualRent != null;

  return (
    <div style={{ width: 260, fontSize: 12, lineHeight: 1.4 }}>
      {/* Header */}
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
          <div style={{ fontWeight: 600, fontSize: 13, ...truncateStyle }}>
            {headerTitle}
          </div>
          <div style={{ fontSize: 10, opacity: 0.85 }}>{headerSubtitle}</div>
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
          {site.volteraSegment && (
            <span style={{ ...badgeBase, background: '#eff6ff', color: '#2563eb' }}>
              {site.volteraSegment}
            </span>
          )}
          {site.customerSegment && site.customerSegment !== site.volteraSegment && (
            <span style={{ ...badgeBase, background: '#f0fdf4', color: '#16a34a' }}>
              {site.customerSegment}
            </span>
          )}
          {site.status && (
            <span style={{ ...badgeBase, background: '#f3f4f6', color: '#4b5563' }}>
              Stage: {site.status}
            </span>
          )}
        </div>

        {/* Key details */}
        {hasDetails && (
          <div style={sectionBorder}>
            {site.siteAcres != null && (
              <DetailRow label="Size" value={`${site.siteAcres.toFixed(2)} ac`} />
            )}
            {site.siteSF != null && (
              <DetailRow label="Site (SF)" value={site.siteSF.toLocaleString()} />
            )}
            {site.buildingSize != null && (
              <DetailRow label="Building Size" value={site.buildingSize.toLocaleString()} />
            )}
            {site.ahj && <DetailRow label="AHJ" value={site.ahj} />}
            {site.zoning && <DetailRow label="Zoning" value={site.zoning} />}
            {site.rePriceTotal != null && (
              <DetailRow label="RE Price (Total)" value={formatCurrency(site.rePriceTotal)} />
            )}
            {site.evChargingStallCount != null && (
              <DetailRow label="EV Stall Count" value={site.evChargingStallCount} />
            )}
            {site.totalStalls != null && site.totalStalls !== site.evChargingStallCount && (
              <DetailRow label="Total Stalls" value={site.totalStalls} />
            )}
            {site.utility && <DetailRow label="Utility" value={site.utility} />}
          </div>
        )}

        {/* Charger info */}
        {(site.numChargers != null || site.chargerSize) && (
          <div style={sectionBorder}>
            {site.numChargers != null && <DetailRow label="Chargers" value={site.numChargers} />}
            {site.chargerSize && <DetailRow label="Charger Power" value={site.chargerSize} />}
          </div>
        )}

        {/* Transaction info (CSV-sourced) */}
        {hasTransaction && (
          <div style={sectionBorder}>
            {site.purchaser && <DetailRow label="Purchaser" value={site.purchaser} />}
            {site.purchaseDate && <DetailRow label="Purchase Date" value={site.purchaseDate} />}
            {site.lastSalePrice != null && (
              <DetailRow label="Last Sale Price" value={formatCurrency(site.lastSalePrice)} />
            )}
            {site.purchasePriceSF != null && (
              <DetailRow label="Price/SF" value={formatCurrency(site.purchasePriceSF)} />
            )}
            {site.annualRent != null && (
              <DetailRow label="Annual Rent" value={formatCurrency(site.annualRent)} />
            )}
          </div>
        )}

        {/* Target Go-Live */}
        {site.targetGoLive && (
          <div style={sectionBorder}>
            <DetailRow label="Target Go-Live" value={site.targetGoLive} />
          </div>
        )}

        {/* Key Dates — collapsible, default minimized */}
        {hasKeyDates && (
          <div style={{ borderTop: '1px solid #f3f4f6', marginTop: 4 }}>
            <button
              onClick={() => setKeyDatesOpen(!keyDatesOpen)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 0',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
                color: '#6b7280',
              }}
            >
              <span>Key Dates</span>
              <ChevronRight
                size={12}
                style={{
                  transition: 'transform 150ms ease',
                  transform: keyDatesOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                }}
              />
            </button>
            {keyDatesOpen && (
              <div style={{ paddingBottom: 2 }}>
                {keyDateItems.map(d => (
                  <DetailRow key={d.label} label={d.label} value={d.display} />
                ))}
                {site.ipExtensionOptionDetails && (
                  <div style={{ fontSize: 10, color: '#6b7280', paddingTop: 3, marginTop: 2, borderTop: '1px solid #f3f4f6' }}>
                    <span style={{ color: '#9ca3af' }}>IP Extension Details: </span>
                    {site.ipExtensionOptionDetails}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Amenity Notes */}
        {site.amenityNotes && (
          <div style={footerNoteStyle}>{site.amenityNotes}</div>
        )}

        {/* Notes */}
        {site.notes && site.notes !== site.opportunityName && (
          <div style={footerNoteStyle}>{site.notes}</div>
        )}
      </div>
    </div>
  );
}
