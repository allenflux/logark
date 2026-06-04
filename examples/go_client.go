package main

import (
  "bytes"
  "encoding/json"
  "net/http"
  "time"
)

func main() {
  body := map[string]any{
    "timestamp": time.Now().UTC().Format(time.RFC3339),
    "service": "go-demo",
    "env": "dev",
    "level": "info",
    "message": "hello from go service",
    "trace_id": "trace-001",
    "fields": map[string]any{"user_id": 123, "cost_ms": 88},
  }
  b, _ := json.Marshal(body)
  _, _ = http.Post("http://127.0.0.1:7700/api/v1/logs", "application/json", bytes.NewReader(b))
}
