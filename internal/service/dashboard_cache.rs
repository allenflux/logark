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

    // Keep the fixed-TTL adapter for the existing cache behavior tests.
    #[cfg(test)]
    pub(super) async fn get_or_load<F>(
        self: &Arc<Self>,
        key: String,
        ttl: Duration,
        load: F,
    ) -> anyhow::Result<Arc<T>>
    where
        F: Future<Output = anyhow::Result<T>> + Send + 'static,
    {
        self.get_or_load_with_ttl(key, async move { Ok((load.await?, ttl)) })
            .await
    }

    /// Compatibility adapter for loaders without a separate shared-cache step.
    #[allow(dead_code)]
    pub(super) async fn get_or_load_with_ttl<F>(
        self: &Arc<Self>,
        key: String,
        load: F,
    ) -> anyhow::Result<Arc<T>>
    where
        F: Future<Output = anyhow::Result<(T, Duration)>> + Send + 'static,
    {
        self.get_or_load_with_cache(key, async { None }, load).await
    }

    /// Look up a shared result before queueing database work. Both stages are
    /// coalesced per key and survive cancellation of an individual HTTP waiter.
    /// A hit supplies the lesser of its remaining TTL and the configured L1 TTL.
    pub(super) async fn get_or_load_with_cache<L, F>(
        self: &Arc<Self>,
        key: String,
        lookup: L,
        load: F,
    ) -> anyhow::Result<Arc<T>>
    where
        L: Future<Output = Option<(T, Duration)>> + Send + 'static,
        F: Future<Output = anyhow::Result<(T, Duration)>> + Send + 'static,
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
                    let mut lookup_task = tokio::spawn(async move {
                        let (payload, ttl) = lookup.await?;
                        let loaded_at = Instant::now();
                        let expires_at = loaded_at.checked_add(ttl).unwrap_or(loaded_at);
                        Some((payload, expires_at))
                    });
                    // Redis has its own short operation timeout. This hard cap
                    // also prevents a faulty lookup from occupying Loading forever.
                    let lookup_timeout = cache.timeout.min(Duration::from_secs(1));
                    let cached = match tokio::time::timeout(lookup_timeout, &mut lookup_task).await
                    {
                        Ok(Ok(hit)) => hit,
                        Ok(Err(_)) => None,
                        Err(_) => {
                            lookup_task.abort();
                            let _ = lookup_task.await;
                            None
                        }
                    };
                    let lookup_finished_at = Instant::now();
                    let lookup_ms = lookup_finished_at.duration_since(queued_at).as_millis() as u64;
                    let (result, expires_at, started_at, source): (
                        SharedResult<T>,
                        Option<Instant>,
                        Instant,
                        &'static str,
                    ) = if let Some((payload, expires_at)) = cached {
                        (
                            Ok(Arc::new(payload)),
                            Some(expires_at),
                            queued_at,
                            "shared_cache",
                        )
                    } else {
                        // Only an actual SQL miss waits for a database-work slot.
                        let _permit = cache
                            .computations
                            .acquire()
                            .await
                            .expect("cache semaphore is not closed");
                        let started_at = Instant::now();
                        let mut calculation = tokio::spawn(async move {
                            let (payload, ttl) = load.await?;
                            let loaded_at = Instant::now();
                            // Capture the deadline in the loader task so scheduler
                            // or cache-lock delays cannot extend a short-lived hit.
                            let expires_at = loaded_at.checked_add(ttl).unwrap_or(loaded_at);
                            Ok::<_, anyhow::Error>((payload, expires_at))
                        });
                        let (result, expires_at) = match tokio::time::timeout(
                            cache.timeout,
                            &mut calculation,
                        )
                        .await
                        {
                            Ok(Ok(Ok((payload, expires_at)))) => {
                                (Ok(Arc::new(payload)), Some(expires_at))
                            }
                            Ok(Ok(Err(error))) => (Err(Arc::from(format!("{error:#}"))), None),
                            Ok(Err(_)) => {
                                (Err(Arc::from("Report calculation did not complete")), None)
                            }
                            Err(_) => {
                                // Stop the Rust task before releasing its permit.
                                // A query already sent to MySQL can continue on
                                // the server while SQLx recovers its connection.
                                calculation.abort();
                                let _ = calculation.await;
                                (Err(Arc::from("Report calculation timed out; please retry or choose a shorter window")), None)
                            }
                        };
                        (result, expires_at, started_at, "database")
                    };
                    let completed_at = Instant::now();
                    tracing::info!(
                        query = "dashboard",
                        source,
                        lookup_ms,
                        elapsed_ms = started_at.elapsed().as_millis() as u64,
                        queue_ms = started_at
                            .saturating_duration_since(lookup_finished_at)
                            .as_millis() as u64,
                        success = result.is_ok(),
                        "report calculation completed"
                    );
                    let mut entries = cache.entries.lock().await;
                    if let (Ok(payload), Some(expires_at)) = (&result, expires_at) {
                        if expires_at > Instant::now() {
                            entries.insert(
                                key.clone(),
                                Entry::Ready {
                                    payload: Arc::clone(payload),
                                    completed_at,
                                    expires_at,
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
    async fn shared_hit_bypasses_a_different_keys_busy_database_slot() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let (started, waiting) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let busy_cache = Arc::clone(&cache);
        let busy = tokio::spawn(async move {
            busy_cache
                .get_or_load("cold".into(), Duration::from_secs(60), async move {
                    started.send(()).unwrap();
                    blocked.await.unwrap();
                    Ok(17)
                })
                .await
        });
        waiting.await.unwrap();
        let hit = tokio::time::timeout(
            Duration::from_millis(200),
            cache.get_or_load_with_cache(
                "shared".into(),
                async { Some((42, Duration::from_secs(10))) },
                async { panic!("an L2 hit must not execute SQL") },
            ),
        )
        .await
        .expect("a shared hit must not wait for the occupied SQL permit")
        .unwrap();
        assert_eq!(*hit, 42);
        assert!(!busy.is_finished());
        release.send(()).unwrap();
        assert_eq!(*busy.await.unwrap().unwrap(), 17);
    }

    #[tokio::test]
    async fn shared_lookup_is_coalesced_and_survives_caller_cancellation() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let (started, waiting) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let producer_cache = Arc::clone(&cache);
        let caller = tokio::spawn(async move {
            producer_cache
                .get_or_load_with_cache(
                    "same-filter".into(),
                    async move {
                        started.send(()).unwrap();
                        blocked.await.unwrap();
                        Some((73, Duration::from_secs(60)))
                    },
                    async { panic!("a shared hit must not calculate") },
                )
                .await
        });
        waiting.await.unwrap();
        caller.abort();
        let joiner_cache = Arc::clone(&cache);
        let joiner = tokio::spawn(async move {
            joiner_cache
                .get_or_load_with_cache(
                    "same-filter".into(),
                    async { panic!("the same-key shared lookup must be joined") },
                    async { panic!("the same-key result must be shared") },
                )
                .await
        });
        release.send(()).unwrap();
        assert_eq!(*joiner.await.unwrap().unwrap(), 73);
    }

    #[tokio::test]
    async fn a_panicking_or_stalled_shared_lookup_falls_back_to_bounded_sql() {
        let cache = DashboardCache::new(4, 1, Duration::from_millis(40));
        assert_eq!(
            *cache
                .get_or_load_with_cache(
                    "panic".into(),
                    async { panic!("simulated shared-cache panic") },
                    async { Ok((9, Duration::from_secs(60))) },
                )
                .await
                .unwrap(),
            9
        );
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            cache.get_or_load_with_cache("stalled".into(), std::future::pending(), async {
                Ok((11, Duration::from_secs(60)))
            }),
        )
        .await
        .expect("a stalled shared lookup must become a miss")
        .unwrap();
        assert_eq!(*result, 11);
    }

    #[tokio::test]
    async fn a_shared_result_keeps_its_short_remaining_ttl_without_renewal() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let remaining_ttl = Duration::from_millis(50);
        let first = cache
            .get_or_load_with_ttl("shared".into(), async move { Ok((42, remaining_ttl)) })
            .await
            .unwrap();
        let original_expiry = match cache.entries.lock().await.get("shared") {
            Some(Entry::Ready { expires_at, .. }) => *expires_at,
            _ => panic!("the still-fresh shared result should be cached"),
        };

        let hit = cache
            .get_or_load("shared".into(), Duration::from_secs(60), async {
                anyhow::bail!("the shared result should still be fresh")
            })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&first, &hit));
        match cache.entries.lock().await.get("shared") {
            Some(Entry::Ready { expires_at, .. }) => assert_eq!(*expires_at, original_expiry),
            _ => panic!("reading a fresh entry must preserve its deadline"),
        }

        tokio::time::sleep(remaining_ttl + Duration::from_millis(5)).await;
        let refreshed = cache
            .get_or_load("shared".into(), Duration::from_secs(60), async { Ok(43) })
            .await
            .unwrap();
        assert_eq!(*refreshed, 43);
        assert!(!Arc::ptr_eq(&first, &refreshed));
    }

    #[tokio::test]
    async fn waiting_for_the_cache_lock_does_not_extend_a_loaded_results_lifetime() {
        let cache = DashboardCache::new(4, 1, Duration::from_secs(5));
        let (started, waiting) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let (loaded, finished_loading) = oneshot::channel();
        let producer_cache = Arc::clone(&cache);
        let producer = tokio::spawn(async move {
            producer_cache
                .get_or_load_with_ttl("shared".into(), async move {
                    started.send(()).unwrap();
                    blocked.await.unwrap();
                    loaded.send(()).unwrap();
                    Ok((42, Duration::from_millis(20)))
                })
                .await
        });
        waiting.await.unwrap();
        let entries = cache.entries.lock().await;
        release.send(()).unwrap();
        finished_loading.await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(entries);
        assert_eq!(*producer.await.unwrap().unwrap(), 42);
        assert_eq!(cache.len().await, 0, "the expired result must not enter L1");
        assert_eq!(
            *cache
                .get_or_load("shared".into(), Duration::from_secs(60), async { Ok(43) })
                .await
                .unwrap(),
            43
        );
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
