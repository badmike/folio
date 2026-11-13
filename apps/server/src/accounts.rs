//! Passkey accounts: WebAuthn ceremonies, invite and reset links, recovery codes.
//!
//! Accounts are invite-only. The server admin creates invite and reset links with the
//! `folio-server invite` and `folio-server reset <user-id>` commands (see `main.rs`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};
use webauthn_rs::prelude::*;
use webauthn_rs_proto::ResidentKeyRequirement;

use crate::auth::{random_token, token_hash};
use crate::config::AccountsConfig;
use crate::error::{AppError, AppResult};
use crate::util::now_ms;

const DAY_MS: i64 = 86_400_000;
const INVITE_DAYS: i64 = 7;
const RESET_DAYS: i64 = 1;
/// A ceremony is the time between `start` and `finish` of one passkey prompt.
const CEREMONY_TTL: Duration = Duration::from_secs(300);
/// Unauthenticated callers can start sign-ins, so the pending set is capped.
const MAX_CEREMONIES: usize = 10_000;
const RECOVERY_CODES: usize = 10;
/// Crockford base32 without the letters that read like digits.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Who a passkey registration is for.
enum Enrollee {
    /// A new account, from an invite.
    Invite { token: String, name: String },
    /// An existing account, from an admin reset. Its passkeys, codes and sessions are replaced.
    Reset { token: String, user_id: String },
    /// A signed-in person adding another passkey.
    SignedIn { user_id: String },
}

enum Ceremony {
    Register {
        state: PasskeyRegistration,
        enrollee: Enrollee,
        handle: Uuid,
    },
    Login(DiscoverableAuthentication),
}

/// A finished registration. `recovery_codes` is set for a new or reset account.
pub struct Registered {
    pub user_id: String,
    pub recovery_codes: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyInfo {
    pub id: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

pub struct Accounts {
    webauthn: Webauthn,
    ceremonies: Mutex<HashMap<String, (Instant, Ceremony)>>,
}

fn rejected(m: &str) -> AppError {
    AppError::Unauthorized(m.to_string())
}

fn webauthn_failed(e: WebauthnError) -> AppError {
    AppError::Unauthorized(format!("passkey check failed: {e}"))
}

/// Recovery codes look like `7KQ2-M9XD-4TRB`: 60 random bits.
fn new_recovery_code() -> String {
    let bits: u64 = rand::random();
    let chars: String = (0..12)
        .map(|i| CODE_ALPHABET[((bits >> (i * 5)) & 31) as usize] as char)
        .collect();
    format!("{}-{}-{}", &chars[..4], &chars[4..8], &chars[8..])
}

/// The form a recovery code is hashed in: what people type, without separators and with
/// the look-alike letters read as digits.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

async fn replace_recovery_codes(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
) -> AppResult<Vec<String>> {
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| new_recovery_code()).collect();
    for code in &codes {
        sqlx::query("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)")
            .bind(token_hash(&normalize_code(code)))
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(codes)
}

/// Consumes a live enrollment. `user_id` is `None` for an invite.
async fn take_enrollment(
    tx: &mut Transaction<'_, Sqlite>,
    token: &str,
    user_id: Option<&str>,
) -> AppResult<()> {
    let taken = sqlx::query(
        "DELETE FROM enrollments WHERE token_hash = ? AND user_id IS ? AND expires_at > ?",
    )
    .bind(token_hash(token))
    .bind(user_id)
    .bind(now_ms())
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if taken == 1 {
        Ok(())
    } else {
        Err(rejected("this link has expired or was already used"))
    }
}

/// Creates an invite (`user_id` `None`) or a reset link for `user_id`. Returns the link's
/// path, `/#invite=<token>` or `/#reset=<token>`: the fragment keeps the token out of logs.
pub async fn create_link(db: &SqlitePool, user_id: Option<&str>) -> AppResult<String> {
    let now = now_ms();
    let days = if user_id.is_some() {
        RESET_DAYS
    } else {
        INVITE_DAYS
    };
    sqlx::query("DELETE FROM enrollments WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    let token = random_token();
    sqlx::query(
        "INSERT INTO enrollments (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(now)
    .bind(now + days * DAY_MS)
    .execute(db)
    .await?;
    let kind = if user_id.is_some() { "reset" } else { "invite" };
    Ok(format!("/#{kind}={token}"))
}

/// What a live enrollment token is for, if it is one.
async fn enrollment(db: &SqlitePool, token: &str) -> AppResult<Option<Option<String>>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT user_id FROM enrollments WHERE token_hash = ? AND expires_at > ?")
            .bind(token_hash(token))
            .bind(now_ms())
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(user_id,)| user_id))
}

pub async fn passkeys(db: &SqlitePool, user_id: &str) -> AppResult<Vec<PasskeyInfo>> {
    let rows: Vec<(String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, created_at, last_used_at)| PasskeyInfo {
            id,
            created_at,
            last_used_at,
        })
        .collect())
}

