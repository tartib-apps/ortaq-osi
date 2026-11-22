import { Outlet } from 'react-router'
import { Building, Landmark, ScrollText } from 'lucide-react'
import type { MeResponse } from '@ortaq/shared'
import { Shell } from '../shared/ui/Shell'
import { t } from '../shared/i18n'

export function AdminLayout({ me }: { me: MeResponse }) {
  return (
    <Shell
      id="admin"
      caption={t('Админ-панель')}
      user={{ name: me.full_name, role: t('админ платформы') }}
      items={[
        { to: '/admin/houses', label: t('Дома'), icon: Building },
        { to: '/admin/organizations', label: t('Организации'), icon: Landmark },
        { to: '/admin/audit', label: t('Журнал'), icon: ScrollText },
      ]}
    >
      <Outlet />
    </Shell>
  )
}
