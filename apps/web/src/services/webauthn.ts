/**
 * Passkey prompts. folio-server sends WebAuthn options as JSON with base64url strings for the
 * binary fields; the browser API wants ArrayBuffers in and hands ArrayBuffers back.
 */

type Json = Record<string, unknown>

function fromB64u(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

function toB64u(buf: ArrayBuffer | null): string | null {
  if (!buf) return null
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Descriptor = { id: string; type: 'public-key' }
const descriptors = (list: unknown): PublicKeyCredentialDescriptor[] =>
  ((list ?? []) as Descriptor[]).map((d) => ({ ...d, id: fromB64u(d.id) }))

/** The person cancelled or closed the passkey prompt, or it timed out. */
export function isCancelled(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials
}

/** Runs `navigator.credentials.create` for server options and returns the credential as JSON. */
export async function createPasskey(options: { publicKey: Json }): Promise<Json> {
  const pk = options.publicKey
  const user = pk.user as Json
  const publicKey = {
    ...pk,
    challenge: fromB64u(pk.challenge as string),
    user: { ...user, id: fromB64u(user.id as string) },
    excludeCredentials: descriptors(pk.excludeCredentials),
  } as PublicKeyCredentialCreationOptions
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential
  const res = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: toB64u(res.attestationObject),
      clientDataJSON: toB64u(res.clientDataJSON),
      transports: res.getTransports?.() ?? [],
    },
    extensions: cred.getClientExtensionResults(),
  }
}

/** Runs `navigator.credentials.get` for server options and returns the assertion as JSON. */
export async function getPasskey(options: { publicKey: Json }): Promise<Json> {
  const pk = options.publicKey
  const publicKey = {
    ...pk,
    challenge: fromB64u(pk.challenge as string),
    allowCredentials: descriptors(pk.allowCredentials),
  } as PublicKeyCredentialRequestOptions
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential
  const res = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: toB64u(res.authenticatorData),
      clientDataJSON: toB64u(res.clientDataJSON),
      signature: toB64u(res.signature),
      userHandle: toB64u(res.userHandle),
    },
    extensions: cred.getClientExtensionResults(),
  }
}
