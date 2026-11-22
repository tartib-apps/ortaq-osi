import * as SecureStore from 'expo-secure-store'

/**
 * Refresh-токен — в защищённом хранилище ОС (Keychain / Keystore), не в AsyncStorage:
 * его кража даёт вход в учётку жильца. Access живёт только в памяти, 15 минут.
 */
const KEY = 'ortaq.refresh'

export const refreshStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token: string) => SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(KEY),
}

/** Выбранный язык интерфейса — не секрет, но хранилище то же: другого в приложении нет */
const LOCALE_KEY = 'ortaq.locale'
export const localeStore = {
  get: () => SecureStore.getItemAsync(LOCALE_KEY),
  set: (v: string) => SecureStore.setItemAsync(LOCALE_KEY, v),
}
