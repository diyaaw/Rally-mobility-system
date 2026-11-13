'use client';

import { useState, useEffect } from 'react';
import { useGroup } from '@/hooks/useGroup';
import { useLocation } from '@/hooks/useLocation';
import Topbar from '@/components/dashboard/Topbar';
import EmptyRallyState from '@/components/dashboard/EmptyRallyState';
import RallyOverview from '@/components/dashboard/RallyOverview';
import LocationStatus from '@/components/dashboard/LocationStatus';
import MemberList from '@/components/dashboard/MemberList';
import GroupHealthCard from '@/components/dashboard/GroupHealthCard';
import LiveMap from '@/components/map/LiveMap';
import SOSBanner from '@/components/dashboard/SOSBanner';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

export default function DashboardPage() {
  const { group, loading, service } = useGroup();
  const [tripStarted, setTripStarted] = useState(false);
  const { isTracking } = useLocation();

  const currentMember = group?.members.find((m) => m.isCurrentUser);

  useEffect(() => {
    // If the trip is already active on the backend, show the live map immediately
    if (tripStarted) return;
    const tripId = (service as any).getTripId?.();
    if (tripId && (group?.trip?.distanceKm || (group as any)?.tripStatus === 'ACTIVE')) {
      setTripStarted(true);
    }
  }, [group, service, tripStarted]);

  const handleStartTrip = async () => {
    try {
      await service.startTrip();
    } catch (err) {
      console.warn('Failed to start trip:', err);
    }
    setTripStarted(true);
  };

  if (loading) {
    return <div className="min-h-screen bg-background" />;
  }

  // STATE 1 — No RALLY
  if (!group) {
    return (
      <div className="min-h-screen flex flex-col">
        <Topbar group={null} />
        <div className="flex-1 flex flex-col justify-center items-center">
          <EmptyRallyState />
        </div>
      </div>
    );
  }

  const isTripActive = tripStarted || Boolean(group.trip?.startedAt);

  // STATE 2 — RALLY exists, but no active trip
  if (!isTripActive) {
    return (
      <div className="min-h-screen flex flex-col">
        <Topbar group={group} gpsState={isTracking ? 'active' : 'off'} />
        {group.activeSOS && group.activeSOS.length > 0 && (
          <div className="p-4 md:px-8 pb-0">
            <SOSBanner
              activeSOS={group.activeSOS}
              currentUserId={currentMember?.id ?? ''}
              onAcknowledge={(id) => (service as any).acknowledgeSOS?.(id)}
              onResolve={(id) => (service as any).resolveSOS?.(id)}
              onCancel={(id) => (service as any).cancelSOS?.(id)}
            />
          </div>
        )}
        <div className="flex-1 p-4 md:p-6 lg:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 max-w-7xl mx-auto">
            <RallyOverview group={group} onStartTrip={handleStartTrip} />
            <LocationStatus />
            <div className="flex flex-col gap-5">
              <MemberList members={group.members} />
              <GroupHealthCard group={group} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // STATE 3 — Active trip
  return (
    <div className="min-h-screen flex flex-col h-screen overflow-hidden">
      <Topbar group={group} gpsState={isTracking ? 'active' : 'off'} />
      {group.activeSOS && group.activeSOS.length > 0 && (
        <div className="p-4 md:px-6 pb-0">
          <SOSBanner
            activeSOS={group.activeSOS}
            currentUserId={currentMember?.id ?? ''}
            onAcknowledge={(id) => (service as any).acknowledgeSOS?.(id)}
            onResolve={(id) => (service as any).resolveSOS?.(id)}
            onCancel={(id) => (service as any).cancelSOS?.(id)}
          />
        </div>
      )}
      <div className="flex-1 p-4 md:p-6 flex flex-col gap-5 min-h-0 overflow-y-auto">
        <div className="relative flex-none h-[50vh] md:h-[65vh] shrink-0">
          <LiveMap group={group} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-none pb-8">
          <LocationStatus />
          <RallyOverview group={group} />
        </div>
      </div>
    </div>
  );
}
