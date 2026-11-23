export type Plan = 'free' | 'pro';

export interface AccountUser {
  id: string;
  email: string;
  displayName: string | null;
  plan: Plan;
}

export interface AccountState {
  enabled: boolean;
  signedIn: boolean;
  user: AccountUser | null;
  oauth: { google: boolean; github: boolean };
  email: boolean;
  pendingEmail: string | null;
}

export const SIGNED_OUT: AccountState = {
  enabled: false, signedIn: false, user: null, oauth: { google: false, github: false }, email: false, pendingEmail: null,
};
