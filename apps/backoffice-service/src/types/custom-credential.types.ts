export const CUSTOM_CREDENTIAL_PLATFORMS = ["ALL", "ANDROID", "IOS", "WEB"] as const;

export type CustomCredentialPlatform = (typeof CUSTOM_CREDENTIAL_PLATFORMS)[number];

export type CustomCredentialView = {
  id: string;
  name: string;
  platform: CustomCredentialPlatform;
  maskedValue: string;
  createdAt: number;
  updatedAt: number;
};

export type CreateCustomCredentialInput = {
  name: string;
  platform: CustomCredentialPlatform;
  value: string;
};

export type UpdateCustomCredentialInput = {
  name?: string;
  platform?: CustomCredentialPlatform;
  value?: string;
};

export type ResolvedCustomCredential = {
  configured: boolean;
  value: string;
};
