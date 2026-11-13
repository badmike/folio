//! Admin commands: `folio-server invite`, `folio-server reset <user-id>`, `folio-server users`.
//! They run against the configured database and print to stdout, e.g. through
//! `docker exec <container> folio-server invite`.

use crate::accounts;
use crate::config::Config;
use crate::db;

pub const USAGE: &str = "usage: folio-server [invite | reset <user-id> | users]
  invite           print a link that creates one account (valid 7 days)
  reset <user-id>  print a link that replaces the account's passkeys and recovery codes (valid 1 day)
  users            list accounts";

pub async fn run(config: &Config, args: &[String]) -> anyhow::Result<()> {
    let Some(accounts) = &config.accounts else {
        anyhow::bail!("accounts need FOLIO_PUBLIC_URL");
    };
    let pool = db::connect(&config.database_url).await?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["invite"] => {
            let path = accounts::create_link(&pool, None).await?;
            println!("{}{path}", accounts.public_origin);
        }
        ["reset", user_id] => {
            let known: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE id = ?")
                .bind(user_id)
                .fetch_optional(&pool)
                .await?;
            anyhow::ensure!(
                known.is_some(),
                "no account {user_id}, see `folio-server users`"
            );
            let path = accounts::create_link(&pool, Some(user_id)).await?;
            println!("{}{path}", accounts.public_origin);
        }
        ["users"] => {
            let rows: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
                "SELECT u.id, u.name, u.created_at, COUNT(p.id) FROM users u
                 LEFT JOIN passkeys p ON p.user_id = u.id GROUP BY u.id ORDER BY u.created_at",
            )
            .fetch_all(&pool)
            .await?;
            println!("id\tname\tcreated\tpasskeys");
            for (id, name, created_at, passkeys) in rows {
                let created = crate::util::utc_day(created_at);
                println!("{id}\t{}\t{created}\t{passkeys}", name.unwrap_or_default());
            }
        }
        _ => anyhow::bail!("{USAGE}"),
    }
    Ok(())
}
