//! Vendor-neutral object storage: any S3-compatible service, or a local directory.

use std::sync::Arc;

use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::ObjectStore;

use crate::config::StorageConfig;

pub fn build(cfg: &StorageConfig) -> anyhow::Result<Arc<dyn ObjectStore>> {
    match cfg {
        StorageConfig::Local(dir) => {
            std::fs::create_dir_all(dir)?;
            Ok(Arc::new(LocalFileSystem::new_with_prefix(dir)?))
        }
        StorageConfig::S3(s3) => {
            let mut b = AmazonS3Builder::new().with_bucket_name(&s3.bucket).with_region(&s3.region);
            if let Some(ep) = &s3.endpoint {
                b = b.with_endpoint(ep).with_allow_http(ep.starts_with("http://"));
            }
            if let (Some(k), Some(s)) = (&s3.access_key_id, &s3.secret_access_key) {
                b = b.with_access_key_id(k).with_secret_access_key(s);
            }
            Ok(Arc::new(b.build()?))
        }
    }
}
