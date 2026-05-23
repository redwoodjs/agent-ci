use std::collections::VecDeque;
use std::sync::Arc;
use std::thread;

pub enum ConcurrentWorkerEvent<R, E> {
    Worker(E),
    Finished {
        index: usize,
        outcome: Result<R, String>,
    },
}

/// Run indexed jobs with at most `max_jobs` active workers, preserving output order.
pub fn run_concurrent_workers<T, R, E, F, H>(
    max_jobs: usize,
    jobs: Vec<(usize, T)>,
    run_job: F,
    mut handle_worker_event: H,
) -> Result<Vec<(usize, R)>, String>
where
    T: Send + 'static,
    R: Send + 'static,
    E: Send + 'static,
    F: Fn(usize, T, &std::sync::mpsc::Sender<ConcurrentWorkerEvent<R, E>>) -> Result<R, String>
        + Send
        + Sync
        + 'static,
    H: FnMut(E),
{
    let max_jobs = max_jobs.max(1);
    let total = jobs.len();
    let mut pending = jobs.into_iter().collect::<VecDeque<_>>();
    let (tx, rx) = std::sync::mpsc::channel::<ConcurrentWorkerEvent<R, E>>();
    let run_job = Arc::new(run_job);
    let mut handles = Vec::new();
    let mut active = 0_usize;
    let mut finished = 0_usize;
    let mut outcomes = Vec::new();
    let mut first_error = None::<String>;

    while finished < total {
        while active < max_jobs && !pending.is_empty() {
            let (index, job) = pending.pop_front().expect("pending job");
            let worker_tx = tx.clone();
            let run_job = Arc::clone(&run_job);
            active += 1;
            handles.push(thread::spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_job(index, job, &worker_tx)
                }))
                .unwrap_or_else(|_| Err("job worker panicked".to_owned()));
                let _ = worker_tx.send(ConcurrentWorkerEvent::Finished { index, outcome });
            }));
        }

        match rx.recv().map_err(|err| err.to_string())? {
            ConcurrentWorkerEvent::Worker(event) => handle_worker_event(event),
            ConcurrentWorkerEvent::Finished { index, outcome } => {
                active = active.saturating_sub(1);
                finished += 1;
                match outcome {
                    Ok(value) => outcomes.push((index, value)),
                    Err(err) if first_error.is_none() => {
                        first_error = Some(format!("job {index} failed to execute: {err}"));
                    }
                    Err(_) => {}
                }
            }
        }
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| "job worker panicked during join".to_owned())?;
    }

    if let Some(err) = first_error {
        return Err(err);
    }

    outcomes.sort_by_key(|(index, _)| *index);
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn concurrent_pool_respects_max_jobs() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs = (0..6).map(|index| (index, index)).collect::<Vec<_>>();

        let outcomes = run_concurrent_workers(
            2,
            jobs,
            {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                move |_index, _job, _tx| {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = peak.fetch_max(current, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(30));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            },
            |_: ()| {},
        )
        .expect("pool should succeed");

        assert_eq!(outcomes.len(), 6);
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_pool_preserves_job_order() {
        let jobs = (0..4).map(|index| (index, index)).collect::<Vec<_>>();
        let outcomes = run_concurrent_workers(
            4,
            jobs,
            |_index, job, _tx| {
                thread::sleep(Duration::from_millis(((4 - job) * 10) as u64));
                Ok(job * 10)
            },
            |_: ()| {},
        )
        .expect("pool should succeed");
        assert_eq!(outcomes, vec![(0, 0), (1, 10), (2, 20), (3, 30)]);
    }
}
