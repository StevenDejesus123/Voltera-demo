import { MapPin, TrendingUp, Download, Eye } from 'lucide-react';

interface LandingPageProps {
  onExplore: () => void;
}

export function LandingPage({ onExplore }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-6">
      <div className="max-w-4xl w-full">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 mb-6">
            <MapPin className="w-12 h-12 text-indigo-600" />
            <h1 className="text-5xl font-bold text-gray-900">Site Ranking Explorer</h1>
          </div>
          
          <h2 className="text-2xl text-gray-700 mb-6">
            Explore AI-ranked regions for EV / AV site expansion
          </h2>
          
          <p className="text-lg text-gray-600 max-w-2xl mx-auto mb-8 leading-relaxed">
            This tool ranks MSAs, counties, and census tracts based on customer demand, 
            infrastructure, risk, and mobility signals. Designed for real estate and strategy 
            teams to make data-driven site selection decisions—without needing Tableau licenses.
          </p>

          <button
            onClick={onExplore}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-lg text-lg font-medium shadow-lg hover:shadow-xl transition-all"
          >
            Explore Rankings
          </button>
        </div>

        {/* What This Replaces */}
        <div className="bg-white rounded-xl shadow-lg p-8 mb-8">
          <h3 className="text-xl font-semibold text-gray-900 mb-6">What This Replaces From Tableau</h3>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-red-400 rounded-full mt-2 flex-shrink-0"></div>
                <div>
                  <p className="font-medium text-gray-700">Heavy dashboards</p>
                  <p className="text-sm text-gray-500">→ Single guided explorer</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-red-400 rounded-full mt-2 flex-shrink-0"></div>
                <div>
                  <p className="font-medium text-gray-700">Filters everywhere</p>
                  <p className="text-sm text-gray-500">→ Left-side controlled filters</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-red-400 rounded-full mt-2 flex-shrink-0"></div>
                <div>
                  <p className="font-medium text-gray-700">Tableau-only sharing</p>
                  <p className="text-sm text-gray-500">→ CSV / GeoJSON / KML downloads</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-red-400 rounded-full mt-2 flex-shrink-0"></div>
                <div>
                  <p className="font-medium text-gray-700">Confusing tooltips</p>
                  <p className="text-sm text-gray-500">→ Clear "Why ranked?" panels</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Key Features */}
        <div className="grid md:grid-cols-3 gap-6">
          <div className="bg-white rounded-lg p-6 shadow-md">
            <Eye className="w-10 h-10 text-indigo-600 mb-4" />
            <h4 className="font-semibold text-gray-900 mb-2">Map-First Exploration</h4>
            <p className="text-sm text-gray-600">
              Interactive map with drill-down from MSA to County to Census Tract
            </p>
          </div>
          
          <div className="bg-white rounded-lg p-6 shadow-md">
            <TrendingUp className="w-10 h-10 text-indigo-600 mb-4" />
            <h4 className="font-semibold text-gray-900 mb-2">Clear Rankings</h4>
            <p className="text-sm text-gray-600">
              Understand why regions rank high with transparent scoring factors
            </p>
          </div>
          
          <div className="bg-white rounded-lg p-6 shadow-md">
            <Download className="w-10 h-10 text-indigo-600 mb-4" />
            <h4 className="font-semibold text-gray-900 mb-2">Easy Export</h4>
            <p className="text-sm text-gray-600">
              Export results in CSV, GeoJSON, or KML/KMZ for sharing with teams
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
