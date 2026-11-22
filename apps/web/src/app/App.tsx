import { RouterProvider } from 'react-router'
import { useLocale } from '../shared/i18n'
import { router } from './router'

/** Смена языка перемонтирует дерево: строки, переведённые при отрисовке, пересчитываются разом */
export function App() {
  const locale = useLocale()
  return <RouterProvider key={locale} router={router} />
}
