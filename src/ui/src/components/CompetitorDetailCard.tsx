import { X, Building2, MapPin, Zap, DollarSign, Calendar, FileText } from 'lucide-react';
import type { CompetitorSite } from '../types';
import { getCategoryColor } from '../dataLoader/competitorLoader';

interface CompetitorDetailCardProps {
  site: CompetitorSite;
  onClose: () => void;
}

const formatCurrency = (val: number | null): string => {
  if (val === null) return 'N/A';
  if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `$${(val / 1000).toFixed(0)}K`;
  return `$${val.toLocaleString()}`;
};

const formatNumber = (val: number | null, suffix = ''): string => {
  if (val === null) return 'N/A';
  return `${val.toLocaleString()}${suffix}`;
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between py-1.5 border-b border-gray-100 last:border-0">
    <span className="text-sm text-gray-600">{label}</span>
    <span className="text-sm font-medium text-gray-900">{value || 'N/A'}</span>
  </div>
);

export function CompetitorDetailCard({ site, onClose }: CompetitorDetailCardProps) {
  const categoryColor = getCategoryColor(site.category);

  return (
    <div className="bg-white rounded-lg shadow-xl border border-gray-200 w-80 max-h-[80vh] overflow-hidden flex flex-col">
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ backgroundColor: categoryColor }}
      >
        <div className="flex items-center gap-2 text-white">
          <Building2 className="w-5 h-5" />
          <div>
            <h3 className="font-semibold text-lg leading-tight">{site.companyName}</h3>
            <span className="text-sm opacity-90">{site.category}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-white hover:bg-white/20 p-1 rounded transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Status Badge */}
        {site.status && (
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-1 text-xs font-medium rounded-full ${
                site.status === 'Confirmed'
                  ? 'bg-green-100 text-green-700'
                  : site.status === 'Interest'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              {site.status}
            </span>
            {site.volteraSegment && (
              <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-700">
                {site.volteraSegment}
              </span>
            )}
          </div>
        )}

        {/* Location Section */}
        <div>
          <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
            <MapPin className="w-4 h-4" />
            Location
          </h4>
          <div className="bg-gray-50 rounded-lg p-3">
            {site.address && <p className="text-sm text-gray-900">{site.address}</p>}
            <p className="text-sm text-gray-600">
              {[site.city, site.state].filter(Boolean).join(', ')}
            </p>
            {site.msa && <p className="text-xs text-gray-500 mt-1">MSA: {site.msa}</p>}
            {site.zoning && <p className="text-xs text-gray-500">Zoning: {site.zoning}</p>}
          </div>
        </div>

        {/* Infrastructure Section */}
        {(site.totalStalls || site.numChargers || site.chargerSize) && (
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
              <Zap className="w-4 h-4" />
              Infrastructure
            </h4>
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              <DetailRow label="Total Stalls" value={formatNumber(site.totalStalls)} />
              <DetailRow label="# of Chargers" value={formatNumber(site.numChargers)} />
              {site.chargerSize && <DetailRow label="Charger Size" value={site.chargerSize} />}
            </div>
          </div>
        )}

        {/* Site Details Section */}
        {(site.siteAcres || site.siteSF || site.buildingSize) && (
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
              <Building2 className="w-4 h-4" />
              Site Details
            </h4>
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              {site.siteAcres && <DetailRow label="Site Size" value={`${site.siteAcres.toFixed(2)} acres`} />}
              {site.siteSF && <DetailRow label="Site SF" value={formatNumber(site.siteSF, ' SF')} />}
              {site.buildingSize && <DetailRow label="Building Size" value={formatNumber(site.buildingSize, ' SF')} />}
            </div>
          </div>
        )}

        {/* Financial Section */}
        {(site.lastSalePrice || site.purchasePriceSF || site.annualRent) && (
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
              <DollarSign className="w-4 h-4" />
              Financial
            </h4>
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              {site.lastSalePrice && <DetailRow label="Sale Price" value={formatCurrency(site.lastSalePrice)} />}
              {site.purchasePriceSF && <DetailRow label="Price/SF" value={formatCurrency(site.purchasePriceSF)} />}
              {site.annualRent && <DetailRow label="Annual Rent" value={formatCurrency(site.annualRent)} />}
              {site.purchaseDate && <DetailRow label="Purchase Date" value={site.purchaseDate} />}
            </div>
          </div>
        )}

        {/* Timeline Section */}
        {site.targetGoLive && (
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
              <Calendar className="w-4 h-4" />
              Timeline
            </h4>
            <div className="bg-gray-50 rounded-lg p-3">
              <DetailRow label="Target Go-Live" value={site.targetGoLive} />
            </div>
          </div>
        )}

        {/* Notes Section */}
        {(site.notes || site.amenityNotes) && (
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1">
              <FileText className="w-4 h-4" />
              Notes
            </h4>
            <div className="bg-gray-50 rounded-lg p-3">
              {site.amenityNotes && (
                <p className="text-sm text-gray-700 mb-2">
                  <span className="font-medium">Amenities:</span> {site.amenityNotes}
                </p>
              )}
              {site.notes && (
                <p className="text-sm text-gray-600 whitespace-pre-line">{site.notes}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
