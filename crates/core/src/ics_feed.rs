//! A published iCalendar (ICS) feed as a calendar source.
//!
//! Outlook web can publish a calendar as a secret `.ics` URL. New Outlook for
//! Mac exposes no local API and its AppleScript dictionary serves an empty
//! legacy store, so for Exchange users without the account in Apple Calendar
//! this feed is the only local-read path. It is merged into the same
//! `CalendarEvent` list the EventKit helper produces, so every consumer
//! (upcoming-meeting prompt, meeting titling, voice tools) sees it unchanged.
//!
//! Scope, deliberately small (ponytail): the properties Exchange actually
//! emits. Recurrence expansion covers DAILY/WEEKLY/MONTHLY/YEARLY with
//! INTERVAL, COUNT, UNTIL, BYDAY (incl. `3TU`), BYMONTHDAY and BYMONTH, plus
//! RECURRENCE-ID overrides. Time zones come from the feed's own VTIMEZONE
//! blocks (Exchange ships Windows names like `Eastern Standard Time`), so no
//! tz database is needed. All-day events are skipped: they are never a call.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration as StdDuration, Instant};

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, Local, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc, Weekday,
};

use crate::calendar::{extract_meeting_url, CalendarEvent};

const FETCH_TIMEOUT: StdDuration = StdDuration::from_secs(15);
const CACHE_TTL: StdDuration = StdDuration::from_secs(5 * 60);
const MAX_FEED_BYTES: u64 = 4 * 1024 * 1024;
/// Occurrences are expanded this far around "now" when the feed is fetched.
const EXPAND_LOOKBACK_DAYS: i64 = 2;
const EXPAND_LOOKAHEAD_DAYS: i64 = 60;
const MAX_OCCURRENCES_PER_RULE: usize = 2_000;
/// Same window the EventKit overlap helper uses (see calendar.rs).
const OVERLAP_WINDOW_MINUTES: i64 = 120;

/// One concrete meeting occurrence, already resolved to UTC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub attendees: Vec<String>,
    pub url: Option<String>,
}

struct Cache {
    url: String,
    fetched_at: Instant,
    instances: Vec<Instance>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Configured feed URL, normalized (`webcal://` becomes `https://`).
pub fn configured_url() -> Option<String> {
    let config = crate::config::Config::load();
    if !config.calendar.enabled {
        return None;
    }
    normalize_url(config.calendar.ics_url.as_deref()?)
}

/// Accepts `http(s)://` and `webcal://`; rejects anything else.
pub fn normalize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("webcal://") {
        return Some(format!(
            "https://{}",
            &trimmed[trimmed.len() - rest.len()..]
        ));
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(trimmed.to_string());
    }
    None
}

