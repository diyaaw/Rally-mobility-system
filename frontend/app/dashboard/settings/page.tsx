'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { X, LogOut, Check, Volume2, ShieldAlert } from 'lucide-react';
import Topbar from '@/components/dashboard/Topbar';
import Toggle from '@/components/dashboard/Toggle';
import { useGroup } from '@/hooks/useGroup';
import { useSettings } from '@/lib/mock/useSettings';
import { useTheme } from '@/lib/theme/ThemeProvider';
import { groupService } from '@/lib/group/groupService';
import { supabase } from '@/lib/supabase';
import { updateMe } from '@/lib/api/auth';
import { playChime } from '@/lib/audio/alertSound';
import { createPortal } from 'react-dom';
import RequireAuth from '@/components/dashboard/RequireAuth';

export default function SettingsPage() {
  const router = useRouter();
  const { group } = useGroup();
  const { settings, update } = useSettings();
  const { theme, setTheme } = useTheme();

  const [actualName, setActualName] = useState(settings.profile.name);
  const [actualEmail, setActualEmail] = useState(settings.profile.email);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setActualEmail(user.email || '');
        setActualName(user.user_metadata?.full_name || user.user_metadata?.name || 'User');
      }
    });
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    groupService.leaveGroup();
    router.push('/login');
  };

  const handleSaveProfile = async () => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditError('Display name cannot be empty.');
      return;
    }
    if (trimmed.length > 50) {
      setEditError('Display name is too long.');
      return;
    }
    setEditError('');
    setIsSaving(true);
    
    const { error } = await supabase.auth.updateUser({
      data: { full_name: trimmed }
    });

    try {
      await updateMe({ full_name: trimmed });
    } catch (apiErr) {
      console.warn('Backend profile update deferred:', apiErr);
    }

    setIsSaving(false);

    if (error) {
      setEditError('Unable to save changes. Please try again.');
    } else {
      setActualName(trimmed);
      update({ profile: { ...settings.profile, name: trimmed } });
      setIsEditModalOpen(false);
      showToast('Profile updated');
    }
  };

  const handleLocationManage = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        () => showToast('Location permission granted'),
        () => showToast('Location permission denied or unavailable')
      );
    } else {
      showToast('Geolocation not supported by this browser');
    }
  };

  return (
    <RequireAuth>
      <div className="min-h-screen flex flex-col bg-background relative pb-8">
      <Topbar group={group} />

      <div className="flex-1 p-4 md:p-6 lg:p-8 space-y-8 max-w-2xl mx-auto w-full">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your account and RALLY preferences</p>
        </div>

        {/* ACCOUNT */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">Account</h2>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-rally-blue/15 border border-rally-blue/30 text-rally-blue font-bold flex items-center justify-center text-lg shrink-0">
                  {actualName ? actualName.charAt(0).toUpperCase() : 'U'}
                </div>
                <div>
                  <p className="text-base font-bold text-foreground">{actualName}</p>
                  <p className="text-sm text-muted-foreground">{actualEmail}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setEditName(actualName);
                  setEditError('');
                  setIsEditModalOpen(true);
                }}
                className="px-4 py-2 rounded-lg bg-muted/60 border border-border text-xs font-semibold text-foreground hover:bg-muted transition-colors shrink-0 w-full sm:w-auto"
              >
                Edit Profile
              </button>
            </div>
          </div>
        </section>

        {/* PRIVACY & LOCATION */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">Privacy & Location</h2>
          <div className="rounded-2xl border border-border bg-card divide-y divide-border">
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Location Sharing</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {settings.location.sharing 
                    ? 'Shared with current RALLY members'
                    : 'Location sharing is disabled'}
                </p>
              </div>
              <Toggle
                checked={settings.location.sharing}
                onChange={(v) => {
                  update({ location: { ...settings.location, sharing: v } });
                  showToast(v ? 'Location sharing enabled' : 'Location sharing disabled');
                }}
                label="Location Sharing"
              />
            </div>
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Location Permission</p>
                <p className="text-xs text-muted-foreground mt-1">Manage browser GPS access</p>
              </div>
              <button
                onClick={handleLocationManage}
                className="px-4 py-2 rounded-lg bg-muted/60 border border-border text-xs font-semibold text-foreground hover:bg-muted transition-colors shrink-0"
              >
                Manage
              </button>
            </div>
          </div>
        </section>

        {/* SAFETY & INTELLIGENCE THRESHOLDS */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">
              Safety & Intelligence Thresholds
            </h2>
            <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded">
              Synced with backend
            </span>
          </div>
          <div className="rounded-2xl border border-border bg-card divide-y divide-border">
            {/* Alert Sensitivity */}
            <div className="p-5 flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row">
              <div>
                <p className="text-sm font-semibold text-foreground">Alert Sensitivity</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Controls how quickly deviations and separations trigger notifications
                </p>
              </div>
              <div className="flex bg-background border border-border rounded-lg p-1 shrink-0">
                {(['low', 'medium', 'high'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => {
                      update({ safety: { ...settings.safety, alertSensitivity: lvl } });
                      showToast(`Sensitivity set to ${lvl}`);
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold capitalize transition-colors ${
                      settings.safety.alertSensitivity === lvl
                        ? 'bg-rally-blue text-white'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            {/* Separation Threshold */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Separation Threshold</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Maximum allowed distance before a member is marked as falling behind
                  </p>
                </div>
                <span className="text-xs font-mono font-bold text-rally-blue bg-rally-blue/10 px-2.5 py-1 rounded-md">
                  {settings.safety.separationThresholdM} m
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={500}
                step={25}
                value={settings.safety.separationThresholdM}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  update({ safety: { ...settings.safety, separationThresholdM: val } });
                }}
                className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-rally-blue"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>50m (Strict)</span>
                <span>250m</span>
                <span>500m (Relaxed)</span>
              </div>
            </div>

            {/* Route Deviation Threshold */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Route Deviation Threshold</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Distance off the planned route before triggering an off-route alert
                  </p>
                </div>
                <span className="text-xs font-mono font-bold text-rally-blue bg-rally-blue/10 px-2.5 py-1 rounded-md">
                  {settings.safety.routeDeviationThresholdM} m
                </span>
              </div>
              <input
                type="range"
                min={30}
                max={300}
                step={10}
                value={settings.safety.routeDeviationThresholdM}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  update({ safety: { ...settings.safety, routeDeviationThresholdM: val } });
                }}
                className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-rally-blue"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>30m (Strict)</span>
                <span>150m</span>
                <span>300m (Relaxed)</span>
              </div>
            </div>
          </div>
        </section>

        {/* NOTIFICATIONS */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">Notifications</h2>
          <div className="rounded-2xl border border-border bg-card divide-y divide-border">
            {/* RALLY Alerts */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">RALLY Safety Alerts</p>
                <p className="text-xs text-muted-foreground mt-1">Real-time alerts for separation, stops, and deviations</p>
              </div>
              <Toggle
                checked={settings.notifications.alerts}
                onChange={(v) => {
                  update({ notifications: { ...settings.notifications, alerts: v } });
                  showToast('Preferences saved');
                }}
                label="RALLY Alerts"
              />
            </div>

            {/* Emergency SOS Alerts */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Emergency SOS Notifications</p>
                <p className="text-xs text-muted-foreground mt-1">Critical alerts when a member activates one-tap SOS</p>
              </div>
              <Toggle
                checked={settings.notifications.sos}
                onChange={(v) => {
                  update({ notifications: { ...settings.notifications, sos: v } });
                  showToast('Preferences saved');
                }}
                label="SOS Notifications"
              />
            </div>

            {/* Connectivity Alerts */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Connectivity & Signal Alerts</p>
                <p className="text-xs text-muted-foreground mt-1">Notifications when member telemetry or GPS is interrupted</p>
              </div>
              <Toggle
                checked={settings.notifications.connectivity}
                onChange={(v) => {
                  update({ notifications: { ...settings.notifications, connectivity: v } });
                  showToast('Preferences saved');
                }}
                label="Connectivity Alerts"
              />
            </div>

            {/* Trip Summaries */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Trip Summaries</p>
                <p className="text-xs text-muted-foreground mt-1">Summary report notifications after a trip completes</p>
              </div>
              <Toggle
                checked={settings.notifications.tripSummaries}
                onChange={(v) => {
                  update({ notifications: { ...settings.notifications, tripSummaries: v } });
                  showToast('Preferences saved');
                }}
                label="Trip Summaries"
              />
            </div>

            {/* Audio Alerts */}
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">Audible Safety Chimes</p>
                  <button
                    type="button"
                    onClick={() => {
                      playChime();
                      showToast('Played test chime');
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-rally-blue hover:underline bg-rally-blue/10 px-2 py-0.5 rounded"
                  >
                    <Volume2 className="w-3 h-3" /> Test Sound
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Synthesized chimes for standard alerts and urgent sirens for SOS
                </p>
              </div>
              <Toggle
                checked={settings.notifications.soundAlerts ?? true}
                onChange={(v) => {
                  update({ notifications: { ...settings.notifications, soundAlerts: v } });
                  showToast(v ? 'Audio alerts enabled' : 'Audio alerts muted');
                }}
                label="Audible Safety Chimes"
              />
            </div>
          </div>
        </section>

        {/* PREFERENCES */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">Preferences</h2>
          <div className="rounded-2xl border border-border bg-card divide-y divide-border">
            <div className="p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Theme</p>
                <p className="text-xs text-muted-foreground mt-0.5">Customize interface appearance</p>
              </div>
              <div className="flex bg-muted/60 border border-border rounded-lg p-1" role="group" aria-label="Theme selector">
                {(['dark', 'light', 'system'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTheme(t);
                      showToast(`Switched to ${t} mode`);
                    }}
                    aria-pressed={theme === t}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold capitalize transition-all ${
                      theme === t
                        ? 'bg-rally-blue text-white shadow-sm font-bold'
                        : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-5 flex items-center justify-between gap-4">
              <p className="text-sm font-semibold text-foreground">Units</p>
              <div className="flex bg-background border border-border rounded-lg p-1">
                {(['Metric', 'Imperial'] as const).map((u) => (
                  <button
                    key={u}
                    onClick={() => {
                      update({ appearance: { ...settings.appearance, units: u } });
                      showToast('Preferences saved');
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                      settings.appearance.units === u
                        ? 'bg-rally-blue text-white'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ABOUT */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-bold text-muted-foreground/60 tracking-[0.15em] uppercase">About</h2>
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-bold text-foreground">RALLY</p>
            <p className="text-xs text-muted-foreground mt-1 mb-3">AI-powered group travel safety and coordination platform.</p>
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <span>Version 1.0.0</span>
              <span>·</span>
              <span className="hover:text-foreground transition-colors cursor-pointer">Privacy</span>
              <span>·</span>
              <span className="hover:text-foreground transition-colors cursor-pointer">About</span>
            </div>
          </div>
        </section>

        <section className="pt-2">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm font-bold hover:bg-red-500/20 transition-colors"
          >
            <LogOut className="w-4 h-4" /> Log Out
          </button>
        </section>
      </div>

      {/* Edit Profile Modal */}
      {isEditModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-xl p-6 relative animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-lg font-bold text-foreground mb-4">Edit Profile</h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-muted-foreground/80 tracking-wider uppercase mb-1.5 block">
                  Display Name
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={isSaving}
                  className="w-full bg-background border border-border rounded-xl px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-rally-blue transition-colors"
                />
              </div>
              
              <div>
                <label className="text-xs font-bold text-muted-foreground/80 tracking-wider uppercase mb-1.5 block">
                  Avatar
                </label>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-rally-blue/15 border border-rally-blue/30 text-rally-blue font-bold flex items-center justify-center text-lg">
                    {editName ? editName.charAt(0).toUpperCase() : 'U'}
                  </div>
                  <button type="button" disabled className="px-3 py-1.5 rounded-lg bg-muted border border-border text-xs font-semibold text-muted-foreground cursor-not-allowed">
                    Upload / Change
                  </button>
                </div>
              </div>

              {editError && (
                <p className="text-sm font-medium text-red-400">{editError}</p>
              )}
            </div>

            <div className="flex items-center gap-3 mt-8">
              <button
                onClick={() => setIsEditModalOpen(false)}
                disabled={isSaving}
                className="flex-1 px-4 py-2.5 rounded-xl border border-border text-foreground text-sm font-bold hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={isSaving}
                className="flex-1 px-4 py-2.5 rounded-xl bg-rally-blue text-white text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      {toastMessage && createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="bg-foreground text-background px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2">
            <Check className="w-4 h-4" />
            <span className="text-sm font-semibold">{toastMessage}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
    </RequireAuth>
  );
}
