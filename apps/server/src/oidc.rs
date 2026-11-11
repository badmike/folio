//! Sign-in through an OpenID Connect provider: authorization code flow with PKCE.

use std::sync::Arc;
use std::time::{Duration, Instant};

use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, HttpRequest, HttpResponse, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier,
    RedirectUrl, Scope, TokenResponse,
};
use tokio::sync::RwLock;

use crate::config::OidcConfig;
use crate::error::{AppError, AppResult};

type Client = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

/// The provider's endpoints and signing keys are fetched on first use and again after this
/// long, which picks up rotated keys.
const MAX_AGE: Duration = Duration::from_secs(3600);

/// Who signed in, as the provider's verified ID token states it.
#[derive(Debug)]
pub struct Profile {
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

pub struct Oidc {
    cfg: OidcConfig,
    http: reqwest::Client,
    client: RwLock<Option<(Instant, Arc<Client>)>>,
}

async fn send(http: reqwest::Client, req: HttpRequest) -> Result<HttpResponse, reqwest::Error> {
    let res = http.execute(req.try_into()?).await?;
    let mut out = HttpResponse::new(Vec::new());
    *out.status_mut() = res.status();
    *out.headers_mut() = res.headers().clone();
    *out.body_mut() = res.bytes().await?.to_vec();
    Ok(out)
}

fn upstream(what: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Upstream(format!("{what}: {e}"))
}

impl Oidc {
    pub fn new(cfg: OidcConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            // Provider responses must come from the URL we asked, not from where it points us.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client");
        Self {
            cfg,
            http,
            client: RwLock::new(None),
        }
    }

    pub fn config(&self) -> &OidcConfig {
        &self.cfg
    }

    async fn client(&self) -> AppResult<Arc<Client>> {
        if let Some((at, client)) = &*self.client.read().await {
            if at.elapsed() < MAX_AGE {
                return Ok(client.clone());
            }
        }
        let cfg = &self.cfg;
        let issuer = IssuerUrl::new(cfg.issuer.clone()).map_err(AppError::internal)?;
        let redirect = RedirectUrl::new(format!("{}/api/auth/callback", cfg.public_origin))
            .map_err(AppError::internal)?;
        let http = |req| send(self.http.clone(), req);
        let metadata = CoreProviderMetadata::discover_async(issuer, &http)
            .await
            .map_err(|e| upstream("sign-in provider discovery failed", e))?;
        let client = Arc::new(
            CoreClient::from_provider_metadata(
                metadata,
                ClientId::new(cfg.client_id.clone()),
                Some(ClientSecret::new(cfg.client_secret.clone())),
            )
            .set_redirect_uri(redirect),
        );
        *self.client.write().await = Some((Instant::now(), client.clone()));
        Ok(client)
    }

    /// Returns the provider URL to send the browser to, and the value to keep in a cookie
    /// until `finish`: the state, nonce and PKCE verifier of this attempt.
    pub async fn begin(&self) -> AppResult<(String, String)> {
        let client = self.client().await?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, state, nonce) = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .add_scope(Scope::new("email".into()))
            .add_scope(Scope::new("profile".into()))
            .set_pkce_challenge(challenge)
            .url();
        // All three are base64url, so `.` separates them safely.
        let pending = format!(
            "{}.{}.{}",
            state.secret(),
            nonce.secret(),
            verifier.secret()
        );
        Ok((url.to_string(), pending))
    }

    /// Completes a sign-in: checks the callback against `pending` (the cookie value from
    /// `begin`), exchanges the code and verifies the ID token.
    pub async fn finish(&self, code: String, state: &str, pending: &str) -> AppResult<Profile> {
        let bad = |m: &str| AppError::Unauthorized(m.to_string());
        let mut parts = pending.split('.');
        let (Some(want_state), Some(nonce), Some(verifier), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad("malformed sign-in cookie"));
        };
        if state != want_state {
            return Err(bad("sign-in state mismatch"));
        }

        let client = self.client().await?;
        let http = |req| send(self.http.clone(), req);
        let tokens = client
            .exchange_code(AuthorizationCode::new(code))
            .map_err(AppError::internal)?
            .set_pkce_verifier(PkceCodeVerifier::new(verifier.to_string()))
            .request_async(&http)
            .await
            .map_err(|e| upstream("code exchange failed", e))?;
        let id_token = tokens
            .id_token()
            .ok_or_else(|| bad("provider sent no ID token"))?;
        let claims = id_token
            .claims(&client.id_token_verifier(), &Nonce::new(nonce.to_string()))
            .map_err(|e| AppError::Unauthorized(format!("invalid ID token: {e}")))?;

        Ok(Profile {
            issuer: claims.issuer().to_string(),
            subject: claims.subject().to_string(),
            email: claims.email().map(|e| e.to_string()),
            name: claims
                .name()
                .and_then(|n| n.get(None))
                .map(|n| n.to_string()),
            picture: claims
                .picture()
                .and_then(|p| p.get(None))
                .map(|p| p.to_string()),
        })
    }
}
