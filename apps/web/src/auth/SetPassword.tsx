import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { PASSWORD_MIN, type LoginResult } from '@ortaq/shared'
import { api, ApiError } from '../shared/api/client'
import { cn } from '../shared/lib/cn'
import { Btn, ErrorNote, Field, Input } from '../shared/ui/kit'
import { t } from '../shared/i18n'
import { AuthLayout, AuthTitle } from './AuthLayout'
import { useFinishLogin, type Step } from './finish'
import { TwoFactorSetup, TwoFactorVerify } from './TwoFactor'

/** Токен из письма во фрагменте после #: фрагмент не уходит на сервер и не оседает в логах */
const tokenFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''

export function SetPassword() {
  const [token] = useState(tokenFromHash)
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const finish = useFinishLogin()

  const mismatch = repeat.length > 0 && repeat !== password
  const long = password.length >= PASSWORD_MIN

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      finish(await api<LoginResult>('/auth/password/set', { method: 'POST', body: { token, password } }), setStep)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Не получилось сохранить пароль'))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <AuthTitle title={t('Ссылка неполная')} sub={t('Откройте ссылку из письма целиком. Если она не работает, попросите администратора отправить новую.')} />
        <Link to="/login" className="text-[15px] font-semibold text-brand-700 hover:text-brand-800">{t('Перейти ко входу')}</Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      {step.kind === 'password' && (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <AuthTitle title={t('Задайте пароль')} sub={t('Это первый из двух шагов. Следом подключим приложение-аутентификатор.')} />
          <Field label={t('Новый пароль')} hint={t('Не короче {n} символов. Удобнее фраза из нескольких слов', { n: PASSWORD_MIN })}>
            {(id, d) => <Input id={id} describedBy={d} type="password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />}
          </Field>
          <div className="flex items-center gap-2 text-[13px]">
            <span className={cn('h-1.5 flex-1 rounded-full transition-colors', long ? 'bg-brand-500' : 'bg-surface-3')} />
            <span className={long ? 'text-brand-700' : 'text-ink-2'}>{long ? t('Длина подходит') : t('{a} из {b}', { a: password.length, b: PASSWORD_MIN })}</span>
          </div>
          <Field label={t('Пароль ещё раз')} error={mismatch ? t('Пароли не совпадают') : undefined}>
            {(id, d) => <Input id={id} describedBy={d} type="password" value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={mismatch} />}
          </Field>
          <ErrorNote>{error}</ErrorNote>
          <Btn type="submit" size="lg" loading={busy} disabled={!long || repeat !== password} full>{t('Сохранить пароль')}</Btn>
        </form>
      )}
      {step.kind === 'setup' && <TwoFactorSetup challenge={step.challenge} onDone={(r) => finish(r, setStep)} />}
      {step.kind === 'code' && <TwoFactorVerify challenge={step.challenge} onDone={(r) => finish(r, setStep)} onBack={() => setStep({ kind: 'password' })} />}
    </AuthLayout>
  )
}
