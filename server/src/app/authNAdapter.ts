export interface AuthNExchangeInput {
  code: string;
  codeVerifier: string;
  provider: string;
  redirectUri: string;
}

export interface OAuthProviderIdentity {
  provider: string;
  subject: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export type AuthNExchangeResult =
  | {
      outcome: "success";
      identity: OAuthProviderIdentity;
    }
  | {
      outcome: "unknown_provider";
    }
  | {
      outcome: "invalid_grant";
    }
  | {
      /** The provider account has no confirmed/verified primary email. */
      outcome: "verified_email_required";
    }
  | {
      outcome: "provider_error";
      message: string;
    };

export interface AuthNAdapter {
  exchangeCode(input: AuthNExchangeInput): Promise<AuthNExchangeResult>;
}
