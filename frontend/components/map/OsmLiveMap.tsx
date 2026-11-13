'use client';

/**
 * OsmLiveMap – Interactive Leaflet / OpenStreetMap implementation for RALLY.
 *
 * Supports both Light and Dark themes dynamically using high-contrast Esri
 * Canvas tiles (World Light Gray and World Dark Gray).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LocateFixed,
  Plus,
  Minus,
  Maximize,
  Route as RouteIcon,
  MapPin,
  X,
} from 'lucide-react';
import type { AlertItem, Group } from '@/lib/mock/types';
import { STATUS_STYLE } from '@/components/dashboard/status';
import { rallyGroupService } from '@/lib/realtime/RallyGroupService';
import type { ServerMessage } from '@/lib/ws/types';
import { useTheme } from '@/lib/theme/ThemeProvider';

import 'leaflet/dist/leaflet.css';

interface RouteAlt {
  id: string;
  coordinates: { lat: number; lng: number }[];
  selected: boolean;
}

export interface OsmLiveMapProps {
  group?: Group;
  showStart?: boolean;
  alerts?: AlertItem[];
  route?: Array<{ lat: number; lng: number }> | Array<[number, number]> | null;
  routeAlternatives?: RouteAlt[];
  onRouteSelect?: (id: string) => void;
  customDestination?: { lat: number; lng: number; name: string };
  showNoRoutePrompt?: boolean;
  onSetDestination?: () => void;
  deviceLoc?: { lat: number; lng: number } | null;
}

export default function OsmLiveMap({
  group,
  showStart = false,
  alerts,
  route,
  routeAlternatives,
  onRouteSelect,
  customDestination,
  showNoRoutePrompt,
  onSetDestination,
  deviceLoc: propDeviceLoc,
}: OsmLiveMapProps) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const [L, setL] = useState<any>(null);
  const [showRoute, setShowRoute] = useState(true);
  const [showInfoBanner, setShowInfoBanner] = useState(true);

  // Markers and layers refs for clean Leaflet lifecycle updates
  const tilesLayerRef = useRef<any>(null);
  const markersLayerRef = useRef<any>(null);
  const polylinesLayerRef = useRef<any>(null);

  const isLight = resolvedTheme === 'light';

  // ── Device location fallback ──────────────────────────────────────────────
  const [internalDeviceLoc, setInternalDeviceLoc] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (p) => setInternalDeviceLoc({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const deviceLoc = propDeviceLoc || internalDeviceLoc;

  // ── Real-time member locations & socket updates ───────────────────────────
  const [livePositions, setLivePositions] = useState<
    Map<string, { lat: number; lng: number; speedKmh?: number; headingDeg?: number; updatedAt: number }>
  >(new Map());

  useEffect(() => {
    const unsubMessages = rallyGroupService.subscribeMessages((msg: ServerMessage) => {
      try {
        if (msg.type === 'location_update') {
          const payload: any = (msg as any).data || msg;
          const userId = payload.user_id || payload.userId;
          if (!userId) return;

          const lat = typeof payload.latitude === 'number' ? payload.latitude : parseFloat(payload.latitude);
          const lng = typeof payload.longitude === 'number' ? payload.longitude : parseFloat(payload.longitude);

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
        console.warn('OsmLiveMap: location parse error:', err);
      }
    });

    return () => {
      unsubMessages();
    };
  }, []);

  // ── Route alternatives calculation ────────────────────────────────────────
  const effectiveRouteAlts = useMemo<RouteAlt[]>(() => {
    if (routeAlternatives && routeAlternatives.length > 0) {
      return routeAlternatives;
    }
    if (route && Array.isArray(route) && route.length > 0) {
      const coords: { lat: number; lng: number }[] = route.map((pt: any) => {
        if (Array.isArray(pt)) {
          return { lat: pt[0], lng: pt[1] };
        }
        return { lat: pt.lat, lng: pt.lng };
      });
      return [{ id: 'active', coordinates: coords, selected: true }];
    }
    if (group?.route && Array.isArray(group.route) && group.route.length > 0) {
      return [{ id: 'active', coordinates: group.route, selected: true }];
    }
    return [];
  }, [routeAlternatives, route, group?.route]);

  const hasRoute = effectiveRouteAlts.length > 0;
  const shouldShowNoRoutePrompt = showNoRoutePrompt && !hasRoute;

  // ── Valid members calculation ─────────────────────────────────────────────
  const effectiveMembers = useMemo(() => {
    const raw = group?.members ?? [];
    return raw
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
          typeof m.lat === 'number' &&
          typeof m.lng === 'number' &&
          Number.isFinite(m.lat) &&
          Number.isFinite(m.lng) &&
          (m.lat !== 0 || m.lng !== 0) &&
          m.lat >= -90 &&
          m.lat <= 90 &&
          m.lng >= -180 &&
          m.lng <= 180
      );
  }, [group?.members, livePositions]);

  const destLat = customDestination ? customDestination.lat : (group?.destinationLat ?? 0);
  const destLng = customDestination ? customDestination.lng : (group?.destinationLng ?? 0);
  const destName = customDestination ? customDestination.name : (group?.destination ?? 'Destination');
  const hasDestination = (destLat !== 0 || destLng !== 0) && Number.isFinite(destLat) && Number.isFinite(destLng);

  // ── Center coordinate ─────────────────────────────────────────────────────
  const center: [number, number] = useMemo(() => {
    if (deviceLoc) return [deviceLoc.lat, deviceLoc.lng];
    if (effectiveMembers.length > 0) {
      return [
        effectiveMembers.reduce((s, m) => s + m.lat, 0) / effectiveMembers.length,
        effectiveMembers.reduce((s, m) => s + m.lng, 0) / effectiveMembers.length,
      ];
    }
    if (hasDestination) return [destLat, destLng];
    return [32.3166, 77.1578];
  }, [deviceLoc, effectiveMembers, hasDestination, destLat, destLng]);

  // ── Import Leaflet on client mount ─────────────────────────────────────────
  useEffect(() => {
    let active = true;
    import('leaflet').then((mod) => {
      if (active) setL(mod.default || mod);
    });
    return () => {
      active = false;
    };
  }, []);

  // ── Initialize Leaflet Map Instance ────────────────────────────────────────
  useEffect(() => {
    if (!L || !mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center,
      zoom: 14,
      zoomControl: false,
      attributionControl: false,
    });

    // Attribution control
    L.control
      .attribution({
        prefix: '<a href="https://leafletjs.com" target="_blank" style="color:#64748b;">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright" style="color:#64748b;">OSM</a>',
        position: 'bottomright',
      })
      .addTo(map);

    // Layer groups
    const tilesLayer = L.layerGroup().addTo(map);
    const polylinesLayer = L.layerGroup().addTo(map);
    const markersLayer = L.layerGroup().addTo(map);

    tilesLayerRef.current = tilesLayer;
    polylinesLayerRef.current = polylinesLayer;
    markersLayerRef.current = markersLayer;
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      tilesLayerRef.current = null;
      polylinesLayerRef.current = null;
      markersLayerRef.current = null;
    };
  }, [L]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update Tiles on Theme Change ───────────────────────────────────────────
  useEffect(() => {
    if (!L || !mapInstanceRef.current || !tilesLayerRef.current) return;

    tilesLayerRef.current.clearLayers();
    const variant = isLight ? 'Light' : 'Dark';

    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      {
        maxZoom: 16,
        attribution: '&copy; Esri &mdash; OpenStreetMap contributors',
      }
    ).addTo(tilesLayerRef.current);

    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${variant}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
      {
        maxZoom: 16,
      }
    ).addTo(tilesLayerRef.current);
  }, [L, isLight]);

  // ── Render Polylines ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!L || !mapInstanceRef.current || !polylinesLayerRef.current) return;

    polylinesLayerRef.current.clearLayers();

    if (!showRoute || effectiveRouteAlts.length === 0) return;

    effectiveRouteAlts.forEach((alt) => {
      const latlngs = alt.coordinates.map((pt) => [pt.lat, pt.lng]);
      if (latlngs.length < 2) return;

      const polyline = L.polyline(latlngs, {
        color: alt.selected ? '#00C2FF' : (isLight ? '#94A3B8' : '#4B5563'),
        weight: alt.selected ? 5 : 4,
        opacity: alt.selected ? 0.95 : 0.6,
        dashArray: alt.selected ? undefined : '6, 8',
      });

      if (onRouteSelect) {
        polyline.on('click', () => onRouteSelect(alt.id));
      }

      polyline.addTo(polylinesLayerRef.current);
    });
  }, [L, showRoute, effectiveRouteAlts, onRouteSelect, isLight]);

  // ── Render Markers ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!L || !mapInstanceRef.current || !markersLayerRef.current) return;

    markersLayerRef.current.clearLayers();

    const popupBg = isLight ? '#FFFFFF' : '#0F172A';
    const popupText = isLight ? '#0F172A' : '#F8FAFC';
    const popupSub = isLight ? '#64748B' : '#94A3B8';
    const popupBorder = isLight ? '#E2E8F0' : 'rgba(255,255,255,0.12)';

    // 1. Destination Marker
    if (hasDestination) {
      const destIcon = L.divIcon({
        className: 'rally-dest-marker',
        html: `
          <div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">
            <div style="width:16px;height:16px;border-radius:4px;background:#00C2FF;transform:rotate(45deg);box-shadow:0 0 14px rgba(0,194,255,0.9);border:2px solid #ffffff;"></div>
          </div>
        `,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const destMarker = L.marker([destLat, destLng], { icon: destIcon }).addTo(markersLayerRef.current);
      destMarker.bindPopup(`
        <div style="background:${popupBg};color:${popupText};padding:6px 10px;border-radius:8px;font-family:sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.12);border:1px solid ${popupBorder};">
          <div style="font-weight:700;font-size:12px;color:#00C2FF;">${destName}</div>
          <div style="font-size:11px;color:${popupSub};">Trip Destination</div>
        </div>
      `);
    }

    // 2. Start Marker
    if (showStart && effectiveRouteAlts[0]?.coordinates?.[0]) {
      const startPt = effectiveRouteAlts[0].coordinates[0];
      const startIcon = L.divIcon({
        className: 'rally-start-marker',
        html: `
          <div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
            <div style="width:14px;height:14px;border-radius:50%;background:#10B981;border:2px solid #ffffff;box-shadow:0 0 12px rgba(16,185,129,0.9);"></div>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const startMarker = L.marker([startPt.lat, startPt.lng], { icon: startIcon }).addTo(markersLayerRef.current);
      startMarker.bindPopup(`
        <div style="background:${popupBg};color:${popupText};padding:6px 10px;border-radius:8px;font-family:sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.12);border:1px solid ${popupBorder};">
          <div style="font-weight:700;font-size:12px;color:#10B981;">Trip Origin</div>
        </div>
      `);
    }

    // 3. Alerts
    if (alerts && alerts.length > 0) {
      alerts.forEach((alert) => {
        const m = effectiveMembers.find((mem) => mem.id === alert.memberId);
        if (!m) return;
        const alertIcon = L.divIcon({
          className: 'rally-alert-marker',
          html: `
            <div style="width:24px;height:24px;border-radius:6px;background:#F59E0B;border:2px solid #000;display:flex;align-items:center;justify-content:center;color:#000;font-size:12px;font-weight:900;box-shadow:0 0 10px rgba(245,158,11,0.8);">!</div>
          `,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });

        const alertMarker = L.marker([m.lat + 0.0007, m.lng + 0.0007], { icon: alertIcon }).addTo(markersLayerRef.current);
        alertMarker.bindPopup(`
          <div style="background:${popupBg};color:${popupText};padding:6px 10px;border-radius:8px;font-family:sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.12);border:1px solid ${popupBorder};">
            <div style="font-weight:700;font-size:12px;color:#F59E0B;">${alert.message}</div>
            <div style="font-size:11px;color:${popupSub};">${alert.detail || 'Incident Reported'}</div>
          </div>
        `);
      });
    }

    // 4. Group Members & Current User (ensuring current user marker is never dropped)
    const hasCurrentUser = effectiveMembers.some((m) => m.isCurrentUser);
    const membersToRender = [...effectiveMembers];
    if (!hasCurrentUser && deviceLoc) {
      const currentInGroup = group?.members?.find((m) => m.isCurrentUser);
      membersToRender.push({
        id: currentInGroup?.id ?? 'me',
        name: currentInGroup?.name ?? 'You',
        isCurrentUser: true,
        lat: deviceLoc.lat,
        lng: deviceLoc.lng,
        speedKmh: 0,
        status: 'safe',
      } as any);
    }

    membersToRender.forEach((m: any) => {
      const style = STATUS_STYLE[m.status as keyof typeof STATUS_STYLE] || STATUS_STYLE.safe;
      const initial = (m.name || 'M').charAt(0).toUpperCase();

      const memberIcon = L.divIcon({
        className: 'rally-member-marker',
        html: `
          <div style="position:relative;width:38px;height:38px;display:flex;align-items:center;justify-content:center;">
            <div style="position:absolute;width:100%;height:100%;border-radius:50%;background:${style.hex};opacity:0.35;animation:pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;"></div>
            <div style="width:28px;height:28px;border-radius:50%;background:${isLight ? '#FFFFFF' : '#0A0A0A'};border:2px solid ${style.hex};color:${isLight ? '#0F172A' : '#ffffff'};font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px ${style.hex};">
              ${initial}
            </div>
            ${m.isCurrentUser ? `<div style="position:absolute;bottom:-12px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:800;color:${style.hex};background:${isLight ? '#FFFFFF' : '#000000'};padding:0 3px;border-radius:3px;border:1px solid ${style.hex};letter-spacing:0.05em;white-space:nowrap;">YOU</div>` : ''}
          </div>
        `,
        iconSize: [38, 38],
        iconAnchor: [19, 19],
      });

      // Pulse circle for current user
      if (m.isCurrentUser) {
        L.circle([m.lat, m.lng], {
          radius: 35,
          color: '#00C2FF',
          fillColor: '#00C2FF',
          fillOpacity: 0.15,
          weight: 1.5,
        }).addTo(markersLayerRef.current);
      }

      const marker = L.marker([m.lat, m.lng], { icon: memberIcon }).addTo(markersLayerRef.current);
      marker.bindPopup(`
        <div style="background:${popupBg};color:${popupText};padding:6px 10px;border-radius:8px;font-family:sans-serif;min-width:110px;box-shadow:0 4px 14px rgba(0,0,0,0.12);border:1px solid ${popupBorder};">
          <div style="font-weight:700;font-size:12px;display:flex;align-items:center;gap:4px;">
            <span>${m.name}</span>
            ${m.isCurrentUser ? '<span style="color:#00C2FF;font-size:10px;">(You)</span>' : ''}
          </div>
          <div style="font-size:11px;color:${style.hex};margin-top:2px;">● ${style.label} · ${m.speedKmh ?? 0} km/h</div>
        </div>
      `);
    });
  }, [L, effectiveMembers, deviceLoc, hasDestination, destLat, destLng, destName, showStart, effectiveRouteAlts, alerts, isLight]);

  // ── Auto-fit group on initial load ────────────────────────────────────────
  const initialFitDoneRef = useRef(false);
  useEffect(() => {
    if (!L || !mapInstanceRef.current || initialFitDoneRef.current) return;

    const points: [number, number][] = [];
    effectiveMembers.forEach((m) => points.push([m.lat, m.lng]));
    if (hasDestination) points.push([destLat, destLng]);
    if (deviceLoc) points.push([deviceLoc.lat, deviceLoc.lng]);
    effectiveRouteAlts.forEach((alt) => alt.coordinates.forEach((c) => points.push([c.lat, c.lng])));

    if (points.length >= 2) {
      mapInstanceRef.current.fitBounds(points, { padding: [50, 50], maxZoom: 16 });
      initialFitDoneRef.current = true;
    } else if (points.length === 1) {
      mapInstanceRef.current.setView(points[0], 15);
      initialFitDoneRef.current = true;
    } else {
      mapInstanceRef.current.setView(center, 14);
      initialFitDoneRef.current = true;
    }
  }, [L, effectiveMembers, hasDestination, destLat, destLng, deviceLoc, effectiveRouteAlts, center]);

  // ── Controls Handlers ─────────────────────────────────────────────────────
  const handleLocateMe = useCallback(() => {
    if (!mapInstanceRef.current) return;
    const me = effectiveMembers.find((m) => m.isCurrentUser);
    if (me) {
      mapInstanceRef.current.flyTo([me.lat, me.lng], 16, { duration: 0.8 });
    } else if (deviceLoc) {
      mapInstanceRef.current.flyTo([deviceLoc.lat, deviceLoc.lng], 16, { duration: 0.8 });
    }
  }, [effectiveMembers, deviceLoc]);

  const handleFitGroup = useCallback(() => {
    if (!mapInstanceRef.current) return;
    const points: [number, number][] = [];
    effectiveMembers.forEach((m) => points.push([m.lat, m.lng]));
    if (hasDestination) points.push([destLat, destLng]);
    if (deviceLoc) points.push([deviceLoc.lat, deviceLoc.lng]);
    effectiveRouteAlts.forEach((alt) => alt.coordinates.forEach((c) => points.push([c.lat, c.lng])));

    if (points.length >= 2) {
      mapInstanceRef.current.fitBounds(points, { padding: [60, 60] });
    } else if (points.length === 1) {
      mapInstanceRef.current.flyTo(points[0], 15, { duration: 0.6 });
    }
  }, [effectiveMembers, hasDestination, destLat, destLng, deviceLoc, effectiveRouteAlts]);

  const handleZoomIn = useCallback(() => {
    mapInstanceRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    mapInstanceRef.current?.zoomOut();
  }, []);

  return (
    <div className="relative w-full h-full min-h-[420px] rounded-2xl overflow-hidden border border-border bg-card">
      {/* Leaflet map container */}
      <div ref={mapContainerRef} className="w-full h-full z-0" style={{ minHeight: '420px' }} />

      {/* ── OpenStreetMap Mode Info Pill ───────────────────────────────── */}
      {showInfoBanner && (
        <div className="absolute top-3 left-3 z-[1000] flex items-center gap-2 bg-card/90 backdrop-blur-md px-3 py-1.5 rounded-full border border-border text-xs shadow-md transition-all text-foreground">
          <div className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
          <span className="font-semibold text-foreground">OpenStreetMap Live</span>
          <span className="text-[10px] text-muted-foreground hidden sm:inline">
            (Add Google Maps API key in .env.local for Google Satellite)
          </span>
          <button
            type="button"
            onClick={() => setShowInfoBanner(false)}
            className="text-muted-foreground hover:text-foreground ml-1 p-0.5"
            title="Dismiss notification"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ── Set Destination Prompt ──────────────────────────────────────── */}
      {shouldShowNoRoutePrompt && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (onSetDestination) {
                onSetDestination();
              } else {
                router.push('/dashboard/route');
              }
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-card/95 hover:bg-muted active:scale-95 backdrop-blur border border-border text-xs font-semibold text-foreground shadow-xl transition-all cursor-pointer pointer-events-auto"
            title="Set Destination"
          >
            <MapPin className="w-3.5 h-3.5 text-rally-blue shrink-0" />
            <span>Set Destination</span>
          </button>
        </div>
      )}

      {/* ── Floating Map Controls ────────────────────────────────────────── */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-2">
        <button
          type="button"
          onClick={handleLocateMe}
          title="Recenter on my location"
          aria-label="Recenter"
          className="w-9 h-9 rounded-xl flex items-center justify-center border border-border bg-card/90 backdrop-blur text-foreground hover:bg-muted transition-colors shadow-sm"
        >
          <LocateFixed className="w-4 h-4" />
        </button>

        <div className="flex flex-col rounded-xl overflow-hidden border border-border bg-card/90 backdrop-blur shadow-sm">
          <button
            type="button"
            onClick={handleZoomIn}
            title="Zoom in"
            aria-label="Zoom in"
            className="w-9 h-9 flex items-center justify-center text-foreground hover:bg-muted transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
          <div className="h-px bg-border" />
          <button
            type="button"
            onClick={handleZoomOut}
            title="Zoom out"
            aria-label="Zoom out"
            className="w-9 h-9 flex items-center justify-center text-foreground hover:bg-muted transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={handleFitGroup}
          title="Fit entire group in view"
          aria-label="Fit group"
          className="w-9 h-9 rounded-xl flex items-center justify-center border border-border bg-card/90 backdrop-blur text-foreground hover:bg-muted transition-colors shadow-sm"
        >
          <Maximize className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setShowRoute((v) => !v)}
          title="Toggle route polyline"
          aria-label="Toggle route"
          className={`w-9 h-9 rounded-xl flex items-center justify-center border backdrop-blur transition-colors shadow-sm ${
            showRoute
              ? 'bg-rally-blue/20 border-rally-blue/50 text-rally-blue'
              : 'bg-card/90 border-border text-foreground hover:bg-muted'
          }`}
        >
          <RouteIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
