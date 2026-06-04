#!/usr/bin/env bash
set -e
curl -s http://127.0.0.1:7700/health | jq . || true
curl -s 'http://127.0.0.1:7700/api/dashboard?hours=24' | jq . || true
curl -s 'http://127.0.0.1:7700/api/records?hours=24&limit=5' | jq . || true
