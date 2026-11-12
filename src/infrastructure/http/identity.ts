/** Replace this provider with JWT issuer/audience/signature and ownership checks at the boundary. */
export interface ProviderIdentityPort {
  authorize(request: Request, resource: { providerId?: string; walletId?: string }): Promise<void>;
}
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
/** Challenge/local extension point; this does not authenticate or authorize any caller. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authorize(
    _request: Request,
    _resource: { providerId?: string; walletId?: string },
  ): Promise<void> {}
}