/// Host part of the configured URL, for showing "connected to …" without
/// leaking the secret path.
pub fn url_host(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Feed events starting within the next `lookahead_minutes`.
pub fn upcoming(lookahead_minutes: u32) -> Vec<CalendarEvent> {
    let Some(url) = configured_url() else {
        return Vec::new();
    };
    let now = Utc::now();
    let horizon = now + Duration::minutes(i64::from(lookahead_minutes));
    instances(&url)
        .into_iter()
        .filter(|i| i.start >= now && i.start <= horizon)
        .map(|i| to_event(&i, now))
        .collect()
}

/// Feed events that overlap `at`, or start within the shared overlap window
/// around it. Mirrors the EventKit overlap semantics so titling and
/// attendee merge treat both sources alike.
pub fn overlapping(at: DateTime<Local>) -> Vec<CalendarEvent> {
    let Some(url) = configured_url() else {
        return Vec::new();
    };
    let at_utc = at.with_timezone(&Utc);
    let window = Duration::minutes(OVERLAP_WINDOW_MINUTES);
    let now = Utc::now();
    let mut events: Vec<CalendarEvent> = instances(&url)
        .into_iter()
        .filter(|i| {
            (i.start <= at_utc && i.end >= at_utc)
                || (i.start >= at_utc - window && i.start <= at_utc + window)
        })
        .map(|i| to_event(&i, now))
        .collect();
    events.sort_by_key(|e| e.minutes_until.abs());
    events
}

fn to_event(instance: &Instance, now: DateTime<Utc>) -> CalendarEvent {
    let start_local = instance.start.with_timezone(&Local);
    CalendarEvent {
        title: instance.title.clone(),
        // Same shape the EventKit helper prints.
        start: start_local.format("%Y-%m-%d %H:%M").to_string(),
        minutes_until: (instance.start - now).num_minutes(),
        attendees: instance.attendees.clone(),
        url: instance.url.clone(),
    }
}

fn instances(url: &str) -> Vec<Instance> {
    let mut guard = match CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(cache) = guard.as_ref() {
        if cache.url == url && cache.fetched_at.elapsed() < CACHE_TTL {
            return cache.instances.clone();
        }
    }
    match fetch(url) {
        Ok(text) => {
            let instances = expand_feed(&text, Utc::now());
            tracing::info!(
                count = instances.len(),
                host = %url_host(url),
                "ics feed refreshed"
            );
            *guard = Some(Cache {
                url: url.to_string(),
                fetched_at: Instant::now(),
                instances: instances.clone(),
            });
            instances
        }
        Err(error) => {
            tracing::warn!(error = %error, host = %url_host(url), "ics feed fetch failed");
            // Keep serving the last good copy rather than dropping reminders.
            guard
                .as_ref()
                .filter(|cache| cache.url == url)
                .map(|cache| cache.instances.clone())
                .unwrap_or_default()
        }
    }
}

fn fetch(url: &str) -> Result<String, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_global(Some(FETCH_TIMEOUT))
            .max_redirects(3)
            .http_status_as_error(false)
            .build(),
    );
    let mut response = agent.get(url).call().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response
        .body_mut()
        .with_config()
        .limit(MAX_FEED_BYTES)
        .read_to_string()
        .map_err(|e| e.to_string())
}

// ── Parsing ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Default)]
struct Component {
    name: String,
    props: Vec<Prop>,
    children: Vec<Component>,
}

impl Component {
    fn prop(&self, name: &str) -> Option<&Prop> {
        self.props
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
    }
    fn props<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> + 'a {
        self.props
            .iter()
            .filter(move |p| p.name.eq_ignore_ascii_case(name))
    }
}

/// RFC 5545 line unfolding: a line starting with a space or tab continues
/// the previous one.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = lines.last_mut() {
                last.push_str(&line[1..]);
                continue;
            }
        }
        lines.push(line.to_string());
    }
    lines
}

fn parse_prop(line: &str) -> Option<Prop> {
    // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE. Find the first ':' that is
    // outside double quotes.
    let mut in_quotes = false;
    let mut split = None;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                split = Some(i);
                break;
            }
            _ => {}
        }
    }
    let split = split?;
    let (head, value) = (&line[..split], &line[split + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_uppercase(),
                v.trim_matches('"').to_string(),
            ))
        })
        .collect();
    Some(Prop {
        name,
        params,
        value: unescape(value),
    })
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_components(text: &str) -> Vec<Component> {
    let mut stack: Vec<Component> = Vec::new();
    let mut roots: Vec<Component> = Vec::new();
    for line in unfold(text) {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("BEGIN:") {
            stack.push(Component {
                name: name.trim().to_ascii_uppercase(),
                ..Default::default()
            });
            continue;
        }
        if line.starts_with("END:") {
            if let Some(done) = stack.pop() {
                match stack.last_mut() {
                    Some(parent) => parent.children.push(done),
                    None => roots.push(done),
                }
            }
            continue;
        }
        if let (Some(current), Some(prop)) = (stack.last_mut(), parse_prop(&line)) {
            current.props.push(prop);
        }
    }
    roots
}

// ── Time zones (from VTIMEZONE) ────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TzPhase {
    offset_to: i32,
    /// Wall-clock time of day at which the phase begins (from DTSTART).
    at: NaiveTime,
    /// Yearly rule: (month, weekday, nth) where nth may be negative (-1 = last).
    rule: Option<(u32, Weekday, i32)>,
}

#[derive(Debug, Clone)]
struct TzDef {
    standard: TzPhase,
    daylight: Option<TzPhase>,
}

