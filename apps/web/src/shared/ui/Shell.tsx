import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { NavLink } from 'react-router'
import { Building2, LogOut, type LucideIcon } from 'lucide-react'
import { cn, initials, spring } from '../lib/cn'
import { useSignOut } from '../hooks'
import { LangSwitch } from './LangSwitch'
import { t } from '../i18n'

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; badge?: number }

/**
 * Каркас кабинета: стеклянная шапка с навигацией-пилюлей.
 * Подпись видна только у активного раздела (внутри зелёной пилюли), у остальных — иконка
 * и подсказка с названием при наведении или фокусе с клавиатуры.
 */
export function Shell({ id, caption, items, user, children }: {
  id: string; caption: string; items: NavItem[]; user: { name: string; role: string }; children: ReactNode
}) {
  const signOut = useSignOut()
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[1440px] flex-col gap-6 px-4 pb-16 pt-3 md:px-6">
      <header className="glass sticky top-3 z-30 flex items-center justify-between gap-3 rounded-full p-1.5">
        <div className="flex min-w-0 shrink items-center gap-2.5 pl-1.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-600 text-white"><Building2 size={18} strokeWidth={2.2} /></span>
          <span className="hidden font-display text-[20px] font-extrabold tracking-[-0.03em] text-ink sm:block">Ortaq</span>
          {caption && <span className="hidden truncate text-[14px] text-ink-2 lg:block">{caption}</span>}
        </div>

        {/* На узком экране меню прокручивается вбок; на широком всё помещается, и подсказки не обрезаются */}
        <nav aria-label={t('Разделы')} className="flex min-w-0 overflow-x-auto rounded-full bg-surface p-1 [scrollbar-width:none] md:overflow-visible [&::-webkit-scrollbar]:hidden">
          {items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className="group relative flex h-10 min-w-10 shrink-0 items-center justify-center rounded-full px-2.5">
              {({ isActive }) => (
                <>
                  {isActive
                    ? <motion.span layoutId={`nav-${id}`} transition={spring} className="absolute inset-0 rounded-full bg-brand-600" />
                    : <span className="absolute inset-0 rounded-full transition-colors group-hover:bg-surface-2" />}
                  <span className={cn('relative flex items-center gap-2 text-[14px] font-semibold transition-colors', isActive ? 'text-white' : 'text-ink-2 group-hover:text-ink')}>
                    <it.icon size={17} strokeWidth={2.1} />
                    {isActive ? (
                      <motion.span key={it.to} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="whitespace-nowrap pr-1.5">
                        {it.label}
                      </motion.span>
                    ) : (
                      <span className="sr-only">{it.label}</span>
                    )}
                    {it.badge ? (
                      <span className={cn('nums grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-bold', isActive ? 'bg-white text-brand-700' : 'bg-danger text-white')}>
                        {it.badge}
                      </span>
                    ) : null}
                  </span>
                  {!isActive && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-full z-40 mt-2.5 hidden -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 md:block"
                    >
                      {it.label}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          <LangSwitch signedIn />
          <span className="hidden items-center gap-2 rounded-full bg-surface p-1 sm:flex xl:pr-3">
            <span className="grid size-9 place-items-center rounded-full bg-brand-100 font-display text-[13px] font-bold text-brand-700">{initials(user.name)}</span>
            <span className="hidden text-left leading-tight xl:block">
              <span className="block text-[13px] font-semibold text-ink">{user.name}</span>
              <span className="block text-[11.5px] text-ink-2">{user.role}</span>
            </span>
          </span>
          <button onClick={() => void signOut()} aria-label={t('Выйти')} className="grid size-11 place-items-center rounded-full bg-surface text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
            <LogOut size={18} strokeWidth={2} />
          </button>
        </div>
      </header>
      <main className="flex min-w-0 flex-col gap-6">{children}</main>
    </div>
  )
}
