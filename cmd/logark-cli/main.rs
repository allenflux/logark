use clap::{Parser, Subcommand};
use serde_json::json;

#[derive(Parser)]
#[command(name = "logark")]
#[command(about = "LogArk CLI")]
struct Cli {
    #[arg(long, default_value = "http://127.0.0.1:7700")]
    server: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Write {
        #[arg(long)]
        service: String,
        #[arg(long, default_value = "info")]
        level: String,
        #[arg(long)]
        message: String,
    },
    Query {
        #[arg(long)]
        service: Option<String>,
        #[arg(long)]
        level: Option<String>,
        #[arg(long)]
        q: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();

    match cli.command {
        Commands::Write {
            service,
            level,
            message,
        } => {
            let body = json!({
                "service": service,
                "env": "cli",
                "level": level,
                "message": message,
                "fields": {}
            });
            let res = client
                .post(format!("{}/api/v1/logs", cli.server))
                .json(&body)
                .send()
                .await?;
            println!("{}", res.text().await?);
        }
        Commands::Query {
            service,
            level,
            q,
            limit,
        } => {
            let mut req = client
                .get(format!("{}/api/v1/logs", cli.server))
                .query(&[("limit", limit.to_string())]);
            if let Some(v) = service {
                req = req.query(&[("service", v)]);
            }
            if let Some(v) = level {
                req = req.query(&[("level", v)]);
            }
            if let Some(v) = q {
                req = req.query(&[("q", v)]);
            }
            let res = req.send().await?;
            println!("{}", res.text().await?);
        }
    }
    Ok(())
}
