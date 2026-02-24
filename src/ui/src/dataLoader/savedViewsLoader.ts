import type { SavedView } from '../types';

const STORAGE_KEY = 'ev-site-selection:saved-views';

/**
 * Load saved views from localStorage.
 * Handles date deserialization.
 */
export function loadSavedViews(): SavedView[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const views = JSON.parse(stored) as SavedView[];
    // Deserialize dates
    return views.map(v => ({
      ...v,
      createdAt: new Date(v.createdAt),
    }));
  } catch (err) {
    console.error('Failed to load saved views:', err);
    return [];
  }
}

/**
 * Save views array to localStorage.
 */
export function saveSavedViews(views: SavedView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch (err) {
    console.error('Failed to save views:', err);
  }
}

/**
 * Add a new saved view.
 * Generates ID and timestamp automatically.
 */
export function addSavedView(view: Omit<SavedView, 'id' | 'createdAt'>): SavedView {
  const views = loadSavedViews();
  const newView: SavedView = {
    ...view,
    id: `view-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date(),
  };
  views.push(newView);
  saveSavedViews(views);
  return newView;
}

/**
 * Delete a saved view by ID.
 */
export function deleteSavedView(id: string): void {
  const views = loadSavedViews();
  const filtered = views.filter(v => v.id !== id);
  saveSavedViews(filtered);
}
