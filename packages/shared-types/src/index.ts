export interface EncryptedCredentials {
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface WebhookPayload {
  targetUrl: string;
  credentials: EncryptedCredentials;
  mode?: 'production' | 'development';
}