fn parse_offset(value: &str) -> Option<i32> {
    let v = value.trim();
    let (sign, digits) = match v.chars().next()? {
        '+' => (1, &v[1..]),
        '-' => (-1, &v[1..]),
        _ => (1, v),
    };
    if digits.len() < 4 {
        return None;
    }
    let hours: i32 = digits[0..2].parse().ok()?;
    let minutes: i32 = digits[2..4].parse().ok()?;
    let seconds: i32 = if digits.len() >= 6 {
        digits[4..6].parse().ok()?
    } else {
        0
    };
    Some(sign * (hours * 3600 + minutes * 60 + seconds))
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// `3TU` -> (Some(3), Tue); `-1SU` -> (Some(-1), Sun); `MO` -> (None, Mon).
fn parse_byday(token: &str) -> Option<(Option<i32>, Weekday)> {
    let t = token.trim();
    let split = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let (num, day) = t.split_at(split);
    let weekday = parse_weekday(day)?;
    let nth = if num.is_empty() {
        None
    } else {
        Some(num.parse().ok()?)
    };
    Some((nth, weekday))
}

fn rrule_map(value: &str) -> HashMap<String, String> {
    value
        .split(';')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().to_string()))
        .collect()
}

fn parse_tz_phase(component: &Component) -> Option<TzPhase> {
    let offset_to = parse_offset(&component.prop("TZOFFSETTO")?.value)?;
    let at = component
        .prop("DTSTART")
        .and_then(|p| NaiveDateTime::parse_from_str(&p.value, "%Y%m%dT%H%M%S").ok())
        .map(|dt| dt.time())
        .unwrap_or_else(|| NaiveTime::from_hms_opt(2, 0, 0).unwrap());
    let rule = component.prop("RRULE").and_then(|p| {
        let map = rrule_map(&p.value);
        let month: u32 = map.get("BYMONTH")?.parse().ok()?;
        let (nth, weekday) = parse_byday(map.get("BYDAY")?)?;
        Some((month, weekday, nth.unwrap_or(1)))
    });
    Some(TzPhase {
        offset_to,
        at,
        rule,
    })
}

fn parse_timezones(roots: &[Component]) -> HashMap<String, TzDef> {
    let mut out = HashMap::new();
    // VTIMEZONE normally sits inside VCALENDAR; accept it at the top too.
    let zones = roots
        .iter()
        .flat_map(|root| std::iter::once(root).chain(root.children.iter()))
        .filter(|c| c.name == "VTIMEZONE");
    for root in zones {
        let Some(tzid) = root.prop("TZID").map(|p| p.value.clone()) else {
            continue;
        };
        let standard = root
            .children
            .iter()
            .find(|c| c.name == "STANDARD")
            .and_then(parse_tz_phase);
        let daylight = root
            .children
            .iter()
            .find(|c| c.name == "DAYLIGHT")
            .and_then(parse_tz_phase);
        if let Some(standard) = standard {
            out.insert(tzid, TzDef { standard, daylight });
        }
    }
    out
}

fn nth_weekday_of_month(year: i32, month: u32, weekday: Weekday, nth: i32) -> Option<NaiveDate> {
    if nth > 0 {
        let first = NaiveDate::from_ymd_opt(year, month, 1)?;
        let offset = (7 + weekday.num_days_from_monday() as i32
            - first.weekday().num_days_from_monday() as i32)
            % 7;
        let day = 1 + offset as u32 + 7 * (nth as u32 - 1);
        NaiveDate::from_ymd_opt(year, month, day)
    } else {
        let (ny, nm) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
        let last = NaiveDate::from_ymd_opt(ny, nm, 1)?.pred_opt()?;
        let back = (7 + last.weekday().num_days_from_monday() as i32
            - weekday.num_days_from_monday() as i32)
            % 7;
        let date = last - Duration::days(i64::from(back));
        date.checked_sub_signed(Duration::weeks(i64::from(-nth - 1)))
    }
}

fn phase_start(phase: &TzPhase, year: i32) -> Option<NaiveDateTime> {
    let (month, weekday, nth) = phase.rule?;
    Some(nth_weekday_of_month(year, month, weekday, nth)?.and_time(phase.at))
}

impl TzDef {
    /// UTC offset in seconds for a wall-clock time in this zone.
    fn offset_at(&self, wall: NaiveDateTime) -> i32 {
        let Some(daylight) = &self.daylight else {
            return self.standard.offset_to;
        };
        let (Some(dst_start), Some(dst_end)) = (
            phase_start(daylight, wall.year()),
            phase_start(&self.standard, wall.year()),
        ) else {
            return self.standard.offset_to;
        };
        let in_dst = if dst_start < dst_end {
            wall >= dst_start && wall < dst_end
        } else {
            // Southern hemisphere: DST spans the new year.
            wall >= dst_start || wall < dst_end
        };
        if in_dst {
            daylight.offset_to
        } else {
            self.standard.offset_to
        }
    }
}

