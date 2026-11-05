import { safeStorage } from 'electron';

export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