/// Removes one of the user's passkeys. The last one stays, so the account keeps a way in
/// besides its recovery codes.
pub async fn delete_passkey(db: &SqlitePool, user_id: &str, id: &str) -> AppResult<()> {
    let mut tx = db.begin().await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM passkeys WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    let deleted = sqlx::query("DELETE FROM passkeys WHERE user_id = ? AND id = ?")
        .bind(user_id)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound("no such passkey".into()));
    }
    if count <= 1 {
        return Err(AppError::Conflict(
            "an account keeps at least one passkey".into(),
        ));
    }
    tx.commit().await?;
    Ok(())
}

pub async fn recovery_codes_left(db: &SqlitePool, user_id: &str) -> AppResult<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await?;
    Ok(n)
}

/// Replaces the user's recovery codes and returns the new ones.
pub async fn new_recovery_codes(db: &SqlitePool, user_id: &str) -> AppResult<Vec<String>> {
    let mut tx = db.begin().await?;
    let codes = replace_recovery_codes(&mut tx, user_id).await?;
    tx.commit().await?;
    Ok(codes)
}

/// Signs in with a recovery code and uses it up. Returns the user it belongs to.
pub async fn recover(db: &SqlitePool, code: &str) -> AppResult<String> {
    let row: Option<(String,)> =
        sqlx::query_as("DELETE FROM recovery_codes WHERE code_hash = ? RETURNING user_id")
            .bind(token_hash(&normalize_code(code)))
            .fetch_optional(db)
            .await?;
    row.map(|(user_id,)| user_id)
        .ok_or_else(|| rejected("unknown recovery code"))
}

impl Accounts {
    pub fn new(cfg: &AccountsConfig) -> anyhow::Result<Self> {
        let origin = Url::parse(&cfg.public_origin)?;
        let webauthn = WebauthnBuilder::new(&cfg.rp_id, &origin)?
            .rp_name("folio")
            .build()?;
        Ok(Self {
            webauthn,
            ceremonies: Mutex::new(HashMap::new()),
        })
    }

    fn put(&self, ceremony: Ceremony) -> AppResult<String> {
        let mut all = self.ceremonies.lock().unwrap();
        all.retain(|_, (at, _)| at.elapsed() < CEREMONY_TTL);
        if all.len() >= MAX_CEREMONIES {
            return Err(AppError::RateLimited(
                "too many sign-ins in progress".into(),
            ));
        }
        let id = random_token();
        all.insert(id.clone(), (Instant::now(), ceremony));
        Ok(id)
    }

    fn take(&self, id: &str) -> AppResult<Ceremony> {
        self.ceremonies
            .lock()
            .unwrap()
            .remove(id)
            .filter(|(at, _)| at.elapsed() < CEREMONY_TTL)
            .map(|(_, c)| c)
            .ok_or_else(|| rejected("the passkey prompt expired, please try again"))
    }

