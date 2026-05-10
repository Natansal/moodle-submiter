export interface EncryptedCredentials {
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface WebhookPayload {
  targetUrl: string;
  credentials?: EncryptedCredentials;
  userId?: string;
  mode?: 'production' | 'development';
}

export interface ListenerSettingsPayload {
  email: string;
  /** Omit or leave empty to keep the password already stored for this account. */
  password?: string;
  activeGroupIds: string[];
  uptimes: {
    day: string;
    ranges: { start: number; end: number }[];
  }[];
  active?: boolean;
}
