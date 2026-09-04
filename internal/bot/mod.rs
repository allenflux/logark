use anyhow::{bail, Context};
use chrono::{DateTime, Datelike, Duration, FixedOffset, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use tracing::{error, info, warn};

use crate::{config::Config, service::AuditAnalyticsService};

#[derive(Clone)]
pub struct TelegramBot {
    client: Client,
    service: AuditAnalyticsService,
    config: Config,
    timezone: FixedOffset,
    base_url: String,
}

impl TelegramBot {
    pub fn new(service: AuditAnalyticsService, config: Config) -> anyhow::Result<Self> {
        let token = config
            .tg_bot_token
            .clone()
            .context("missing TG_BOT_TOKEN for Telegram bot")?;
        let timezone = FixedOffset::east_opt(config.tg_timezone_offset_hours * 3600)
            .context("invalid TG_TIMEZONE_OFFSET_HOURS")?;

        Ok(Self {
            client: Client::new(),
            service,
            config,
            timezone,
            base_url: format!("https://api.telegram.org/bot{token}"),
        })
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let mut offset: i64 = 0;
        let mut next_report_at = self.next_report_after(Utc::now())?;

        info!("telegram bot started");

        loop {
            let now = Utc::now();
            if self.config.tg_chat_id.is_some() && now >= next_report_at {
                if let Err(err) = self.send_daily_report().await {
                    error!(error = ?err, "failed to send daily report");
                }
                next_report_at = self.next_report_after(now + Duration::minutes(1))?;
            }

            match self.fetch_updates(offset).await {
                Ok(updates) => {
                    for update in updates {
                        offset = update.update_id + 1;
                        if let Err(err) = self.handle_update(update).await {
                            error!(error = ?err, "failed to handle Telegram update");
                        }
                    }
                }
                Err(err) => {
                    warn!(error = ?err, "telegram long poll failed");
                    tokio::time::sleep(std::time::Duration::from_secs(
                        self.config.tg_poll_interval_secs.max(2),
                    ))
                    .await;
                }
            }
        }
    }

    async fn handle_update(&self, update: TelegramUpdate) -> anyhow::Result<()> {
        let Some(message) = update.message else {
            return Ok(());
        };
        let Some(text) = message.text else {
            return Ok(());
        };

        let reply = self.process_command(&text).await?;
        self.send_text(&message.chat.id.to_string(), &reply).await
    }

    async fn process_command(&self, text: &str) -> anyhow::Result<String> {
        let command = text.trim();
        if command.is_empty() {
            return Ok(self.help_message());
        }

        let parts = command.split_whitespace().collect::<Vec<_>>();
        let head = parts
            .first()
            .map(|item| item.split('@').next().unwrap_or(item))
            .unwrap_or("");

        match head {
            "/start" | "/help" => Ok(self.help_message()),
            "/report" | "/rank" => {
                let limit = parts
                    .get(1)
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(self.config.tg_default_report_limit);
                self.build_previous_day_report(limit).await
            }
            "/report_today" => {
                let limit = parts
                    .get(1)
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(self.config.tg_default_report_limit);
                self.build_today_report(limit).await
            }
            "/bid" => {
                let Some(bid) = parts.get(1) else {
                    return Ok("用法: /bid <bid>".to_string());
                };
                self.build_bid_detail_report(bid).await
            }
            "/watch" => self.handle_watch_command(&parts).await,
            "/watched" => self.build_watched_report().await,
            _ => Ok(format!("未识别命令: {head}\n\n{}", self.help_message())),
        }
    }

    async fn handle_watch_command(&self, parts: &[&str]) -> anyhow::Result<String> {
        let Some(action) = parts.get(1).copied() else {
            return Ok("用法: /watch add <bid> [note] | /watch remove <bid> | /watch list".into());
        };

        match action {
            "add" => {
                let Some(bid) = parts.get(2).copied() else {
                    return Ok("用法: /watch add <bid> [note]".into());
                };
                let note = if parts.len() > 3 {
                    Some(parts[3..].join(" "))
                } else {
                    None
                };
                self.service.add_watched_bid(bid, note.as_deref()).await?;
                Ok(format!("已加入监控 bid: {bid}"))
            }
            "remove" => {
                let Some(bid) = parts.get(2).copied() else {
                    return Ok("用法: /watch remove <bid>".into());
                };
                let removed = self.service.remove_watched_bid(bid).await?;
                if removed {
                    Ok(format!("已移除监控 bid: {bid}"))
                } else {
                    Ok(format!("监控列表里没有这个 bid: {bid}"))
                }
            }
            "list" => self.build_watch_list().await,
            _ => Ok("用法: /watch add <bid> [note] | /watch remove <bid> | /watch list".into()),
        }
    }

    async fn build_previous_day_report(&self, limit: u32) -> anyhow::Result<String> {
        let (from_ts, to_ts, label) = self.previous_day_window()?;
        self.build_report_text(from_ts, to_ts, &label, limit).await
    }

    async fn build_today_report(&self, limit: u32) -> anyhow::Result<String> {
        let (from_ts, to_ts, label) = self.today_window()?;
        self.build_report_text(from_ts, to_ts, &label, limit).await
    }

    async fn build_report_text(
        &self,
        from_ts: i64,
        to_ts: i64,
        label: &str,
        limit: u32,
    ) -> anyhow::Result<String> {
        let report = self
            .service
            .report_status_400_bids(from_ts, to_ts, limit)
            .await?;

        let mut lines = vec![
            format!("LogArk 每日 status=400 bid 报告"),
            format!("时间范围: {label}"),
            String::new(),
            format!("Top {} 排名:", limit),
        ];

        if report.ranking.is_empty() {
            lines.push("1. 没有 status=400 的 bid 调用".into());
        } else {
            for (index, item) in report.ranking.iter().enumerate() {
                lines.push(format!(
                    "{}. {} | 400次数={} | 总调用={} | task_id={} | api_key={} | 最近={} ",
                    index + 1,
                    item.bid,
                    item.status_400_calls,
                    item.total_calls,
                    item.distinct_task_ids,
                    item.distinct_api_keys,
                    self.format_ts(item.last_request_ts),
                ));
            }
        }

        lines.push(String::new());
        lines.push("监控 bid 摘要:".into());
        if report.watched.is_empty() {
            lines.push("当前监控列表在这个时间范围内没有 status=400 记录".into());
        } else {
            for item in &report.watched {
                lines.push(format!(
                    "- {} | 400次数={} | 总调用={} | 最近={}",
                    item.bid,
                    item.status_400_calls,
                    item.total_calls,
                    self.format_ts(item.last_request_ts),
                ));
            }
        }

        Ok(lines.join("\n"))
    }

    async fn build_bid_detail_report(&self, bid: &str) -> anyhow::Result<String> {
        let (from_ts, to_ts, label) = self.today_window()?;
        let Some(stat) = self
            .service
            .get_bid_status_400_stats(bid, from_ts, to_ts)
            .await?
        else {
            return Ok(format!(
                "bid: {bid}\n时间范围: {label}\n没有查到 status=400 记录"
            ));
        };

        Ok(format!(
            "bid 监控详情\n时间范围: {label}\nbid: {}\nstatus=400 次数: {}\n总调用次数: {}\n去重 task_id: {}\n去重 API Key: {}\n最近一次: {}",
            stat.bid,
            stat.status_400_calls,
            stat.total_calls,
            stat.distinct_task_ids,
            stat.distinct_api_keys,
            self.format_ts(stat.last_request_ts),
        ))
    }

    async fn build_watch_list(&self) -> anyhow::Result<String> {
        let items = self.service.list_watched_bids().await?;
        if items.is_empty() {
            return Ok("当前没有监控中的 bid".into());
        }

        let mut lines = vec!["当前监控 bid 列表:".to_string()];
        for (index, item) in items.iter().enumerate() {
            let suffix = item
                .note
                .as_deref()
                .map(|note| format!(" | note={note}"))
                .unwrap_or_default();
            lines.push(format!(
                "{}. {}{} | 添加于 {}",
                index + 1,
                item.bid,
                suffix,
                self.format_ts(item.created_ts),
            ));
        }
        Ok(lines.join("\n"))
    }

    async fn build_watched_report(&self) -> anyhow::Result<String> {
        let (from_ts, to_ts, label) = self.today_window()?;
        let report = self
            .service
            .report_status_400_bids(from_ts, to_ts, self.config.tg_default_report_limit)
            .await?;

        let mut lines = vec![
            "监控 bid 今日状态".to_string(),
            format!("时间范围: {label}"),
        ];

        if report.watched.is_empty() {
            lines.push("没有监控 bid 命中 status=400".into());
        } else {
            for item in report.watched {
                lines.push(format!(
                    "- {} | 400次数={} | 总调用={} | 最近={}",
                    item.bid,
                    item.status_400_calls,
                    item.total_calls,
                    self.format_ts(item.last_request_ts),
                ));
            }
        }

        Ok(lines.join("\n"))
    }

    async fn send_daily_report(&self) -> anyhow::Result<()> {
        let chat_id = self
            .config
            .tg_chat_id
            .as_deref()
            .context("missing TG_CHAT_ID for scheduled report")?;
        let text = self
            .build_previous_day_report(self.config.tg_default_report_limit)
            .await?;
        self.send_text(chat_id, &text).await?;
        info!("scheduled daily report sent");
        Ok(())
    }

    async fn fetch_updates(&self, offset: i64) -> anyhow::Result<Vec<TelegramUpdate>> {
        let response = self
            .client
            .get(format!("{}/getUpdates", self.base_url))
            .query(&[
                ("offset", offset.to_string()),
                (
                    "timeout",
                    self.config.tg_poll_interval_secs.max(5).to_string(),
                ),
            ])
            .send()
            .await?
            .error_for_status()?
            .json::<TelegramResponse<Vec<TelegramUpdate>>>()
            .await?;

        if !response.ok {
            bail!("telegram getUpdates returned ok=false");
        }

        Ok(response.result)
    }

    async fn send_text(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        for chunk in split_message(text, 3500) {
            let response = self
                .client
                .post(format!("{}/sendMessage", self.base_url))
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "text": chunk,
                }))
                .send()
                .await?
                .error_for_status()?
                .json::<TelegramResponse<serde_json::Value>>()
                .await?;

            if !response.ok {
                bail!("telegram sendMessage returned ok=false");
            }
        }

        Ok(())
    }

    fn previous_day_window(&self) -> anyhow::Result<(i64, i64, String)> {
        let now = Utc::now().with_timezone(&self.timezone);
        let today_start = self
            .timezone
            .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
            .single()
            .context("failed to build local day start")?;
        let yesterday_start = today_start - Duration::days(1);
        Ok((
            yesterday_start.timestamp_millis(),
            today_start.timestamp_millis() - 1,
            format!(
                "{} 00:00 ~ {} 23:59",
                yesterday_start.format("%Y-%m-%d"),
                yesterday_start.format("%Y-%m-%d"),
            ),
        ))
    }

    fn today_window(&self) -> anyhow::Result<(i64, i64, String)> {
        let now = Utc::now().with_timezone(&self.timezone);
        let today_start = self
            .timezone
            .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
            .single()
            .context("failed to build local day start")?;
        Ok((
            today_start.timestamp_millis(),
            now.timestamp_millis(),
            format!(
                "{} 00:00 ~ {}",
                today_start.format("%Y-%m-%d"),
                now.format("%Y-%m-%d %H:%M"),
            ),
        ))
    }

    fn next_report_after(&self, now: DateTime<Utc>) -> anyhow::Result<DateTime<Utc>> {
        let local_now = now.with_timezone(&self.timezone);
        let today_report = self
            .timezone
            .with_ymd_and_hms(
                local_now.year(),
                local_now.month(),
                local_now.day(),
                self.config.tg_report_hour.min(23),
                self.config.tg_report_minute.min(59),
                0,
            )
            .single()
            .context("failed to build report schedule")?;
        let next = if local_now < today_report {
            today_report
        } else {
            today_report + Duration::days(1)
        };
        Ok(next.with_timezone(&Utc))
    }

    fn format_ts(&self, ts: i64) -> String {
        match self.timezone.timestamp_millis_opt(ts).single() {
            Some(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            None => ts.to_string(),
        }
    }

    fn help_message(&self) -> String {
        [
            "LogArk TG Bot 指令:",
            "/report [N] - 查看前一天 status=400 的 bid 排行",
            "/report_today [N] - 查看今天到现在的 status=400 排行",
            "/bid <bid> - 查看某个 bid 今天的 status=400 统计",
            "/watch add <bid> [note] - 加入监控",
            "/watch remove <bid> - 移出监控",
            "/watch list - 查看监控列表",
            "/watched - 查看监控 bid 今天的异常摘要",
        ]
        .join("\n")
    }
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in text.lines() {
        let line_len = line.chars().count();
        let current_len = current.chars().count();
        if current_len > 0 && current_len + line_len + 1 > max_len {
            chunks.push(current);
            current = String::new();
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

#[derive(Debug, Deserialize)]
struct TelegramResponse<T> {
    ok: bool,
    result: T,
}

#[derive(Debug, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    text: Option<String>,
    chat: TelegramChat,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
}