    /// Starts registering a passkey from an invite or reset link. `name` is the new account's
    /// display name and only read for invites.
    pub async fn start_enrollment(
        &self,
        db: &SqlitePool,
        token: String,
        name: Option<String>,
    ) -> AppResult<(String, CreationChallengeResponse)> {
        let enrollee = match enrollment(db, &token).await? {
            None => return Err(rejected("this link has expired or was already used")),
            Some(Some(user_id)) => Enrollee::Reset { token, user_id },
            Some(None) => {
                let name = name.map(|n| n.trim().to_string()).unwrap_or_default();
                if name.is_empty() || name.chars().count() > 80 {
                    return Err(AppError::BadRequest(
                        "a name of 1 to 80 characters is needed".into(),
                    ));
                }
                Enrollee::Invite { token, name }
            }
        };
        self.start_registration(db, enrollee).await
    }

    /// Starts registering another passkey for a signed-in user.
    pub async fn start_adding(
        &self,
        db: &SqlitePool,
        user_id: String,
    ) -> AppResult<(String, CreationChallengeResponse)> {
        self.start_registration(db, Enrollee::SignedIn { user_id })
            .await
    }

    async fn start_registration(
        &self,
        db: &SqlitePool,
        enrollee: Enrollee,
    ) -> AppResult<(String, CreationChallengeResponse)> {
        let (handle, name, exclude) = match &enrollee {
            Enrollee::Invite { name, .. } => (Uuid::new_v4(), name.clone(), Vec::new()),
            Enrollee::Reset { user_id, .. } | Enrollee::SignedIn { user_id } => {
                let (name, handle): (Option<String>, Option<String>) =
                    sqlx::query_as("SELECT name, passkey_handle FROM users WHERE id = ?")
                        .bind(user_id)
                        .fetch_optional(db)
                        .await?
                        .ok_or_else(|| rejected("unknown account"))?;
                let handle = handle
                    .and_then(|h| Uuid::parse_str(&h).ok())
                    .unwrap_or_else(Uuid::new_v4);
                // A reset replaces every passkey, so the old ones may be registered again.
                let exclude = match enrollee {
                    Enrollee::Reset { .. } => Vec::new(),
                    _ => self.credential_ids(db, user_id).await?,
                };
                (handle, name.unwrap_or_else(|| "folio".into()), exclude)
            }
        };
        let (mut options, state) = self
            .webauthn
            .start_passkey_registration(handle, &name, &name, Some(exclude))
            .map_err(AppError::internal)?;
        // Sign-in asks for no user name, so the passkey must be discoverable.
        if let Some(sel) = options.public_key.authenticator_selection.as_mut() {
            sel.require_resident_key = true;
            sel.resident_key = Some(ResidentKeyRequirement::Required);
        }
        let id = self.put(Ceremony::Register {
            state,
            enrollee,
            handle,
        })?;
        Ok((id, options))
    }

