import type { Settings } from './types';
import * as settingsApi from '@/lib/api/settings';
import { supabase } from '@/lib/supabase/client';

const STORAGE_KEY = 'rally:settings';

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: '', email: '' },
  notifications: {
    alerts: true,
    sos: true,
    connectivity: true,
    tripSummaries: false,
    soundAlerts: true,
  },
  location: {
    sharing: true,
    accuracy: 'high',
    backgroundTracking: 'while_active',
  },
  safety: {
    alertSensitivity: 'medium',
    separationThresholdM: 150,
    routeDeviationThresholdM: 100,
  },
  appearance: {
    theme: 'dark',
    units: 'Metric',
  },
};

class SettingsService {
  private settings: Settings;
  private listeners = new Set<(settings: Settings) => void>();
  private syncAttempted = false;
  private syncInFlight: Promise<Settings> | null = null;

  constructor() {
    this.settings = this.read();
  }

  private read(): Settings {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) };
    } catch {
      // fall through to defaults
    }
    return DEFAULT_SETTINGS;
  }

  private persist() {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
  }

  async syncWithBackend(): Promise<Settings> {
    if (typeof window === 'undefined') return this.settings;

    // Return in-flight promise to avoid duplicate concurrent syncs
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    this.syncInFlight = (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data?.session) {
          // Unauthenticated: do not hit the backend or trigger 401 redirects
          return this.settings;
        }

        const remote = await settingsApi.getSettings();
        if (remote) {
          this.settings = {
            ...this.settings,
            notifications: {
              ...this.settings.notifications,
              alerts: remote.notifications_alerts,
              sos: remote.notifications_sos,
              connectivity: remote.notifications_connectivity,
              tripSummaries: remote.notifications_trip_summaries,
              soundAlerts: remote.sound_alerts_enabled,
            },
            safety: {
              alertSensitivity: (remote.alert_sensitivity?.toLowerCase() as 'low' | 'medium' | 'high') || 'medium',
              separationThresholdM: remote.separation_threshold_m ?? 150,
              routeDeviationThresholdM: remote.route_deviation_threshold_m ?? 100,
            },
            appearance: {
              theme: remote.theme || 'dark',
              units: remote.units || 'Metric',
            },
            location: {
              ...this.settings.location,
              sharing: remote.location_sharing ?? true,
            },
          };
          this.persist();
          this.listeners.forEach((l) => l(this.settings));
        }
      } catch {
        // Backend not reached or request failed — keep cached settings
      } finally {
        this.syncAttempted = true;
        this.syncInFlight = null;
      }
      return this.settings;
    })();

    return this.syncInFlight;
  }

  get(): Settings {
    return this.settings;
  }

  update(patch: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      notifications: patch.notifications
        ? { ...this.settings.notifications, ...patch.notifications }
        : this.settings.notifications,
      safety: patch.safety
        ? { ...this.settings.safety, ...patch.safety }
        : this.settings.safety,
      appearance: patch.appearance
        ? { ...this.settings.appearance, ...patch.appearance }
        : this.settings.appearance,
      location: patch.location
        ? { ...this.settings.location, ...patch.location }
        : this.settings.location,
    };
    this.persist();
    this.listeners.forEach((l) => l(this.settings));

    // Persist to backend asynchronously
    const backendPatch: settingsApi.UserSettingsUpdate = {};
    if (patch.safety) {
      if (patch.safety.alertSensitivity) {
        backendPatch.alert_sensitivity = patch.safety.alertSensitivity.toUpperCase() as any;
      }
      if (patch.safety.separationThresholdM != null) {
        backendPatch.separation_threshold_m = patch.safety.separationThresholdM;
      }
      if (patch.safety.routeDeviationThresholdM != null) {
        backendPatch.route_deviation_threshold_m = patch.safety.routeDeviationThresholdM;
      }
    }
    if (patch.notifications) {
      if (patch.notifications.alerts !== undefined) {
        backendPatch.notifications_alerts = patch.notifications.alerts;
      }
      if (patch.notifications.sos !== undefined) {
        backendPatch.notifications_sos = patch.notifications.sos;
      }
      if (patch.notifications.connectivity !== undefined) {
        backendPatch.notifications_connectivity = patch.notifications.connectivity;
      }
      if (patch.notifications.tripSummaries !== undefined) {
        backendPatch.notifications_trip_summaries = patch.notifications.tripSummaries;
      }
      if (patch.notifications.soundAlerts !== undefined) {
        backendPatch.sound_alerts_enabled = patch.notifications.soundAlerts;
      }
    }
    if (patch.location?.sharing !== undefined) {
      backendPatch.location_sharing = patch.location.sharing;
    }
    if (patch.appearance?.theme) {
      backendPatch.theme = patch.appearance.theme;
    }
    if (patch.appearance?.units) {
      backendPatch.units = patch.appearance.units;
    }

    if (Object.keys(backendPatch).length > 0) {
      supabase.auth.getSession().then(({ data }) => {
        if (!data?.session) return;
        settingsApi.updateSettings(backendPatch).catch((err) => {
          console.warn('Could not persist settings to backend:', err);
        });
      });
    }

    return this.settings;
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const settingsService = new SettingsService();
