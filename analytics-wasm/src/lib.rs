//! Browser-local report analytics. ABI and score semantics are in ../README.md.
#![no_std]

use core::{cmp::Ordering, panic::PanicInfo, slice};

const MAX_ROWS: usize = 8192;
const BUFFER_VALUES: usize = MAX_ROWS * 4;
const MAX_COUNT: f64 = 9_007_199_254_740_991.0;
static mut INPUT: [f64; BUFFER_VALUES] = [0.0; BUFFER_VALUES];
static mut OUTPUT: [f64; BUFFER_VALUES] = [0.0; BUFFER_VALUES];
static mut ORDER: [usize; MAX_ROWS] = [0; MAX_ROWS];

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn max_rows() -> usize {
    MAX_ROWS
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut f64 {
    (&raw mut INPUT).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *mut f64 {
    (&raw mut OUTPUT).cast::<f64>()
}

fn count(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, MAX_COUNT)
    } else {
        0.0
    }
}

fn severity(status: f64) -> f64 {
    if (500.0..600.0).contains(&status) {
        1.5
    } else {
        1.0
    }
}

fn descending(left: f64, right: f64) -> Ordering {
    right.partial_cmp(&left).unwrap_or(Ordering::Equal)
}

fn percentage(value: f64, total: f64) -> f64 {
    if total > 0.0 {
        (value / total * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    }
}

/// Input: [count, status_code] pairs. Output: [source_index, share, cumulative, score].
/// The buffers are private to one WebAssembly instance and operations are synchronous.
#[no_mangle]
pub extern "C" fn rank_failures(len: usize, total_failures: f64) -> i32 {
    if len > MAX_ROWS {
        return -1;
    }
    // Length is bounded above; these distinct static buffers never overlap.
    let input = unsafe { slice::from_raw_parts(input_ptr(), len * 2) };
    let output = unsafe { slice::from_raw_parts_mut(output_ptr(), len * 4) };
    let order = unsafe { slice::from_raw_parts_mut((&raw mut ORDER).cast::<usize>(), len) };
    let mut sum = 0.0;
    for (i, value) in order.iter_mut().enumerate() {
        *value = i;
        sum += count(input[i * 2]);
    }
    order.sort_unstable_by(|&a, &b| {
        let a_count = count(input[a * 2]);
        let b_count = count(input[b * 2]);
        descending(a_count, b_count)
            .then_with(|| {
                descending(
                    a_count * severity(input[a * 2 + 1]),
                    b_count * severity(input[b * 2 + 1]),
                )
            })
            .then_with(|| a.cmp(&b))
    });
    let total = count(total_failures).max(sum);
    let mut cumulative = 0.0;
    for (rank, &index) in order.iter().enumerate() {
        let failures = count(input[index * 2]);
        cumulative += failures;
        output[rank * 4] = index as f64;
        output[rank * 4 + 1] = percentage(failures, total);
        output[rank * 4 + 2] = percentage(cumulative, total);
        output[rank * 4 + 3] = failures * severity(input[index * 2 + 1]);
    }
    len as i32
}

/// Input: counts. Output: sorted [share, cumulative] pairs.
#[no_mangle]
pub extern "C" fn concentration(len: usize, total_failures: f64) -> i32 {
    if len > MAX_ROWS {
        return -1;
    }
    let input = unsafe { slice::from_raw_parts(input_ptr(), len) };
    let output = unsafe { slice::from_raw_parts_mut(output_ptr(), len * 2) };
    let order = unsafe { slice::from_raw_parts_mut((&raw mut ORDER).cast::<usize>(), len) };
    let mut sum = 0.0;
    for (i, value) in order.iter_mut().enumerate() {
        *value = i;
        sum += count(input[i]);
    }
    order.sort_unstable_by(|&a, &b| descending(count(input[a]), count(input[b])).then(a.cmp(&b)));
    let total = count(total_failures).max(sum);
    let mut cumulative = 0.0;
    for (rank, &index) in order.iter().enumerate() {
        let failures = count(input[index]);
        cumulative += failures;
        output[rank * 2] = percentage(failures, total);
        output[rank * 2 + 1] = percentage(cumulative, total);
    }
    len as i32
}

/// Input: [request_count, failure_count] pairs in chronological order.
/// Output: [requests, failures, request_peak_index, request_peak,
///          failure_peak_index, failure_peak, failure_rate_pct].
#[no_mangle]
pub extern "C" fn summarize_trend(len: usize) -> i32 {
    if len > MAX_ROWS {
        return -1;
    }
    let input = unsafe { slice::from_raw_parts(input_ptr(), len * 2) };
    let output = unsafe { slice::from_raw_parts_mut(output_ptr(), 7) };
    output.fill(0.0);
    output[2] = -1.0;
    output[4] = -1.0;
    for index in 0..len {
        let requests = count(input[index * 2]);
        let failures = count(input[index * 2 + 1]).min(requests);
        output[0] += requests;
        output[1] += failures;
        // The first nonempty peak wins ties; an all-zero series has no peak.
        if requests > output[3] {
            output[2] = index as f64;
            output[3] = requests;
        }
        if failures > output[5] {
            output[4] = index as f64;
            output[5] = failures;
        }
    }
    output[6] = percentage(output[1], output[0]);
    7
}