    async fn credential_ids(&self, db: &SqlitePool, user_id: &str) -> AppResult<Vec<CredentialID>> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT id FROM passkeys WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(db)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id,)| B64U.decode(id).ok())
            .collect())
    }

    /// Verifies the new passkey and stores it. Adding a passkey needs `signed_in` to be the
    /// account the ceremony started for.
    pub async fn finish_registration(
        &self,
        db: &SqlitePool,
        ceremony: &str,
        credential: &RegisterPublicKeyCredential,
        signed_in: Option<&str>,
    ) -> AppResult<Registered> {
        let Ceremony::Register {
            state,
            enrollee,
            handle,
        } = self.take(ceremony)?
        else {
            return Err(rejected("not a passkey registration"));
        };
        let passkey = self
            .webauthn
            .finish_passkey_registration(credential, &state)
            .map_err(webauthn_failed)?;

        let now = now_ms();
        let mut tx = db.begin().await?;
        let (user_id, fresh_codes) = match enrollee {
            Enrollee::Invite { token, name } => {
                take_enrollment(&mut tx, &token, None).await?;
                let user_id = format!("u_{}", Uuid::new_v4().simple());
                sqlx::query(
                    "INSERT INTO users (id, created_at, name, passkey_handle) VALUES (?, ?, ?, ?)",
                )
                .bind(&user_id)
                .bind(now)
                .bind(&name)
                .bind(handle.to_string())
                .execute(&mut *tx)
                .await?;
                (user_id, true)
            }
            Enrollee::Reset { token, user_id } => {
                take_enrollment(&mut tx, &token, Some(&user_id)).await?;
                for delete in [
                    "DELETE FROM passkeys WHERE user_id = ?",
                    "DELETE FROM sessions WHERE user_id = ?",
                ] {
                    sqlx::query(delete).bind(&user_id).execute(&mut *tx).await?;
                }
                (user_id, true)
            }
            Enrollee::SignedIn { user_id } => {
                if signed_in != Some(user_id.as_str()) {
                    return Err(rejected("signed in as someone else"));
                }
                (user_id, false)
            }
        };
        // Accounts from before passkeys (dev or Clerk ids) get their handle with the first passkey.
        sqlx::query("UPDATE users SET passkey_handle = ? WHERE id = ? AND passkey_handle IS NULL")
            .bind(handle.to_string())
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        let stored = sqlx::query(
            "INSERT INTO passkeys (id, user_id, passkey, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(B64U.encode(passkey.cred_id()))
        .bind(&user_id)
        .bind(serde_json::to_string(&passkey).map_err(AppError::internal)?)
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if stored == 0 {
            return Err(AppError::Conflict(
                "this passkey is already registered".into(),
            ));
        }
        let recovery_codes = if fresh_codes {
            Some(replace_recovery_codes(&mut tx, &user_id).await?)
        } else {
            None
        };
        tx.commit().await?;
        Ok(Registered {
            user_id,
            recovery_codes,
        })
    }

    /// Starts a sign-in with any passkey of this site; the browser lets the person pick one.
    pub fn start_login(&self) -> AppResult<(String, RequestChallengeResponse)> {
        let (mut options, state) = self
            .webauthn
            .start_discoverable_authentication()
            .map_err(AppError::internal)?;
        // A button starts the sign-in, there is no user name field to autofill into.
        options.mediation = None;
        let id = self.put(Ceremony::Login(state))?;
        Ok((id, options))
    }

    /// Verifies the passkey's signature. Returns the user it belongs to.
    pub async fn finish_login(
        &self,
        db: &SqlitePool,
        ceremony: &str,
        credential: &PublicKeyCredential,
    ) -> AppResult<String> {
        let Ceremony::Login(state) = self.take(ceremony)? else {
            return Err(rejected("not a passkey sign-in"));
        };
        let (handle, cred_id) = self
            .webauthn
            .identify_discoverable_authentication(credential)
            .map_err(webauthn_failed)?;
        let id = B64U.encode(cred_id);
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT p.user_id, p.passkey FROM passkeys p JOIN users u ON u.id = p.user_id
             WHERE p.id = ? AND u.passkey_handle = ?",
        )
        .bind(&id)
        .bind(handle.to_string())
        .fetch_optional(db)
        .await?;
        let (user_id, stored) = row.ok_or_else(|| rejected("unknown passkey"))?;
        let mut passkey: Passkey = serde_json::from_str(&stored).map_err(AppError::internal)?;
        let result = self
            .webauthn
            .finish_discoverable_authentication_v2(credential, state, &passkey)
            .map_err(webauthn_failed)?;
        passkey.update_credential(&result);
        sqlx::query("UPDATE passkeys SET passkey = ?, last_used_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&passkey).map_err(AppError::internal)?)
            .bind(now_ms())
            .bind(&id)
            .execute(db)
            .await?;
        Ok(user_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_codes_survive_sloppy_typing() {
        let code = new_recovery_code();
        assert_eq!(code.len(), 14);
        let typed = code.to_lowercase().replace('-', " ").replace('0', "o");
        assert_eq!(normalize_code(&typed), normalize_code(&code));
    }
}
