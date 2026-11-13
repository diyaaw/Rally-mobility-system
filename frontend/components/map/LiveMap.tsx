'use client';

/**
 * LiveMap – Google Maps implementation for RALLY.
 *
 * Props are intentionally identical to the old Leaflet LiveMap so every
 * existing caller (route/page.tsx, trip/page.tsx, etc.) keeps working
 * without any changes.
 *
 * When NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set the component shows a
 * clear, user-friendly "configure your API key" banner instead of crashing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

const OsmLiveMap = dynamic(() => import('./OsmLiveMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full min-h-[420px] rounded-2xl border border-border bg-[#0A0A0A] flex flex-col items-center justify-center text-muted-foreground gap-3">
      <div className="w-8 h-8 border-2 border-rally-blue border-t-transparent rounded-full animate-spin" />
      <p className="text-sm font-medium">Initializing live map…</p>
    </div>
  ),
});
import {
  APIProvider,
  Map as GoogleMap,
  AdvancedMarker,
  Pin,
  useMap,
  InfoWindow,
  useApiLoadingStatus,
  APILoadingStatus,
} from '@vis.gl/react-google-maps';
import { LocateFixed, Plus, Minus, Maximize, Route as RouteIcon, AlertTriangle, MapPin } from 'lucide-react';
import type { AlertItem, Group } from '@/lib/mock/types';
import { STATUS_STYLE } from '@/components/dashboard/status';
import { hasGoogleMapsKey, GOOGLE_MAPS_API_KEY } from '@/lib/services/googleMaps';
import { rallyGroupService } from '@/lib/realtime/RallyGroupService';
import type { ConnectionStatus, ServerMessage } from '@/lib/ws/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RouteAlt {
  id: string;
  coordinates: { lat: number; lng: number }[];
  selected: boolean;
}

interface LiveMapProps {
  group?: Group;
  showStart?: boolean;
  alerts?: AlertItem[];
  route?: Array<{ lat: number; lng: number }> | Array<[number, number]> | null;
  routeAlternatives?: RouteAlt[];
  onRouteSelect?: (id: string) => void;
  customDestination?: { lat: number; lng: number; name: string };
  /** When true or when route is null/absent, shows a prompt/button ("Set Destination") */
  showNoRoutePrompt?: boolean;
  onSetDestination?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useDeviceLocation() {
  const [loc, setLoc] = useState<google.maps.LatLngLiteral | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (p) => setLoc({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);
  return loc;
}

// ─── Inner map content (needs to be a child of <APIProvider>) ────────────────

function MapContent({
  group,
  showStart,
  alerts,
  route,
  routeAlternatives,
  onRouteSelect,
  customDestination,
  deviceLoc,
  showNoRoutePrompt,
  onSetDestination,
}: LiveMapProps & { deviceLoc: google.maps.LatLngLiteral | null }) {
  const router = useRouter();
  const map = useMap();
  const [showRoute, setShowRoute] = useState(true);
  const [activePopup, setActivePopup] = useState<string | null>(null);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  // ── Real-time member locations & socket connection ────────────────────────
  const [livePositions, setLivePositions] = useState<
    Map<string, { lat: number; lng: number; speedKmh?: number; headingDeg?: number; updatedAt: number }>
  >(new Map());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('DISCONNECTED');

  useEffect(() => {
    const unsubStatus = rallyGroupService.subscribeConnectionStatus((status) => {
      setConnectionStatus(status);
    });

    const unsubMessages = rallyGroupService.subscribeMessages((msg: ServerMessage) => {
      try {
        if (msg.type === 'location_update') {
          const payload: any = (msg as any).data || msg;
          const userId = payload.user_id || payload.userId;
          if (!userId) return;

          const lat = typeof payload.latitude === 'number' ? payload.latitude : parseFloat(payload.latitude);
          const lng = typeof payload.longitude === 'number' ? payload.longitude : parseFloat(payload.longitude);

          // Gracefully validate coordinates (ignore NaN, Inf, Null Island (0,0), out of bounds)
          if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lng) ||
            (lat === 0 && lng === 0) ||
            lat < -90 ||
            lat > 90 ||
            lng < -180 ||
            lng > 180
          ) {
            return;
          }

          const rawSpeed = payload.speed != null ? Number(payload.speed) : undefined;
          const rawHeading = payload.heading != null ? Number(payload.heading) : undefined;

          setLivePositions((prev) => {
            const next = new Map(prev);
            next.set(userId, {
              lat,
              lng,
              speedKmh: rawSpeed != null && Number.isFinite(rawSpeed) ? Math.round(rawSpeed * 3.6) : undefined,
              headingDeg: rawHeading != null && Number.isFinite(rawHeading) ? rawHeading : undefined,
              updatedAt: Date.now(),
            });
            return next;
          });
        }
      } catch (err) {
        console.warn('LiveMap: Failed to parse incoming WebSocket location update:', err);
      }
    });

    return () => {
      unsubStatus();
      unsubMessages();
    };
  }, []);

  // Consolidate route alternatives from explicit alternatives, direct route prop, or group route
  const effectiveRouteAlts = useMemo<RouteAlt[]>(() => {
    if (routeAlternatives && routeAlternatives.length > 0) {
      return routeAlternatives;
    }
    if (route && Array.isArray(route) && route.length > 0) {
      const coords: google.maps.LatLngLiteral[] = route.map((pt: any) => {
        if (Array.isArray(pt)) {
          return { lat: pt[0], lng: pt[1] };
        }
        return { lat: pt.lat, lng: pt.lng };
      });
      return [{ id: 'active', coordinates: coords, selected: true }];
    }
    if (group?.route && group.route.length > 0) {
      return [{ id: 'active', coordinates: group.route, selected: true }];
    }
    return [];
  }, [routeAlternatives, route, group?.route]);

  const hasRoute = effectiveRouteAlts.length > 0;
  const isRouteNull = route === null;
  const shouldShowNoRoutePrompt = isRouteNull || Boolean(showNoRoutePrompt && !hasRoute);

  const handleSetDestination = () => {
    if (onSetDestination) {
      onSetDestination();
    } else {
      router.push('/dashboard/route');
    }
  };

  // Merge live WebSocket positions onto group members and filter out invalid/uninitialized markers
  const effectiveMembers = useMemo(() => {
    if (!group?.members) return [];
    return group.members
      .map((m) => {
        const live = livePositions.get(m.id);
        if (live) {
          return {
            ...m,
            lat: live.lat,
            lng: live.lng,
            speedKmh: live.speedKmh ?? m.speedKmh,
            headingDeg: live.headingDeg ?? m.headingDeg,
          };
        }
        return m;
      })
      .filter(
        (m) =>
          Number.isFinite(m.lat) &&
          Number.isFinite(m.lng) &&
          (m.lat !== 0 || m.lng !== 0) &&
          m.lat >= -90 &&
          m.lat <= 90 &&
          m.lng >= -180 &&
          m.lng <= 180
      );
  }, [group?.members, livePositions]);

  const validMembers = effectiveMembers;

  const destLat = customDestination ? customDestination.lat : (group?.destinationLat ?? 0);
  const destLng = customDestination ? customDestination.lng : (group?.destinationLng ?? 0);
  const destName = customDestination ? customDestination.name : (group?.destination ?? 'Destination');
  const hasDestination = destLat !== 0 || destLng !== 0;

  // Centre: prefer device location, then group members, then destination
  const center: google.maps.LatLngLiteral =
    deviceLoc ??
    (validMembers.length
      ? {
          lat: validMembers.reduce((s, m) => s + m.lat, 0) / validMembers.length,
          lng: validMembers.reduce((s, m) => s + m.lng, 0) / validMembers.length,
        }
      : hasDestination
      ? { lat: destLat, lng: destLng }
      : { lat: 19.076, lng: 72.8777 }); // Mumbai default

  const onRouteSelectRef = useRef(onRouteSelect);
  onRouteSelectRef.current = onRouteSelect;
  const lastFittedRouteRef = useRef<string>('');

  // ── Draw route polylines ──────────────────────────────────────────────────

  useEffect(() => {
    if (!map) return;

    // Clear old polylines
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    if (!showRoute || !effectiveRouteAlts.length) return;

    effectiveRouteAlts.forEach((alt) => {
      const line = new google.maps.Polyline({
        path:         alt.coordinates,
        strokeColor:  alt.selected ? '#19BFFF' : '#6B7280',
        strokeWeight: alt.selected ? 5 : 4,
        strokeOpacity: alt.selected ? 1 : 0.6,
        map,
      });
      line.addListener('click', () => onRouteSelectRef.current?.(alt.id));
      polylinesRef.current.push(line);
    });

    return () => {
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [map, effectiveRouteAlts, showRoute]);

  // ── Fit bounds whenever route geometry actually changes ───────────────────

  const routeSignature = useMemo(() => {
    return effectiveRouteAlts.map((a) => `${a.id}:${a.coordinates.length}:${a.coordinates[0]?.lat},${a.coordinates[0]?.lng}:${a.coordinates[a.coordinates.length - 1]?.lat}`).join(';');
  }, [effectiveRouteAlts]);

  useEffect(() => {
    if (!map || !effectiveRouteAlts.length) return;
    if (lastFittedRouteRef.current === routeSignature) return;
    lastFittedRouteRef.current = routeSignature;

    const bounds = new google.maps.LatLngBounds();
    effectiveRouteAlts.forEach((alt) => alt.coordinates.forEach((c) => bounds.extend(c)));
    if (deviceLoc) bounds.extend(deviceLoc);
    if (hasDestination) bounds.extend({ lat: destLat, lng: destLng });
    if (!bounds.isEmpty()) map.fitBounds(bounds, 60);
  }, [map, effectiveRouteAlts, routeSignature, deviceLoc, hasDestination, destLat, destLng]);

  // ── Fit bounds on first mount if no routes ────────────────────────────────

  useEffect(() => {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    validMembers.forEach((m) => bounds.extend({ lat: m.lat, lng: m.lng }));
    if (hasDestination) bounds.extend({ lat: destLat, lng: destLng });
    if (deviceLoc) bounds.extend(deviceLoc);
    if (!bounds.isEmpty() && bounds.getNorthEast()?.toString() !== bounds.getSouthWest()?.toString()) {
      map.fitBounds(bounds, 70);
    } else {
      map.setCenter(center);
      map.setZoom(15);
    }
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-pan to device location the first time GPS resolves ──────────────

  const didCentreRef = useRef(false);
  useEffect(() => {
    if (!map || !deviceLoc || didCentreRef.current) return;
    // Only do this if there are no group members with live positions yet,
    // so we don't override a multi-member bounds fit.
    const hasLiveMembers = validMembers.some((m) => m.lat !== 0 && m.lng !== 0);
    if (!hasLiveMembers) {
      map.panTo(deviceLoc);
      map.setZoom(16);
      didCentreRef.current = true;
    }
  }, [map, deviceLoc, validMembers]);

  // ── Control handlers ─────────────────────────────────────────────────────

  const handleLocateMe = useCallback(() => {
    if (!map) return;
    const me = effectiveMembers.find((m) => m.isCurrentUser);
    if (me && me.lat !== 0 && me.lng !== 0) {
      map.panTo({ lat: me.lat, lng: me.lng });
      map.setZoom(16);
    } else if (deviceLoc) {
      map.panTo(deviceLoc);
      map.setZoom(16);
    }
  }, [map, effectiveMembers, deviceLoc]);

  const handleFitGroup = useCallback(() => {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    validMembers.forEach((m) => bounds.extend({ lat: m.lat, lng: m.lng }));
    if (hasDestination) bounds.extend({ lat: destLat, lng: destLng });
    if (deviceLoc) bounds.extend(deviceLoc);
    routeAlternatives?.forEach((alt) => alt.coordinates.forEach((c) => bounds.extend(c)));
    if (!bounds.isEmpty()) map.fitBounds(bounds, 60);
    else { map.setCenter(center); map.setZoom(15); }
  }, [map, validMembers, hasDestination, destLat, destLng, deviceLoc, routeAlternatives, center]);

  // Show current-user marker
  const currentMember = effectiveMembers.find((m) => m.isCurrentUser);
  const currentUserMarkers: { id: string; lat: number; lng: number; name: string; status: string; isCurrentUser: boolean; speedKmh?: number; headingDeg?: number }[] = (() => {
    if (currentMember && currentMember.lat !== 0 && currentMember.lng !== 0) {
      return [currentMember];
    }
    if (deviceLoc) {
      return [{
        id: currentMember?.id ?? 'me',
        lat: deviceLoc.lat,
        lng: deviceLoc.lng,
        name: currentMember?.name ?? 'You',
        status: 'safe',
        isCurrentUser: true,
      }];
    }
    return [];
  })();

  return (
    <>
      {/* ── Map ─────────────────────────────────────────────────────────── */}
      <GoogleMap
        defaultCenter={center}
        defaultZoom={15}
        mapId="rally-live-map"
        disableDefaultUI
        gestureHandling="greedy"
        style={{ width: '100%', height: '100%' }}
        colorScheme="DARK"
      />

      {/* ── Disconnected / Reconnecting notification banner ──────────────── */}
      {connectionStatus === 'RECONNECTING' && (
        <div className="absolute top-4 left-4 z-[1000] px-3 py-1.5 rounded-full bg-[#0A0A0A]/90 border border-amber-500/40 text-amber-300 text-xs font-medium flex items-center gap-2 backdrop-blur shadow-md pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span>Reconnecting live tracking...</span>
        </div>
      )}

      {/* ── Destination marker ───────────────────────────────────────────── */}
      {hasDestination && (
        <AdvancedMarker
          position={{ lat: destLat, lng: destLng }}
          onClick={() => setActivePopup('dest')}
        >
          <div
            style={{
              width: 16, height: 16,
              borderRadius: 4,
              background: '#19BFFF',
              transform: 'rotate(45deg)',
              boxShadow: '0 0 14px rgba(25,191,255,0.8)',
              border: '2px solid white',
            }}
          />
          {activePopup === 'dest' && (
            <InfoWindow onClose={() => setActivePopup(null)} position={{ lat: destLat, lng: destLng }}>
              <div style={{ color: '#000', fontSize: 12, fontWeight: 600 }}>{destName}</div>
              <div style={{ color: '#888', fontSize: 11 }}>Destination</div>
            </InfoWindow>
          )}
        </AdvancedMarker>
      )}

      {/* ── Start marker (route planning) ───────────────────────────────── */}
      {showStart && group && group.route.length > 0 && (
        <AdvancedMarker position={{ lat: group.route[0].lat, lng: group.route[0].lng }}>
          <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#34D399', border: '2px solid white', boxShadow: '0 0 10px rgba(52,211,153,0.8)' }} />
        </AdvancedMarker>
      )}

      {/* ── Alert markers ───────────────────────────────────────────────── */}
      {alerts?.map((a) => {
        const m = effectiveMembers.find((mem) => mem.id === a.memberId);
        if (!m) return null;
        return (
          <AdvancedMarker
            key={a.id}
            position={{ lat: m.lat + 0.0008, lng: m.lng + 0.0008 }}
            onClick={() => setActivePopup(`alert-${a.id}`)}
          >
            <div style={{ width: 22, height: 22, borderRadius: 6, background: '#F59E0B', border: '2px solid #0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0A0A0A', fontSize: 13, fontWeight: 900, boxShadow: '0 0 8px rgba(245,158,11,0.7)' }}>!</div>
            {activePopup === `alert-${a.id}` && (
              <InfoWindow onClose={() => setActivePopup(null)} position={{ lat: m.lat + 0.0008, lng: m.lng + 0.0008 }}>
                <div style={{ color: '#000', fontSize: 12, fontWeight: 600 }}>{a.message}</div>
                <div style={{ color: '#888', fontSize: 11 }}>{a.detail}</div>
              </InfoWindow>
            )}
          </AdvancedMarker>
        );
      })}

      {/* ── Member markers ───────────────────────────────────────────────── */}
      {[...currentUserMarkers, ...effectiveMembers.filter((m) => !m.isCurrentUser)].map((m: any) => {
        const style = STATUS_STYLE[m.status as keyof typeof STATUS_STYLE] || STATUS_STYLE.safe;
        const initial = (m.name || 'Y').charAt(0).toUpperCase();
        if (m.isCurrentUser) {
          // Distinct pulsing blue marker for the current user
          return (
            <AdvancedMarker
              key={m.id}
              position={{ lat: m.lat, lng: m.lng }}
              onClick={() => setActivePopup(`member-${m.id}`)}
            >
              <div style={{ position: 'relative', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {/* Outer pulse ring */}
                <div style={{
                  position: 'absolute', width: '100%', height: '100%',
                  borderRadius: '50%', background: '#19BFFF', opacity: 0.25,
                  animation: 'pulse 2s ease-in-out infinite',
                }} />
                {/* Inner solid dot */}
                <div style={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: '#19BFFF',
                  border: '3px solid #fff',
                  boxShadow: '0 0 16px rgba(25,191,255,0.9)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#000', fontSize: 11, fontWeight: 800,
                }}>
                  {initial}
                </div>
                <div style={{
                  position: 'absolute', bottom: -16, left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: 9, fontWeight: 800, color: '#19BFFF',
                  letterSpacing: '0.08em', whiteSpace: 'nowrap',
                  textShadow: '0 0 6px rgba(25,191,255,0.8)',
                }}>
                  YOU
                </div>
              </div>
              {activePopup === `member-${m.id}` && (
                <InfoWindow onClose={() => setActivePopup(null)} position={{ lat: m.lat, lng: m.lng }}>
                  <div style={{ color: '#000', fontSize: 12, fontWeight: 700 }}>
                    {m.name || 'You'} <span style={{ color: '#888', fontWeight: 400, fontSize: 10 }}>(You)</span>
                  </div>
                  <div style={{ color: '#888', fontSize: 11 }}>Live location · {m.speedKmh ?? 0} km/h</div>
                </InfoWindow>
              )}
            </AdvancedMarker>
          );
        }
        return (
          <AdvancedMarker
            key={m.id}
            position={{ lat: m.lat, lng: m.lng }}
            onClick={() => setActivePopup(`member-${m.id}`)}
          >
            <div
              style={{
                position: 'relative',
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
              }}
            >
              <div style={{ position: 'absolute', width: '100%', height: '100%', borderRadius: '50%', background: style.hex, opacity: 0.3 }} />
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#0A0A0A', border: `2px solid ${style.hex}`, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 10px ${style.hex}` }}>
                {initial}
              </div>
            </div>
            {activePopup === `member-${m.id}` && (
              <InfoWindow onClose={() => setActivePopup(null)} position={{ lat: m.lat, lng: m.lng }}>
                <div style={{ color: '#000', fontSize: 12, fontWeight: 700 }}>
                  {m.name || 'Member'}
                </div>
                <div style={{ color: '#888', fontSize: 11 }}>{style.label} · {m.speedKmh ?? 0} km/h</div>
              </InfoWindow>
            )}
          </AdvancedMarker>
        );
      })}

      {/* ── No-route prompt / button ─────────────────────────────────────── */}
      {shouldShowNoRoutePrompt && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2">
          <button
            type="button"
            onClick={handleSetDestination}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#0A0A0A]/95 hover:bg-[#1A1A1A] active:scale-95 backdrop-blur border border-white/20 text-xs font-semibold text-white shadow-xl transition-all cursor-pointer pointer-events-auto"
            title="Set Destination"
            aria-label="Set Destination"
          >
            <MapPin className="w-3.5 h-3.5 text-rally-blue shrink-0" />
            <span>Set Destination</span>
          </button>
        </div>
      )}

      {/* ── Floating map controls ───────────────────────────────────────── */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-2">
        <MapControlButton onClick={handleLocateMe} label="Recenter">
          <LocateFixed className="w-4 h-4" />
        </MapControlButton>
        <div className="flex flex-col rounded-xl overflow-hidden border border-border bg-card/90 backdrop-blur">
          <button
            onClick={() => map?.setZoom((map.getZoom() ?? 15) + 1)}
            aria-label="Zoom in"
            className="w-9 h-9 flex items-center justify-center text-foreground hover:bg-muted transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
          <div className="h-px bg-border" />
          <button
            onClick={() => map?.setZoom((map.getZoom() ?? 15) - 1)}
            aria-label="Zoom out"
            className="w-9 h-9 flex items-center justify-center text-foreground hover:bg-muted transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
        <MapControlButton onClick={handleFitGroup} label="Fit group">
          <Maximize className="w-4 h-4" />
        </MapControlButton>
        <MapControlButton onClick={() => setShowRoute((v) => !v)} label="Toggle route" active={showRoute}>
          <RouteIcon className="w-4 h-4" />
        </MapControlButton>
      </div>
    </>
  );
}

function GoogleAuthWatcher({ onAuthFailure }: { onAuthFailure: () => void }) {
  const status = useApiLoadingStatus();
  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE || status === APILoadingStatus.FAILED) {
      onAuthFailure();
    }
  }, [status, onAuthFailure]);
  return null;
}

// ─── Root export ──────────────────────────────────────────────────────────────

export default function LiveMap(props: LiveMapProps) {
  const deviceLoc = useDeviceLocation();
  const [googleAuthFailed, setGoogleAuthFailed] = useState(false);

  useEffect(() => {
    const prevGmAuthFailure = (window as any).gm_authFailure;
    (window as any).gm_authFailure = () => {
      console.warn('Google Maps authentication failure (ApiNotActivatedMapError / InvalidKey). Falling back to OpenStreetMap.');
      setGoogleAuthFailed(true);
      if (typeof prevGmAuthFailure === 'function') {
        try {
          prevGmAuthFailure();
        } catch (_) {}
      }
    };

    return () => {
      (window as any).gm_authFailure = prevGmAuthFailure;
    };
  }, []);

  // ── Fallback to OpenStreetMap when Google Maps key is not configured or failed auth ────
  if (!hasGoogleMapsKey() || googleAuthFailed) {
    return (
      <div className="relative w-full h-full min-h-[420px]">
        {googleAuthFailed && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1001] bg-amber-500/95 text-black text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 backdrop-blur">
            <span>Maps JavaScript API not activated on this key — using OpenStreetMap fallback</span>
          </div>
        )}
        <OsmLiveMap {...props} deviceLoc={deviceLoc} />
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[420px] rounded-2xl overflow-hidden border border-border">
      <APIProvider
        apiKey={GOOGLE_MAPS_API_KEY}
        libraries={['places', 'geometry']}
        onError={() => setGoogleAuthFailed(true)}
      >
        <GoogleAuthWatcher onAuthFailure={() => setGoogleAuthFailed(true)} />
        <MapContent {...props} deviceLoc={deviceLoc} />
      </APIProvider>
    </div>
  );
}

// ─── Shared control button ────────────────────────────────────────────────────

function MapControlButton({
  onClick, label, children, active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-9 h-9 rounded-xl flex items-center justify-center border backdrop-blur transition-colors ${
        active
          ? 'bg-rally-blue/20 border-rally-blue/50 text-rally-blue'
          : 'bg-card/90 border-border text-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}