/// Resolve a wall-clock time in the given TZID (or floating/local) to UTC.
fn wall_to_utc(
    wall: NaiveDateTime,
    tzid: Option<&str>,
    tzs: &HashMap<String, TzDef>,
) -> DateTime<Utc> {
    match tzid.and_then(|id| tzs.get(id)) {
        Some(def) => {
            let offset = FixedOffset::east_opt(def.offset_at(wall))
                .unwrap_or(FixedOffset::east_opt(0).unwrap());
            offset
                .from_local_datetime(&wall)
                .single()
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| {
                    Utc.from_utc_datetime(
                        &(wall - Duration::seconds(i64::from(def.offset_at(wall)))),
                    )
                })
        }
        None => Local
            .from_local_datetime(&wall)
            .earliest()
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&wall)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stamp {
    /// Absolute instant (`...Z`).
    Utc(DateTime<Utc>),
    /// Wall-clock time, resolved through the TZID (or local time when none).
    Wall(NaiveDateTime),
    /// `VALUE=DATE`, an all-day marker.
    Date,
}

fn parse_stamp(prop: &Prop) -> Option<Stamp> {
    let value = prop.value.trim();
    if prop.param("VALUE") == Some("DATE") || (value.len() == 8 && !value.contains('T')) {
        return Some(Stamp::Date);
    }
    if let Some(z) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(z, "%Y%m%dT%H%M%S").ok()?;
        return Some(Stamp::Utc(Utc.from_utc_datetime(&naive)));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    Some(Stamp::Wall(naive))
}

// ── Recurrence ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Rrule {
    freq: String,
    interval: u32,
    count: Option<usize>,
    until: Option<DateTime<Utc>>,
    byday: Vec<(Option<i32>, Weekday)>,
    bymonthday: Vec<u32>,
    bymonth: Vec<u32>,
}

fn parse_rrule(value: &str, tzid: Option<&str>, tzs: &HashMap<String, TzDef>) -> Option<Rrule> {
    let map = rrule_map(value);
    let freq = map.get("FREQ")?.to_ascii_uppercase();
    let interval = map
        .get("INTERVAL")
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let count = map.get("COUNT").and_then(|v| v.parse().ok());
    let until = map.get("UNTIL").and_then(|v| {
        if let Some(z) = v.strip_suffix('Z') {
            NaiveDateTime::parse_from_str(z, "%Y%m%dT%H%M%S")
                .ok()
                .map(|n| Utc.from_utc_datetime(&n))
        } else if let Ok(n) = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S") {
            Some(wall_to_utc(n, tzid, tzs))
        } else {
            NaiveDate::parse_from_str(v, "%Y%m%d")
                .ok()
                .map(|d| wall_to_utc(d.and_hms_opt(23, 59, 59).unwrap(), tzid, tzs))
        }
    });
    let byday = map
        .get("BYDAY")
        .map(|v| v.split(',').filter_map(parse_byday).collect())
        .unwrap_or_default();
    let bymonthday = map
        .get("BYMONTHDAY")
        .map(|v| v.split(',').filter_map(|d| d.parse().ok()).collect())
        .unwrap_or_default();
    let bymonth = map
        .get("BYMONTH")
        .map(|v| v.split(',').filter_map(|d| d.parse().ok()).collect())
        .unwrap_or_default();
    Some(Rrule {
        freq,
        interval,
        count,
        until,
        byday,
        bymonthday,
        bymonth,
    })
}

fn add_months(date: NaiveDate, months: u32) -> Option<(i32, u32)> {
    let total = date.year() * 12 + date.month0() as i32 + months as i32;
    Some((total.div_euclid(12), (total.rem_euclid(12) + 1) as u32))
}

