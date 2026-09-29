use crate::error::AppError;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UTC day string `YYYY-MM-DD` for quota bucketing.
pub fn utc_day(ms: i64) -> String {
    // Civil-from-days (Howard Hinnant).
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Ids (doc ids, device ids, asset ids): 1..=128 chars of `[A-Za-z0-9_.:-]`.
pub fn validate_id(kind: &str, s: &str) -> Result<(), AppError> {
    let ok = !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "invalid {kind}: must be 1-128 characters of [A-Za-z0-9_.:-]"
        )))
    }
}

/// Object-store key segment that is safe for any backend.
pub fn seg(s: &str) -> String {
    hex::encode(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_formatting() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_709_164_800_000), "2024-02-29");
        assert_eq!(utc_day(1_709_251_199_999), "2024-02-29");
        assert_eq!(utc_day(1_709_251_200_000), "2024-03-01");
    }

    #[test]
    fn ids() {
        assert!(validate_id("docId", "workspace").is_ok());
        assert!(validate_id("docId", "nb_01H:x.y-z").is_ok());
        assert!(validate_id("docId", "").is_err());
        assert!(validate_id("docId", "../x").is_err());
        assert!(validate_id("docId", &"a".repeat(129)).is_err());
    }
}
