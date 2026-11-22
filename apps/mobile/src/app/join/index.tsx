import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Building2, Check, Link2, Send } from 'lucide-react-native'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { color, radius, space } from '../../theme'
import { Button, Card, ErrorNote, Field, H2, IconBadge, Screen, Segmented, Skeleton, T, Title } from '../../ui/kit'
import { t } from '../../lib/i18n'

type Found = { id: string; display_name: string; address: string }

/** Токен из ссылки вида https://…/join#TOKEN или ortaq://join/TOKEN */
function tokenFrom(link: string): string | null {
  const t = link.trim()
  const m = t.match(/#([A-Za-z0-9_-]{16,})$/) ?? t.match(/join\/([A-Za-z0-9_-]{16,})/) ?? t.match(/^([A-Za-z0-9_-]{16,})$/)
  return m?.[1] ?? null
}

/**
 * Дом ещё не выбран. Основной путь — ссылка из чата дома. Запасной (docs/04 §6) —
 * найти дом по адресу и отправить заявку председателю: решение за ним.
 */
export default function Join() {
  const { signOut } = useSession()
  const [link, setLink] = useState('')
  const token = tokenFrom(link)

  return (
    <Screen>
      <Title sub={t('Ссылку присылает председатель в общий чат дома')}>{t('Присоединитесь к своему дому')}</Title>
      <Card>
        <Field label={t('Ссылка-приглашение')} value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false}
          placeholder={t('Вставьте ссылку из чата')} error={link && !token ? t('Не похоже на ссылку Ortaq') : undefined} />
        <Button icon={Link2} disabled={!token} onPress={() => router.push({ pathname: '/join/[token]', params: { token: token! } })}>{t('Открыть приглашение')}</Button>
      </Card>
      <JoinRequest />
      <Button variant="ghost" onPress={() => void signOut()}>{t('Выйти')}</Button>
    </Screen>
  )
}

function JoinRequest() {
  const [q, setQ] = useState('')
  const [house, setHouse] = useState<Found | null>(null)
  const [unit, setUnit] = useState('')
  const [relation, setRelation] = useState<'OWNER' | 'TENANT'>('OWNER')
  const search = useQuery({
    queryKey: ['house-search', q.trim()],
    queryFn: () => api<Found[]>(`/house-search?q=${encodeURIComponent(q.trim())}`),
    enabled: q.trim().length >= 3 && !house,
  })
  const send = useMutation({
    mutationFn: () => api('/join-requests', { method: 'POST', body: { house_id: house!.id, unit_number: unit.trim(), relation } }),
  })

  if (send.isSuccess) {
    return (
      <Card tone="brand">
        <IconBadge icon={Check} tone="brand" />
        <H2>{t('Заявка отправлена')}</H2>
        <T tone="ink2">{t('Председатель {house} проверит её и подтвердит. Мы пришлём уведомление', { house: house?.display_name ?? '' })}</T>
      </Card>
    )
  }

  return (
    <Card>
      <H2>{t('Нет ссылки?')}</H2>
      <T size={14} tone="ink2">{t('Найдите дом по адресу и отправьте заявку председателю')}</T>
      {house ? (
        <>
          <Pressable onPress={() => setHouse(null)} accessibilityRole="button" accessibilityLabel={t('Выбрать другой дом')}
            style={{ flexDirection: 'row', gap: space.md, alignItems: 'center', borderRadius: radius.md, backgroundColor: color.brand50, padding: space.md }}>
            <Building2 size={20} strokeWidth={2} color={color.brand700} />
            <View style={{ flex: 1 }}>
              <T weight="semibold">{house.display_name}</T>
              <T size={13} tone="ink2">{house.address}</T>
            </View>
          </Pressable>
          <Field label={t('Номер помещения')} value={unit} onChangeText={setUnit} placeholder="45" />
          <Segmented label={t('Кем вы являетесь')} value={relation} onChange={setRelation} options={[{ v: 'OWNER', label: t('Собственник') }, { v: 'TENANT', label: t('Наниматель') }]} />
          <ErrorNote>{send.error?.message}</ErrorNote>
          <Button icon={Send} loading={send.isPending} disabled={!unit.trim()} onPress={() => send.mutate()}>{t('Отправить заявку')}</Button>
        </>
      ) : (
        <>
          <Field label={t('Адрес или название ЖК')} value={q} onChangeText={setQ} placeholder={t('Асыл Арман')} />
          {search.isFetching && <Skeleton rows={2} height={56} />}
          {search.data?.map((h) => (
            <Pressable key={h.id} onPress={() => setHouse(h)} accessibilityRole="button"
              style={({ pressed }) => ({ borderRadius: radius.md, backgroundColor: pressed ? color.surface3 : color.surface2, padding: space.md, minHeight: 56 })}>
              <T weight="semibold">{h.display_name}</T>
              <T size={13} tone="ink2">{h.address}</T>
            </Pressable>
          ))}
          {search.data?.length === 0 && <T tone="ink2">{t('Ничего не нашли. Попробуйте улицу без номера дома')}</T>}
          <ErrorNote>{search.error?.message}</ErrorNote>
        </>
      )}
    </Card>
  )
}