/// Wall-clock occurrences of `rule` starting at `first`, up to `horizon`
/// (in wall time), honoring COUNT and UNTIL (checked by the caller in UTC).
fn expand_wall(first: NaiveDateTime, rule: &Rrule, horizon: NaiveDateTime) -> Vec<NaiveDateTime> {
    let time = first.time();
    let start_date = first.date();
    let mut out: Vec<NaiveDateTime> = vec![first];
    let push = |out: &mut Vec<NaiveDateTime>, date: NaiveDate| {
        let dt = date.and_time(time);
        if dt > first && dt <= horizon && !out.contains(&dt) {
            out.push(dt);
        }
    };
    let interval = i64::from(rule.interval);
    match rule.freq.as_str() {
        "DAILY" => {
            let mut k = 1;
            while out.len() < MAX_OCCURRENCES_PER_RULE {
                let date = start_date + Duration::days(k * interval);
                if date.and_time(time) > horizon {
                    break;
                }
                if rule.byday.is_empty() || rule.byday.iter().any(|(_, w)| *w == date.weekday()) {
                    push(&mut out, date);
                }
                k += 1;
            }
        }
        "WEEKLY" => {
            let week_start =
                start_date - Duration::days(i64::from(start_date.weekday().num_days_from_monday()));
            let weekdays: Vec<Weekday> = if rule.byday.is_empty() {
                vec![start_date.weekday()]
            } else {
                rule.byday.iter().map(|(_, w)| *w).collect()
            };
            let mut k = 0;
            while out.len() < MAX_OCCURRENCES_PER_RULE {
                let base = week_start + Duration::weeks(k * interval);
                if base.and_time(time) > horizon {
                    break;
                }
                for weekday in &weekdays {
                    let date = base + Duration::days(i64::from(weekday.num_days_from_monday()));
                    if date >= start_date {
                        push(&mut out, date);
                    }
                }
                k += 1;
            }
        }
        "MONTHLY" => {
            let mut k = 0;
            while out.len() < MAX_OCCURRENCES_PER_RULE {
                let Some((year, month)) = add_months(start_date, (k * interval) as u32) else {
                    break;
                };
                let Some(month_first) = NaiveDate::from_ymd_opt(year, month, 1) else {
                    break;
                };
                if month_first.and_time(time) > horizon {
                    break;
                }
                if !rule.byday.is_empty() {
                    for (nth, weekday) in &rule.byday {
                        if let Some(date) =
                            nth_weekday_of_month(year, month, *weekday, nth.unwrap_or(1))
                        {
                            push(&mut out, date);
                        }
                    }
                } else if !rule.bymonthday.is_empty() {
                    for day in &rule.bymonthday {
                        if let Some(date) = NaiveDate::from_ymd_opt(year, month, *day) {
                            push(&mut out, date);
                        }
                    }
                } else if let Some(date) = NaiveDate::from_ymd_opt(year, month, start_date.day()) {
                    push(&mut out, date);
                }
                k += 1;
            }
        }
        "YEARLY" => {
            let mut k = 0;
            while out.len() < MAX_OCCURRENCES_PER_RULE {
                let year = start_date.year() + (k * interval) as i32;
                let Some(year_first) = NaiveDate::from_ymd_opt(year, 1, 1) else {
                    break;
                };
                if year_first.and_time(time) > horizon {
                    break;
                }
                let months: Vec<u32> = if rule.bymonth.is_empty() {
                    vec![start_date.month()]
                } else {
                    rule.bymonth.clone()
                };
                for month in months {
                    if !rule.byday.is_empty() {
                        for (nth, weekday) in &rule.byday {
                            if let Some(date) =
                                nth_weekday_of_month(year, month, *weekday, nth.unwrap_or(1))
                            {
                                push(&mut out, date);
                            }
                        }
                    } else if let Some(date) =
                        NaiveDate::from_ymd_opt(year, month, start_date.day())
                    {
                        push(&mut out, date);
                    }
                }
                k += 1;
            }
        }
        _ => {}
    }
    out.sort();
    if let Some(count) = rule.count {
        out.truncate(count);
    }
    out
}

// ── Events ─────────────────────────────────────────────────────────────────

fn attendees_of(event: &Component) -> Vec<String> {
    event
        .props("ATTENDEE")
        .filter_map(|p| {
            let name = p
                .param("CN")
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.contains('@'))
                .map(str::to_string)
                .or_else(|| {
                    p.value
                        .trim()
                        .strip_prefix("mailto:")
                        .or(Some(p.value.trim()))
                        .and_then(|m| m.split('@').next())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })?;
            Some(name)
        })
        .collect()
}

