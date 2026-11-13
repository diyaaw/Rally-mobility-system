'use client';

import RequireAuth from '@/components/dashboard/RequireAuth';
import DashboardLayout from '@/app/dashboard/layout';
import SettingsPage from '@/app/dashboard/settings/page';

export default function StandaloneSettingsPage() {
  return (
    <RequireAuth>
      <DashboardLayout>
        <SettingsPage />
      </DashboardLayout>
    </RequireAuth>
  );
}

