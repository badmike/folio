//! Tiny in-memory fixed-window per-key rate limiter.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    limit: u32,
    window: Duration,
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    /// `limit` events per minute per key.
    pub fn new(limit: u32) -> Self {
        Self::with_window(limit, Duration::from_secs(60))
    }

    pub fn with_window(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Returns true if the event is allowed.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap();
        if hits.len() > 10_000 {
            let w = self.window;
            hits.retain(|_, (t, _)| now.duration_since(*t) < w);
        }
        let e = hits.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(e.0) >= self.window {
            *e = (now, 0);
        }
        if e.1 >= self.limit {
            return false;
        }
        e.1 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_key() {
        let r = RateLimiter::with_window(2, Duration::from_secs(60));
        assert!(r.check("a"));
        assert!(r.check("a"));
        assert!(!r.check("a"));
        assert!(r.check("b"));
    }

    #[test]
    fn window_resets() {
        let r = RateLimiter::with_window(1, Duration::from_millis(20));
        assert!(r.check("a"));
        assert!(!r.check("a"));
        std::thread::sleep(Duration::from_millis(30));
        assert!(r.check("a"));
    }
}