fn meeting_url_of(event: &Component) -> Option<String> {
    [
        "LOCATION",
        "DESCRIPTION",
        "URL",
        "X-MICROSOFT-SKYPETEAMSMEETINGURL",
    ]
    .iter()
    .filter_map(|name| event.prop(name))
    .find_map(|p| {
        extract_meeting_url(&p.value).or_else(|| {
            let v = p.value.trim();
            (p.name == "X-MICROSOFT-SKYPETEAMSMEETINGURL" && v.starts_with("https://"))
                .then(|| v.to_string())
        })
    })
}

/// Expand every VEVENT in `text` into concrete instances around `now`.
pub fn expand_feed(text: &str, now: DateTime<Utc>) -> Vec<Instance> {
    let roots = parse_components(text);
    let tzs = parse_timezones(&roots);
    let vevents: Vec<&Component> = roots
        .iter()
        .flat_map(|root| {
            if root.name == "VEVENT" {
                vec![root]
            } else {
                root.children
                    .iter()
                    .filter(|c| c.name == "VEVENT")
                    .collect()
            }
        })
        .collect();

    let window_start = now - Duration::days(EXPAND_LOOKBACK_DAYS);
    let window_end = now + Duration::days(EXPAND_LOOKAHEAD_DAYS);

    // Overrides: (UID, original occurrence start in UTC) -> replaced.
    let mut overridden: HashSet<(String, DateTime<Utc>)> = HashSet::new();
    for event in &vevents {
        if let (Some(uid), Some(rid)) = (event.prop("UID"), event.prop("RECURRENCE-ID")) {
            if let Some(stamp) = parse_stamp(rid) {
                let when = match stamp {
                    Stamp::Utc(dt) => dt,
                    Stamp::Wall(wall) => wall_to_utc(wall, rid.param("TZID"), &tzs),
                    Stamp::Date => continue,
                };
                overridden.insert((uid.value.clone(), when));
            }
        }
    }

    let mut out = Vec::new();
    for event in vevents {
        let Some(dtstart) = event.prop("DTSTART") else {
            continue;
        };
        let Some(start_stamp) = parse_stamp(dtstart) else {
            continue;
        };
        let tzid = dtstart.param("TZID");
        let title = event
            .prop("SUMMARY")
            .map(|p| p.value.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Untitled".into());
        if event
            .prop("STATUS")
            .is_some_and(|p| p.value.eq_ignore_ascii_case("CANCELLED"))
        {
            continue;
        }
        let uid = event
            .prop("UID")
            .map(|p| p.value.clone())
            .unwrap_or_default();
        let attendees = attendees_of(event);
        let url = meeting_url_of(event);

        // Duration from DTEND (or DURATION), default one hour.
        let start_utc = match start_stamp {
            Stamp::Date => continue, // all-day: never a call
            Stamp::Utc(dt) => dt,
            Stamp::Wall(wall) => wall_to_utc(wall, tzid, &tzs),
        };
        let duration = event
            .prop("DTEND")
            .and_then(parse_stamp)
            .and_then(|s| match s {
                Stamp::Utc(dt) => Some(dt - start_utc),
                Stamp::Wall(wall) => Some(
                    wall_to_utc(
                        wall,
                        event.prop("DTEND").and_then(|p| p.param("TZID")).or(tzid),
                        &tzs,
                    ) - start_utc,
                ),
                Stamp::Date => None,
            })
            .filter(|d| *d > Duration::zero())
            .unwrap_or_else(|| Duration::hours(1));

        let rrule = event
            .prop("RRULE")
            .and_then(|p| parse_rrule(&p.value, tzid, &tzs));
        let is_override = event.prop("RECURRENCE-ID").is_some();

        let starts: Vec<DateTime<Utc>> = match (&rrule, start_stamp) {
            (Some(rule), Stamp::Wall(wall)) if !is_override => {
                // Expand in wall time so DST shifts keep the meeting at the
                // same clock hour, then resolve each occurrence.
                let horizon = window_end.naive_utc() + Duration::days(1);
                expand_wall(wall, rule, horizon)
                    .into_iter()
                    .map(|w| wall_to_utc(w, tzid, &tzs))
                    .filter(|dt| rule.until.map(|u| *dt <= u).unwrap_or(true))
                    .filter(|dt| !overridden.contains(&(uid.clone(), *dt)))
                    .collect()
            }
            (Some(rule), Stamp::Utc(dt)) if !is_override => {
                let horizon = window_end.naive_utc() + Duration::days(1);
                expand_wall(dt.naive_utc(), rule, horizon)
                    .into_iter()
                    .map(|w| Utc.from_utc_datetime(&w))
                    .filter(|dt| rule.until.map(|u| *dt <= u).unwrap_or(true))
                    .filter(|dt| !overridden.contains(&(uid.clone(), *dt)))
                    .collect()
            }
            _ => vec![start_utc],
        };

        for start in starts {
            let end = start + duration;
            if end < window_start || start > window_end {
                continue;
            }
            out.push(Instance {
                title: title.clone(),
                start,
                end,
                attendees: attendees.clone(),
                url: url.clone(),
            });
        }
    }
    out.sort_by_key(|i| i.start);
    out.dedup_by(|a, b| a.title == b.title && a.start == b.start);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const EASTERN: &str = "BEGIN:VTIMEZONE\r\nTZID:Eastern Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n";

    fn feed(events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{EASTERN}{events}END:VCALENDAR\r\n")
    }

    fn utc(s: &str) -> DateTime<Utc> {
        Utc.from_utc_datetime(&NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap())
    }

    #[test]
    fn unfolds_continuation_lines_and_unescapes() {
        let lines = unfold("SUMMARY:Hello\r\n  World\r\nX:1\r\n");
        assert_eq!(lines, vec!["SUMMARY:Hello World", "X:1"]);
        let prop = parse_prop("DESCRIPTION;LANGUAGE=en-US:a\\, b\\nc").unwrap();
        assert_eq!(prop.param("LANGUAGE"), Some("en-US"));
        assert_eq!(prop.value, "a, b\nc");
        let quoted =
            parse_prop(r#"ATTENDEE;CN="Doe, Jane";ROLE=REQ-PARTICIPANT:mailto:jane@x.com"#)
                .unwrap();
        assert_eq!(quoted.param("CN"), Some("Doe, Jane"));
        assert_eq!(quoted.value, "mailto:jane@x.com");
    }

    #[test]
    fn eastern_vtimezone_resolves_dst_and_standard_time() {
        let roots = parse_components(&feed(""));
        let tzs = parse_timezones(&roots);
        let tz = tzs.get("Eastern Standard Time").expect("tz parsed");
        // July is EDT (-4h), January is EST (-5h).
        let july =
            NaiveDateTime::parse_from_str("2026-07-01T09:00:00", "%Y-%m-%dT%H:%M:%S").unwrap();
        let jan =
            NaiveDateTime::parse_from_str("2026-01-15T09:00:00", "%Y-%m-%dT%H:%M:%S").unwrap();
        assert_eq!(tz.offset_at(july), -4 * 3600);
        assert_eq!(tz.offset_at(jan), -5 * 3600);
        // 2026 DST starts Mar 8 (2nd Sunday), ends Nov 1 (1st Sunday).
        assert_eq!(
            nth_weekday_of_month(2026, 3, Weekday::Sun, 2),
            NaiveDate::from_ymd_opt(2026, 3, 8)
        );
        assert_eq!(
            nth_weekday_of_month(2026, 11, Weekday::Sun, 1),
            NaiveDate::from_ymd_opt(2026, 11, 1)
        );
        assert_eq!(
            nth_weekday_of_month(2026, 9, Weekday::Tue, -1),
            NaiveDate::from_ymd_opt(2026, 9, 29)
        );
        assert_eq!(
            wall_to_utc(july, Some("Eastern Standard Time"), &tzs),
            utc("2026-07-01T13:00:00")
        );
    }

    #[test]
    fn single_event_with_teams_link_and_attendees() {
        let text = feed(
            "BEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Segment Standup\r\nDTSTART;TZID=Eastern Standard Time:20260922T130000\r\nDTEND;TZID=Eastern Standard Time:20260922T133000\r\nLOCATION:Microsoft Teams Meeting\r\nDESCRIPTION:Join the meeting now<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x>\\nMeeting ID: 1\r\nATTENDEE;CN=\"Jane Doe\";ROLE=REQ-PARTICIPANT:mailto:jane@example.com\r\nATTENDEE;CN=bob@example.com:mailto:bob@example.com\r\nEND:VEVENT\r\n",
        );
        let now = utc("2026-09-22T12:00:00");
        let instances = expand_feed(&text, now);
        assert_eq!(instances.len(), 1);
        let i = &instances[0];
        assert_eq!(i.title, "Segment Standup");
        assert_eq!(i.start, utc("2026-09-22T17:00:00")); // 13:00 EDT
        assert_eq!(i.end, utc("2026-09-22T17:30:00"));
        assert_eq!(i.attendees, vec!["Jane Doe", "bob"]);
        assert!(i
            .url
            .as_deref()
            .unwrap()
            .starts_with("https://teams.microsoft.com/l/meetup-join/"));
    }

    #[test]
    fn weekly_rule_expands_and_honors_override_and_until() {
        let text = feed(
            "BEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:1:1\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;UNTIL=20261005T140000Z\r\nDTSTART;TZID=Eastern Standard Time:20260914T100000\r\nDTEND;TZID=Eastern Standard Time:20260914T103000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=Eastern Standard Time:20260923T100000\r\nSUMMARY:1:1 (moved)\r\nDTSTART;TZID=Eastern Standard Time:20260923T150000\r\nDTEND;TZID=Eastern Standard Time:20260923T153000\r\nEND:VEVENT\r\n",
        );
        let now = utc("2026-09-21T12:00:00");
        let instances = expand_feed(&text, now);
        let starts: Vec<String> = instances
            .iter()
            .map(|i| format!("{} {}", i.start.format("%m-%d %H:%M"), i.title))
            .collect();
        assert_eq!(
            starts,
            vec![
                "09-21 14:00 1:1",
                "09-23 19:00 1:1 (moved)",
                "09-28 14:00 1:1",
                "09-30 14:00 1:1",
                "10-05 14:00 1:1",
            ]
        );
    }

    #[test]
    fn monthly_third_tuesday_and_daily_count() {
        let text = feed(
            "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Board\r\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=3TU\r\nDTSTART;TZID=Eastern Standard Time:20260915T130000\r\nDTEND;TZID=Eastern Standard Time:20260915T140000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Sprint\r\nRRULE:FREQ=DAILY;COUNT=3\r\nDTSTART:20260922T090000Z\r\nDTEND:20260922T091500Z\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260925\r\nDTEND;VALUE=DATE:20260926\r\nEND:VEVENT\r\n",
        );
        let now = utc("2026-09-21T12:00:00");
        let instances = expand_feed(&text, now);
        let board: Vec<String> = instances
            .iter()
            .filter(|i| i.title == "Board")
            .map(|i| i.start.format("%Y-%m-%d %H:%M").to_string())
            .collect();
        // Oct 20 is the third Tuesday (EDT), Nov 17 is the third Tuesday (EST).
        assert_eq!(board, vec!["2026-10-20 17:00", "2026-11-17 18:00"]);
        assert_eq!(instances.iter().filter(|i| i.title == "Sprint").count(), 3);
        assert!(
            instances.iter().all(|i| i.title != "Holiday"),
            "all-day skipped"
        );
    }

    #[test]
    fn url_normalization_and_host() {
        assert_eq!(
            normalize_url("webcal://outlook.office365.com/owa/calendar/x/calendar.ics"),
            Some("https://outlook.office365.com/owa/calendar/x/calendar.ics".into())
        );
        assert_eq!(
            normalize_url("  https://a.b/c.ics "),
            Some("https://a.b/c.ics".into())
        );
        assert_eq!(normalize_url("ftp://a.b/c.ics"), None);
        assert_eq!(normalize_url(""), None);
        assert_eq!(
            url_host("https://by2prd0510.outlook.com/owa/calendar/x/y/calendar.ics"),
            "by2prd0510.outlook.com"
        );
    }

    #[test]
    fn upcoming_and_overlap_windows_from_instances() {
        let now = Utc::now();
        let soon = Instance {
            title: "Soon".into(),
            start: now + Duration::minutes(30),
            end: now + Duration::minutes(60),
            attendees: vec![],
            url: None,
        };
        let event = to_event(&soon, now);
        assert_eq!(event.title, "Soon");
        assert!((29..=30).contains(&event.minutes_until));
        assert_eq!(event.start.len(), "2026-09-22 13:00".len());
    }
}
