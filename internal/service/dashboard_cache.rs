use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::{watch, Mutex, Semaphore};

type SharedResult<T> = Result<Arc<T>, Arc<str>>;
type Pending<T> = watch::Receiver<Option<SharedResult<T>>>;

enum Entry<T> {
    Loading(Pending<T>),
    Ready {
        payload: Arc<T>,
        completed_at: Instant,
        expires_at: Instant,
    },
}

/// In-process report cache. Identical requests share one task, including when
/// the initiating HTTP client disconnects. Freshness starts after computation.
pub(super) struct DashboardCache<T> {
    entries: Mutex<HashMap<String, Entry<T>>>,
    computations: Semaphore,
    capacity: usize,
    timeout: Duration,
}

impl<T: Send + Sync + 'static> DashboardCache<T> {
    pub(super) fn new(
        capacity: usize,
        concurrent_computations: usize,
        timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            computations: Semaphore::new(concurrent_computations.max(1)),
            capacity: capacity.max(1),
            timeout,
        })
    }

    pub(super) async fn len(&self) -> usize {
        self.entries
            .lock()
            .await
            .values()
            .filter(|entry| {
                matches!(entry,
            Entry::Ready { expires_at, .. } if *expires_at > Instant::now())
            })
            .count()
    }

    pub(super) async fn get_or_load<F>(
        self: &Arc<Self>,
        key: String,
        ttl: Duration,
        load: F,
    ) -> anyhow::Result<Arc<T>>
    where
        F: Future<Output = anyhow::Result<T>> + Send + 'static,
    {
        let mut entries = self.entries.lock().await;
        let now = Instant::now();
        entries.retain(|_, entry| match entry {
            Entry::Loading(_) => true,
            Entry::Ready { expires_at, .. } => *expires_at > now,
        });
        let mut receiver = match entries.get(&key) {
            Some(Entry::Ready { payload, .. }) => {
                tracing::debug!(cache = "hit", "dashboard cache");
                return Ok(Arc::clone(payload));
            }
            Some(Entry::Loading(receiver)) => {
                tracing::debug!(cache = "joined", "dashboard cache");
                receiver.clone()
            }
            None => {
                if entries.len() >= self.capacity {
                    let oldest = entries
                        .iter()
                        .filter_map(|(key, entry)| match entry {
                            Entry::Ready { completed_at, .. } => Some((key.clone(), *completed_at)),
                            Entry::Loading(_) => None,
                        })
                        .min_by_key(|(_, completed_at)| *completed_at)
                        .map(|(key, _)| key);
                    if let Some(oldest) = oldest {
                        entries.remove(&oldest);
                    } else {
                        anyhow::bail!("Report queue is busy; please retry shortly");
                    }
                }
                let (sender, receiver) = watch::channel(None);
                entries.insert(key.clone(), Entry::Loading(receiver.clone()));
                let cache = Arc::clone(self);
                // The outer task publishes errors even if the calculation panics.
                // Neither task is tied to the lifetime of a single HTTP request.
                tokio::spawn(async move {
                    let queued_at = Instant::now();
                    let _permit = cache
                        .computations
                        .acquire()
                        .await
                        .expect("cache semaphore is not closed");
                    let started_at = Instant::now();
                    let mut calculation = tokio::spawn(load);
                    let result: SharedResult<T> = match tokio::time::timeout(
                        cache.timeout,
                        &mut calculation,
                    )
                    .await
                    {
                        Ok(Ok(Ok(payload))) => Ok(Arc::new(payload)),
                        Ok(Ok(Err(error))) => Err(Arc::from(format!("{error:#}"))),
                        Ok(Err(_)) => Err(Arc::from("Report calculation did not complete")),
                        Err(_) => {
                            // Dropping a JoinHandle detaches its task. Abort and
                            // join it before releasing the database-work permit,
                            // so an expired report cannot keep running behind
                            // the replacement calculation.
                            calculation.abort();
                            let _ = calculation.await;
                            Err(Arc::from("Report calculation timed out; please retry or choose a shorter window"))
                        }
                    };
                    let completed_at = Instant::now();
                    tracing::info!(
                        query = "dashboard",
                        elapsed_ms = started_at.elapsed().as_millis() as u64,
                        queue_ms = started_at.duration_since(queued_at).as_millis() as u64,
                        success = result.is_ok(),
                        "report calculation completed"
                    );
                    let mut entries = cache.entries.lock().await;
                    if let Ok(payload) = &result {
                        if !ttl.is_zero() {
                            entries.insert(
                                key.clone(),
                                Entry::Ready {
                                    payload: Arc::clone(payload),
                                    completed_at,
                                    expires_at: completed_at
                                        .checked_add(ttl)
                                        .unwrap_or(completed_at),
                                },
                            );
                        } else {
                            entries.remove(&key);
                        }
                    } else {
                        entries.remove(&key);
                    }
                    sender.send_replace(Some(result));
                });
                receiver
            }
        };
        drop(entries);
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result.map_err(|message| anyhow::anyhow!(message.to_string()));
            }
            receiver
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("Report calculation was interrupted"))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn a_calculation_longer_than_ttl_is_cached_after_it_finishes() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let ttl = Duration::from_millis(100);
        let first = cache
            .get_or_load("24h".into(), ttl, async {
                tokio::time::sleep(Duration::from_millis(150)).await;
                Ok(42)
            })
            .await
            .unwrap();
        let second = cache
            .get_or_load("24h".into(), ttl, async {
                anyhow::bail!("a completed report must be reused")
            })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_calculation_after_caller_cancellation() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let (started, waiting) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let producer_cache = Arc::clone(&cache);
        let caller = tokio::spawn(async move {
            producer_cache
                .get_or_load("same-filter".into(), Duration::from_secs(60), async move {
                    started.send(()).unwrap();
                    blocked.await.unwrap();
                    Ok(73)
                })
                .await
        });
        waiting.await.unwrap();
        caller.abort();
        let mut waiters = Vec::new();
        for _ in 0..12 {
            let cache = Arc::clone(&cache);
            waiters.push(tokio::spawn(async move {
                cache
                    .get_or_load("same-filter".into(), Duration::from_secs(60), async {
                        anyhow::bail!("duplicate calculation")
                    })
                    .await
                    .unwrap()
            }));
        }
        release.send(()).unwrap();
        for waiter in waiters {
            assert_eq!(*waiter.await.unwrap(), 73);
        }
        assert_eq!(cache.len().await, 1);
    }

    #[tokio::test]
    async fn expired_results_recompute_and_filters_stay_isolated() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        cache
            .get_or_load("post".into(), Duration::from_secs(60), async { Ok(7) })
            .await
            .unwrap();
        cache
            .get_or_load("get".into(), Duration::from_secs(60), async { Ok(9) })
            .await
            .unwrap();
        if let Some(Entry::Ready { expires_at, .. }) = cache.entries.lock().await.get_mut("post") {
            *expires_at = Instant::now();
        }
        assert_eq!(
            *cache
                .get_or_load("post".into(), Duration::from_secs(60), async { Ok(8) })
                .await
                .unwrap(),
            8
        );
        assert_eq!(
            *cache
                .get_or_load("get".into(), Duration::from_secs(60), async { Ok(0) })
                .await
                .unwrap(),
            9
        );
    }

    #[tokio::test]
    async fn errors_and_panics_allow_retry() {
        let cache = DashboardCache::<i32>::new(4, 1, Duration::from_secs(5));
        assert!(cache
            .get_or_load("failure".into(), Duration::from_secs(60), async {
                anyhow::bail!("database unavailable")
            })
            .await
            .is_err());
        assert!(cache
            .get_or_load("failure".into(), Duration::from_secs(60), async {
                panic!("simulated query panic");
            })
            .await
            .is_err());
        assert_eq!(
            *cache
                .get_or_load("failure".into(), Duration::from_secs(60), async { Ok(1) })
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn different_filters_obey_the_database_work_limit() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let running = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for key in ["a", "b", "c"] {
            let (cache, running, maximum) = (
                Arc::clone(&cache),
                Arc::clone(&running),
                Arc::clone(&maximum),
            );
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_load(key.into(), Duration::from_secs(60), async move {
                        let active = running.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(active, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                        Ok(key)
                    })
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cache_size_is_bounded_and_zero_ttl_disables_reuse() {
        let cache = DashboardCache::new(2, 1, Duration::from_secs(5));
        for index in 0..6 {
            cache
                .get_or_load(index.to_string(), Duration::from_secs(60), async move {
                    Ok(index)
                })
                .await
                .unwrap();
        }
        assert_eq!(cache.len().await, 2);
        cache
            .get_or_load("uncached".into(), Duration::ZERO, async { Ok(1) })
            .await
            .unwrap();
        assert_eq!(
            *cache
                .get_or_load("uncached".into(), Duration::ZERO, async { Ok(2) })
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn timed_out_calculation_is_dropped_before_queued_work_and_can_retry() {
        struct DropNotice(Arc<AtomicUsize>);
        impl Drop for DropNotice {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let cache = DashboardCache::<i32>::new(4, 1, Duration::from_millis(100));
        let dropped = Arc::new(AtomicUsize::new(0));
        let (started, waiting) = oneshot::channel();
        let stalled_cache = Arc::clone(&cache);
        let stalled_dropped = Arc::clone(&dropped);
        let stalled = tokio::spawn(async move {
            stalled_cache
                .get_or_load("stalled".into(), Duration::from_secs(60), async move {
                    let _drop_notice = DropNotice(stalled_dropped);
                    started.send(()).unwrap();
                    std::future::pending::<anyhow::Result<i32>>().await
                })
                .await
        });
        waiting.await.unwrap();

        let queued_cache = Arc::clone(&cache);
        let queued_dropped = Arc::clone(&dropped);
        let queued = tokio::spawn(async move {
            queued_cache
                .get_or_load(
                    "different-filter".into(),
                    Duration::from_secs(60),
                    async move {
                        assert_eq!(
                            queued_dropped.load(Ordering::SeqCst),
                            1,
                            "expired work must be dropped before its permit is reused"
                        );
                        Ok(9)
                    },
                )
                .await
        });

        let error = tokio::time::timeout(Duration::from_secs(3), stalled)
            .await
            .expect("stalled request must terminate")
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(
            *tokio::time::timeout(Duration::from_secs(3), queued)
                .await
                .expect("queued work must resume")
                .unwrap()
                .unwrap(),
            9
        );
        assert_eq!(
            *cache
                .get_or_load("stalled".into(), Duration::from_secs(60), async { Ok(11) })
                .await
                .unwrap(),
            11
        );
    }

    #[tokio::test]
    async fn full_loading_capacity_rejects_new_keys_but_existing_requests_can_join() {
        let cache = DashboardCache::<i32>::new(1, 1, Duration::from_secs(5));
        let (started, waiting) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let producer_cache = Arc::clone(&cache);
        let producer = tokio::spawn(async move {
            producer_cache
                .get_or_load("active".into(), Duration::from_secs(60), async move {
                    started.send(()).unwrap();
                    blocked.await.unwrap();
                    Ok(17)
                })
                .await
        });
        waiting.await.unwrap();

        let error = cache
            .get_or_load("new-filter".into(), Duration::from_secs(60), async {
                panic!("a full queue must reject new calculations");
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("queue is busy"));

        let joined = cache.get_or_load("active".into(), Duration::from_secs(60), async {
            panic!("the joined request must reuse the existing calculation");
        });
        tokio::pin!(joined);
        tokio::select! {
            biased;
            result = &mut joined => panic!("joined request must wait for its producer: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }

        release.send(()).unwrap();
        assert_eq!(*joined.await.unwrap(), 17);
        assert_eq!(*producer.await.unwrap().unwrap(), 17);
        assert_eq!(
            *cache
                .get_or_load("new-filter".into(), Duration::from_secs(60), async {
                    Ok(19)
                })
                .await
                .unwrap(),
            19
        );
        assert_eq!(cache.len().await, 1);
    }
}
