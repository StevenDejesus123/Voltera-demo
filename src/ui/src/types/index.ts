export type GeoLevel = 'MSA' | 'County' | 'Tract';
export type Segment = 'AV' | 'Non-AV';

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export interface RegionDetails {
  // Common fields
  population?: number;
  populationDensity?: number;
  rideshareTrips?: number;
  electricityPrice?: number;
  landValue?: number;
  precipitation?: number;

  // MSA-level fields
  evStationCount?: number;
  airportCount?: number;
  avTestingCount?: number;
  stateFundingCount?: number;
  federalFundingAmount?: number;
  ridesharePerCapita?: number;
  medianIncome?: number;
  snowdays?: number;
  temperature?: number;
  hurricaneRisk?: number;

  // County-level fields
  avTestingVehicles?: number;
  avTestingParticipants?: string[];
  areaSqrtMiles?: number;
  publicTransitPct?: number;
  stormRisk?: number;

  // Tract-level fields
  rideshareDensity?: number;
  gasPrice?: number;
  avgWeeklyWage?: number;
  evStationCountMSA?: number;
  snowdaysMSA?: number;
  temperatureMSA?: number;
  earthquakeRisk?: number;
}

export interface Region {
  id: string;
  name: string;
  geoLevel: GeoLevel;
  rank: number;
  score: number;
  customerCount: number;
  inGeofence: boolean;
  lat: number;
  lng: number;
  factors: Factor[];
  details?: RegionDetails;
  countyID?: string;
  msaID?: string;
  msaName?: string;
}

export interface Factor {
  name: string;
  impact: 'high' | 'medium' | 'low';
  description: string;
}

export interface SavedView {
  id: string;
  name: string;
  description: string;
  segment: Segment;
  rankingThreshold: number;
  minProbability: number;
  createdAt: Date;
}

export interface WhatIfScenario {
  id: string;
  name: string;
  evStations: number;
  chargingSpeed: 'fast' | 'standard';
  scoreImpact: number; // percentage increase
}

// Market Intelligence / Competitor Tracker types
export type CompetitorCategory = 'Voltera' | 'Customer' | 'Competitor' | 'Interest' | 'Unknown';

export interface CompetitorSite {
  id: string;
  companyName: string;
  category: CompetitorCategory;
  status: string;
  volteraSegment: string;
  customerSegment: string;
  msa: string;
  address: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  siteAcres: number | null;
  siteSF: number | null;
  buildingSize: number | null;
  purchaser: string;
  purchaseDate: string;
  lastSalePrice: number | null;
  purchasePriceSF: number | null;
  annualRent: number | null;
  zoning: string;
  totalStalls: number | null;
  numChargers: number | null;
  chargerSize: string;
  amenityNotes: string;
  targetGoLive: string;
  notes: string;
  source: string;
}

export interface CompetitorFilters {
  companies: string[];
  categories: string[];
  statuses: string[];
  msas: string[];
  cities: string[];
  states: string[];
}

export interface CompetitorTrackerData {
  sites: CompetitorSite[];
  filters: CompetitorFilters;
  stats: {
    totalSites: number;
    sitesWithCoords: number;
    companiesCount: number;
    pipelineSites?: number;
  };
}

// Salesforce MSA Summary types
export interface SalesforceMSASummary {
  msa: string;
  accounts: string[];
  accountCount: number;
  opportunityCount: number;
  siteCount: number;
}

export interface SalesforceData {
  msaSummaries: Record<string, SalesforceMSASummary>;
  stats: {
    salesOpportunities: number;
    reOpportunities: number;
    pipelineSites: number;
    msaCount: number;
  };
  lastUpdated: string;
  error?: string;
}